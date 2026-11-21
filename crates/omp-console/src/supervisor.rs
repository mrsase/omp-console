use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use tokio::sync::broadcast;

use crate::config::Config;
use crate::error::ApiError;
use crate::fsbrowse;
use crate::ompbin::OmpProbe;
use crate::ring::FrameRing;
use crate::sessions::{self, RecentCache};
use crate::thread::{CreateParams, LifecycleEvent, RpcThread, SpawnParams};

const FRAME_RING_FRAMES: usize = 256;
const FRAME_RING_BYTES: usize = 8 * 1024 * 1024;
const THINKING_LEVELS: &[&str] = &[
    "inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max", "auto",
];

pub struct Supervisor {
    threads: RwLock<HashMap<String, Arc<RpcThread>>>,
    lifecycle: broadcast::Sender<LifecycleEvent>,
    cfg: Arc<Config>,
    recent: Arc<RecentCache>,
    omp: OmpProbe,
    create_lock: tokio::sync::Mutex<()>,
}

impl Supervisor {
    pub fn new(cfg: Arc<Config>, omp: OmpProbe, recent: Arc<RecentCache>) -> Self {
        let (lifecycle, _) = broadcast::channel(256);
        Self {
            threads: RwLock::new(HashMap::new()),
            lifecycle,
            cfg,
            recent,
            omp,
            create_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<LifecycleEvent> {
        self.lifecycle.subscribe()
    }

    pub fn get(&self, id: &str) -> Option<Arc<RpcThread>> {
        self.threads.read().expect("threads").get(id).cloned()
    }

    pub fn list(&self) -> Vec<crate::thread::ThreadInfo> {
        let mut threads: Vec<Arc<RpcThread>> = self
            .threads
            .read()
            .expect("threads")
            .values()
            .cloned()
            .collect();
        threads.sort_by_key(|thread| std::cmp::Reverse(thread.created_at));
        threads.iter().map(|thread| thread.info()).collect()
    }

    pub fn omp(&self) -> &OmpProbe {
        &self.omp
    }

    pub async fn create(&self, params: CreateParams) -> Result<Arc<RpcThread>, ApiError> {
        self.omp
            .check(self.cfg.skip_version_check)
            .map_err(ApiError::Conflict)?;
        let _guard = self.create_lock.lock().await;

        let running = self
            .threads
            .read()
            .expect("threads")
            .values()
            .filter(|thread| !thread.has_exited())
            .count();
        if running >= self.cfg.max_threads {
            return Err(ApiError::TooMany(format!(
                "at most {} concurrent omp sessions",
                self.cfg.max_threads
            )));
        }

        let resume = params
            .resume
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        let resume_path = match &resume {
            Some(raw) => Some(resolve_resume(raw, &self.cfg)?),
            None => None,
        };

        let requested_cwd = params
            .cwd
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        let cwd = match requested_cwd {
            Some(raw) => fsbrowse::expand(&raw, &self.cfg),
            None => match &resume_path {
                Some(path) => {
                    let header = sessions::read_header(path).ok_or_else(|| {
                        ApiError::BadRequest("cannot read the session header".into())
                    })?;
                    header.cwd.map(PathBuf::from).ok_or_else(|| {
                        ApiError::BadRequest("the session has no working directory".into())
                    })?
                }
                None => self.cfg.server_cwd.clone(),
            },
        };
        let cwd = std::fs::canonicalize(&cwd)
            .map_err(|error| ApiError::BadRequest(format!("{}: {error}", cwd.display())))?;
        if !cwd.is_dir() {
            return Err(ApiError::BadRequest(format!(
                "{} is not a directory",
                cwd.display()
            )));
        }

        let model = params
            .model
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        if let Some(model) = &model {
            let mut parts = model.splitn(2, '/');
            let provider = parts.next().unwrap_or_default();
            let id = parts.next().unwrap_or_default();
            if provider.is_empty()
                || id.is_empty()
                || model.chars().any(char::is_whitespace)
                || model.chars().any(char::is_control)
            {
                return Err(ApiError::BadRequest(
                    "model must be provider/modelId".into(),
                ));
            }
        }
        let thinking = params
            .thinking
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        if let Some(level) = &thinking
            && !THINKING_LEVELS.contains(&level.as_str())
        {
            return Err(ApiError::BadRequest(format!(
                "unknown thinking level: {level}"
            )));
        }

        let thread = RpcThread::spawn(
            &self.cfg,
            self.lifecycle.clone(),
            Arc::new(FrameRing::new(FRAME_RING_FRAMES, FRAME_RING_BYTES)),
            SpawnParams {
                cwd,
                resume: resume_path.map(|path| path.display().to_string()),
                model,
                thinking,
            },
        )
        .await?;
        self.threads
            .write()
            .expect("threads")
            .insert(thread.id.clone(), thread.clone());
        thread.publish();
        Ok(thread)
    }

    pub async fn remove(&self, id: &str) -> Result<(), ApiError> {
        let thread = self
            .threads
            .write()
            .expect("threads")
            .remove(id)
            .ok_or_else(|| ApiError::NotFound(format!("no session {id}")))?;
        thread.stop(Duration::from_millis(1500)).await;
        thread.close();
        self.recent.invalidate();
        let _ = self.lifecycle.send(LifecycleEvent::Removed(id.to_owned()));
        Ok(())
    }

    pub async fn stop_all(&self) {
        let threads: Vec<Arc<RpcThread>> = self
            .threads
            .read()
            .expect("threads")
            .values()
            .cloned()
            .collect();
        let mut set = tokio::task::JoinSet::new();
        for thread in threads {
            set.spawn(async move {
                thread.stop(Duration::from_millis(1500)).await;
                thread.close();
            });
        }
        let drain = async { while set.join_next().await.is_some() {} };
        if tokio::time::timeout(Duration::from_secs(5), drain)
            .await
            .is_err()
        {
            tracing::warn!("shutdown deadline reached; some children were left to the OS");
        }
    }

    /// Drop exited sessions that nobody has touched for `max_age`.
    pub fn prune_exited(&self, max_age: Duration) {
        let cutoff = crate::ompbin::now_ms().saturating_sub(max_age.as_millis() as u64);
        let ids: Vec<String> = self
            .threads
            .read()
            .expect("threads")
            .iter()
            .filter(|(_, thread)| thread.has_exited() && thread.info().last_activity < cutoff)
            .map(|(id, _)| id.clone())
            .collect();
        if ids.is_empty() {
            return;
        }
        let mut threads = self.threads.write().expect("threads");
        for id in ids {
            if let Some(thread) = threads.remove(&id) {
                thread.close();
                let _ = self.lifecycle.send(LifecycleEvent::Removed(id));
            }
        }
    }
}

/// A resume path must be a regular `.jsonl` file under the canonical session
/// root. A symlink is resolved first, so a link that escapes the root fails.
pub(crate) fn resolve_resume(raw: &str, cfg: &Config) -> Result<PathBuf, ApiError> {
    let path = fsbrowse::expand(raw, cfg);
    let canonical = std::fs::canonicalize(&path)
        .map_err(|_| ApiError::BadRequest("session file not found".into()))?;
    let root = std::fs::canonicalize(&cfg.session_root).map_err(|_| {
        ApiError::BadRequest(format!(
            "session root {} does not exist",
            cfg.session_root.display()
        ))
    })?;
    if !canonical.starts_with(&root) {
        return Err(ApiError::BadRequest(
            "resume file must be under the session root".into(),
        ));
    }
    if canonical
        .extension()
        .and_then(|extension| extension.to_str())
        != Some("jsonl")
    {
        return Err(ApiError::BadRequest(
            "resume file must be a .jsonl session".into(),
        ));
    }
    if !canonical.is_file() {
        return Err(ApiError::BadRequest("resume path is not a file".into()));
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::Path;

    fn cfg(root: &Path) -> Config {
        let mut cfg = Config::for_test(root.to_path_buf());
        cfg.session_root = root.to_path_buf();
        cfg
    }

    #[test]
    fn resume_is_confined_to_jsonl_files_under_the_root() {
        let root = std::env::temp_dir().join(format!("omp-console-resume-{}", std::process::id()));
        let project = root.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let good = project.join("s.jsonl");
        let mut file = std::fs::File::create(&good).unwrap();
        file.write_all(b"{\"type\":\"session\",\"id\":\"x\",\"cwd\":\"/tmp\"}\n")
            .unwrap();
        drop(file);
        let dir = project.join("dir.jsonl");
        std::fs::create_dir(&dir).unwrap();
        let outside = root
            .parent()
            .unwrap()
            .join(format!("omp-console-outside-{}.jsonl", std::process::id()));
        std::fs::write(&outside, b"{}").unwrap();

        let cfg = cfg(&root);
        assert_eq!(
            resolve_resume(good.to_str().unwrap(), &cfg).unwrap(),
            std::fs::canonicalize(&good).unwrap()
        );
        assert!(resolve_resume(dir.to_str().unwrap(), &cfg).is_err());
        assert!(resolve_resume(outside.to_str().unwrap(), &cfg).is_err());
        assert!(resolve_resume("../nope.jsonl", &cfg).is_err());
        std::fs::remove_file(outside).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
