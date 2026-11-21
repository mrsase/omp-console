//! Access to the committed golden fixtures. Used by the protocol tests and by
//! the server's contract tests, so both replay the same bytes.

use std::fs;
use std::io;
use std::path::PathBuf;

use serde_json::value::RawValue;

pub const NAMES: &[&str] = &[
    "handshake",
    "stream",
    "dialogs",
    "resume",
    "unknown",
    "commands",
];

pub fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/fixtures")
}

pub fn path(name: &str) -> PathBuf {
    dir().join(format!("{name}.jsonl"))
}

/// One JSON object per line, blank lines skipped.
pub fn lines(name: &str) -> io::Result<Vec<String>> {
    let text = fs::read_to_string(path(name))?;
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect())
}

/// Fixture lines as raw JSON values, for callers that need borrowed bodies.
pub fn raw_lines(name: &str) -> io::Result<Vec<Box<RawValue>>> {
    lines(name)?
        .into_iter()
        .map(|line| {
            serde_json::from_str(&line)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
        })
        .collect()
}
