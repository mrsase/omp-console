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
    pub symlink: bool,
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
    if trimmed.is_empty() || trimmed == "~" {
        return cfg.home.clone();
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        return cfg.home.join(rest);
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        cfg.server_cwd.join(path)
    }
}

/// Read-only folder listing. Following symlinks is intentional (a linked
/// workspace is a workspace); the canonical path is what is returned.
pub fn listing(path: &Path) -> Result<FsListing, ApiError> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| ApiError::NotFound(format!("{}: {error}", path.display())))?;
    let meta = std::fs::metadata(&canonical)
        .map_err(|error| ApiError::BadRequest(format!("{}: {error}", canonical.display())))?;
    if !meta.is_dir() {
        return Err(ApiError::BadRequest(format!(
            "{} is not a directory",
            canonical.display()
        )));
    }

    let mut entries = Vec::new();
    let read = std::fs::read_dir(&canonical)
        .map_err(|error| ApiError::BadRequest(format!("{}: {error}", canonical.display())))?;
    for entry in read.flatten().take(2000) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let entry_path = entry.path();
        let link_meta = std::fs::symlink_metadata(&entry_path);
        let symlink = link_meta
            .as_ref()
            .is_ok_and(|meta| meta.file_type().is_symlink());
        // metadata() follows the link; a broken link is shown as a file.
        let is_dir = std::fs::metadata(&entry_path)
            .map(|meta| meta.is_dir())
            .unwrap_or(false);
        entries.push(FsEntry {
            name,
            path: entry_path.display().to_string(),
            is_dir,
            symlink,
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    let parent = canonical
        .parent()
        .filter(|parent| *parent != canonical)
        .map(|parent| parent.display().to_string());

    Ok(FsListing {
        path: canonical.display().to_string(),
        parent,
        entries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_home_and_relative_paths() {
        let cfg = Config::for_test(std::env::temp_dir());
        assert_eq!(expand("~", &cfg), cfg.home);
        assert_eq!(expand("~/x", &cfg), cfg.home.join("x"));
        assert_eq!(expand("/tmp", &cfg), PathBuf::from("/tmp"));
    }

    #[test]
    fn follows_directory_symlinks() {
        let dir = std::env::temp_dir().join(format!("omp-console-fs-{}", std::process::id()));
        let real = dir.join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("file.txt"), "x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, dir.join("link")).unwrap();
        let listing = listing(&dir).unwrap();
        #[cfg(unix)]
        {
            let link = listing
                .entries
                .iter()
                .find(|entry| entry.name == "link")
                .unwrap();
            assert!(link.is_dir);
            assert!(link.symlink);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
