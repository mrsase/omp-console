use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::config::Config;
use crate::error::ApiError;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<FsEntry>,
}

pub fn expand(path: &str, cfg: &Config) -> PathBuf {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return cfg.home.clone();
    }
    if trimmed == "~" {
        return cfg.home.clone();
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        return cfg.home.join(rest);
    }
    let p = Path::new(trimmed);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        cfg.server_cwd.join(p)
    }
}

pub fn listing(path: &Path) -> Result<FsListing, ApiError> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| ApiError::NotFound(format!("{}: {e}", path.display())))?;
    let meta = std::fs::metadata(&canonical)
        .map_err(|e| ApiError::BadRequest(format!("{}: {e}", canonical.display())))?;
    if !meta.is_dir() {
        return Err(ApiError::BadRequest(format!(
            "{} is not a directory",
            canonical.display()
        )));
    }

    let mut entries = Vec::new();
    let read = std::fs::read_dir(&canonical)
        .map_err(|e| ApiError::BadRequest(format!("{}: {e}", canonical.display())))?;
    for entry in read.flatten().take(2000) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let entry_path = entry.path();
        // Follow symlinks so linked workspaces appear as directories.
        let is_dir = entry
            .file_type()
            .map(|t| t.is_dir())
            .unwrap_or_else(|_| entry_path.is_dir());
        entries.push(FsEntry {
            name,
            path: entry_path.display().to_string(),
            is_dir,
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    let parent = canonical
        .parent()
        .filter(|p| p != &canonical)
        .map(|p| p.display().to_string());

    Ok(FsListing {
        path: canonical.display().to_string(),
        parent,
        entries,
    })
}
