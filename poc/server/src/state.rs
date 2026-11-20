use std::sync::Arc;

use tokio::sync::Semaphore;

use crate::config::Config;
use crate::recent::RecentCache;
use crate::thread::ThreadRegistry;

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub threads: Arc<ThreadRegistry>,
    pub recent: Arc<RecentCache>,
    /// Bounds concurrent browser sockets; each holds a permit for its lifetime.
    pub ws_slots: Arc<Semaphore>,
}

impl AppState {
    pub fn new(cfg: Arc<Config>) -> Self {
        let threads = Arc::new(ThreadRegistry::new(cfg.clone()));
        let recent = Arc::new(RecentCache::new(cfg.session_root.clone()));
        Self {
            cfg,
            threads,
            recent,
            ws_slots: Arc::new(Semaphore::new(16)),
        }
    }
}
