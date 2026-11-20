use std::fs::File;
use std::io::Read;
use std::path::Path;

use serde::Deserialize;

pub const HEADER_BYTES: usize = 16 * 1024;

/// The parts of an omp session file header the web console needs.
#[derive(Debug, Default, Clone)]
pub struct SessionHeader {
    pub id: Option<String>,
    pub cwd: Option<String>,
    pub title: Option<String>,
}

#[derive(Deserialize)]
struct TitleLine {
    title: Option<String>,
}

#[derive(Deserialize)]
struct SessionLine {
    id: Option<String>,
    cwd: Option<String>,
}

/// Reads the leading JSONL records of a session file. Header records are
/// written before any transcript data, so a bounded read is enough.
pub fn read(path: &Path) -> Option<SessionHeader> {
    let mut file = File::open(path).ok()?;
    let mut buf = vec![0u8; HEADER_BYTES];
    let n = file.read(&mut buf).ok()?;
    buf.truncate(n);
    let text = String::from_utf8_lossy(&buf);

    let mut header = SessionHeader::default();
    for line in text.lines().take(32) {
        if line.is_empty() {
            continue;
        }
        if header.title.is_none()
            && line.contains("\"type\":\"title\"")
            && let Ok(value) = serde_json::from_str::<TitleLine>(line)
        {
            header.title = value.title;
        }
        if line.contains("\"type\":\"session\"") {
            if let Ok(v) = serde_json::from_str::<SessionLine>(line) {
                header.id = v.id;
                header.cwd = v.cwd;
            }
            // Header records are contiguous; the session line terminates them.
            break;
        }
    }

    if header.id.is_none() && header.cwd.is_none() && header.title.is_none() {
        None
    } else {
        Some(header)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn parses_title_and_session_lines() {
        let path =
            std::env::temp_dir().join(format!("omp-web-session-test-{}.jsonl", std::process::id()));
        let mut f = File::create(&path).unwrap();
        f.write_all(br#"{"type":"title","v":1,"title":"Fix the bug","source":"user"}"#)
            .unwrap();
        f.write_all(b"\n").unwrap();
        f.write_all(
            br#"{"type":"session","version":3,"id":"abc","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/project"}"#,
        )
        .unwrap();
        f.write_all(b"\n").unwrap();
        f.write_all(br#"{"type":"model_change","id":"x"}"#).unwrap();
        f.write_all(b"\n").unwrap();
        drop(f);

        let header = read(&path).unwrap();
        assert_eq!(header.title.as_deref(), Some("Fix the bug"));
        assert_eq!(header.id.as_deref(), Some("abc"));
        assert_eq!(header.cwd.as_deref(), Some("/tmp/project"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn rejects_non_session_files() {
        let path = std::env::temp_dir().join(format!(
            "omp-web-session-test-bad-{}.jsonl",
            std::process::id()
        ));
        std::fs::write(&path, b"not json\n").unwrap();
        assert!(read(&path).is_none());
        let _ = std::fs::remove_file(path);
    }
}
