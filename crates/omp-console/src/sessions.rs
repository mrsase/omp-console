use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

const HEADER_BYTES: u64 = 64 * 1024;
const HEADER_LINES: usize = 32;
const CACHE_TTL: Duration = Duration::from_secs(10);
const SCAN_LIMIT: usize = 240;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SessionHeader {
    pub id: Option<String>,
    pub cwd: Option<String>,
    pub title: Option<String>,
}

/// Read the leading records line by line, bounded in bytes and lines. Unlike
/// the PoC's single 16 KiB read, a long first line cannot hide the session
/// record, and key order does not matter.
pub fn read_header(path: &Path) -> Option<SessionHeader> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file.take(HEADER_BYTES));
    let mut header = SessionHeader::default();
    let mut line = String::new();
    for _ in 0..HEADER_LINES {
        line.clear();
        let read = reader.read_line(&mut line).ok()?;
        if read == 0 {
            break;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        match value.get("type").and_then(|kind| kind.as_str()) {
            Some("title") if header.title.is_none() => {
                header.title = value
                    .get("title")
                    .and_then(|title| title.as_str())
                    .map(str::to_owned);
            }
            Some("session") => {
                header.id = value
                    .get("id")
                    .and_then(|id| id.as_str())
                    .map(str::to_owned);
                header.cwd = value
                    .get("cwd")
                    .and_then(|cwd| cwd.as_str())
                    .map(str::to_owned);
            }
            _ => {}
        }
    }
    if header.id.is_none() && header.cwd.is_none() && header.title.is_none() {
        None
    } else {
        Some(header)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentSession {
    pub path: String,
    pub id: Option<String>,
    pub title: String,
    pub cwd: String,
    pub updated_at: u64,
}

pub struct RecentCache {
    root: PathBuf,
    cache: Mutex<(Instant, Arc<Vec<RecentSession>>)>,
    refresh: tokio::sync::Mutex<()>,
}

impl RecentCache {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            cache: Mutex::new((Instant::now() - CACHE_TTL, Arc::new(Vec::new()))),
            refresh: tokio::sync::Mutex::new(()),
        }
    }

    /// Force the next [`list`] to scan, so a close or rename is visible now.
    pub fn invalidate(&self) {
        *self.cache.lock().expect("recent cache") =
            (Instant::now() - CACHE_TTL, Arc::new(Vec::new()));
    }

    pub async fn list(&self) -> Arc<Vec<RecentSession>> {
        {
            let guard = self.cache.lock().expect("recent cache");
            if guard.0.elapsed() < CACHE_TTL {
                return guard.1.clone();
            }
        }
        let _refresh = self.refresh.lock().await;
        {
            let guard = self.cache.lock().expect("recent cache");
            if guard.0.elapsed() < CACHE_TTL {
                return guard.1.clone();
            }
        }
        let root = self.root.clone();
        let scanned = tokio::task::spawn_blocking(move || scan(&root))
            .await
            .unwrap_or_default();
        let shared = Arc::new(scanned);
        *self.cache.lock().expect("recent cache") = (Instant::now(), shared.clone());
        shared
    }
}

fn scan(root: &Path) -> Vec<RecentSession> {
    let mut files: Vec<(SystemTime, PathBuf)> = Vec::new();
    let Ok(projects) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    for project in projects.flatten() {
        let Ok(kind) = project.file_type() else {
            continue;
        };
        if !kind.is_dir() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(project.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') || !name.ends_with(".jsonl") {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            files.push((meta.modified().unwrap_or(UNIX_EPOCH), entry.path()));
        }
    }
    files.sort_unstable_by_key(|entry| std::cmp::Reverse(entry.0));
    files.truncate(SCAN_LIMIT);

    let mut out = Vec::with_capacity(files.len().min(64));
    for (modified, path) in files {
        let Some(header) = read_header(&path) else {
            continue;
        };
        let Some(cwd) = header.cwd else {
            continue;
        };
        let title = header
            .title
            .filter(|title| !title.trim().is_empty())
            .map(|title| clean_title(&title))
            .unwrap_or_else(|| match header.id.as_deref() {
                Some(id) if id.len() >= 12 => format!("Untitled · {}", &id[..12]),
                _ => "Untitled session".into(),
            });
        out.push(RecentSession {
            path: path.display().to_string(),
            id: header.id,
            title,
            cwd,
            updated_at: modified
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0),
        });
    }
    out
}

fn clean_title(title: &str) -> String {
    let clean: String = title
        .chars()
        .filter(|c| !c.is_control() || *c == '\t')
        .take(200)
        .collect();
    let clean = clean.trim();
    if clean.is_empty() {
        "Untitled session".into()
    } else {
        clean.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_session(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        let mut file = File::create(&path).unwrap();
        file.write_all(body.as_bytes()).unwrap();
        path
    }

    #[test]
    fn reads_title_and_session_in_any_order() {
        let dir = std::env::temp_dir().join(format!("omp-console-header-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = write_session(
            &dir,
            "a.jsonl",
            "{\"type\":\"session\",\"id\":\"abc\",\"cwd\":\"/work\"}\n{\"type\":\"title\",\"title\":\"Fix the bug\"}\n",
        );
        let header = read_header(&path).unwrap();
        assert_eq!(header.id.as_deref(), Some("abc"));
        assert_eq!(header.cwd.as_deref(), Some("/work"));
        assert_eq!(header.title.as_deref(), Some("Fix the bug"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn tolerates_a_long_first_line_and_rejects_non_sessions() {
        let dir = std::env::temp_dir().join(format!("omp-console-header2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut body = format!("{{\"type\":\"noise\",\"pad\":\"{}\"}}\n", "x".repeat(1000));
        body.push_str("{\"type\":\"session\",\"id\":\"abc\",\"cwd\":\"/work\"}\n");
        let path = write_session(&dir, "b.jsonl", &body);
        assert!(read_header(&path).is_some());

        let bad = write_session(&dir, "c.jsonl", "not json\n");
        assert!(read_header(&bad).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
