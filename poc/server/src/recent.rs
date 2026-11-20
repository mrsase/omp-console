use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::Serialize;

use crate::session;

const CACHE_TTL: Duration = Duration::from_secs(10);
const SCAN_LIMIT: usize = 240;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentSession {
    pub path: String,
    pub id: Option<String>,
    pub title: String,
    pub cwd: String,
    pub updated_at: u64,
}

/// Short-lived cache over the omp session directory. The directory is small,
/// but rescanning it on every sidebar poll would be pointless I/O.
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

    pub async fn list(&self) -> Arc<Vec<RecentSession>> {
        {
            let guard = self.cache.lock();
            if guard.0.elapsed() < CACHE_TTL {
                return guard.1.clone();
            }
        }

        // Single-flight: a burst of requests during expiry scans once.
        let _refresh = self.refresh.lock().await;
        {
            let guard = self.cache.lock();
            if guard.0.elapsed() < CACHE_TTL {
                return guard.1.clone();
            }
        }

        let root = self.root.clone();
        let scanned = tokio::task::spawn_blocking(move || scan(&root))
            .await
            .unwrap_or_default();
        let shared = Arc::new(scanned);
        *self.cache.lock() = (Instant::now(), shared.clone());
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
            let modified = meta.modified().unwrap_or(UNIX_EPOCH);
            files.push((modified, entry.path()));
        }
    }

    files.sort_unstable_by_key(|entry| std::cmp::Reverse(entry.0));
    files.truncate(SCAN_LIMIT);

    let mut out = Vec::with_capacity(files.len().min(64));
    for (modified, path) in files {
        let Some(header) = session::read(&path) else {
            continue;
        };
        let Some(cwd) = header.cwd else {
            continue;
        };
        let title = header
            .title
            .filter(|t| !t.trim().is_empty())
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
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        });
    }
    out
}
