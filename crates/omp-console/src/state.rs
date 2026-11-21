use std::sync::Arc;

use tokio::sync::Semaphore;

use crate::config::Config;
use crate::ompbin::{OmpProbe, now_ms};
use crate::sessions::RecentCache;
use crate::supervisor::Supervisor;

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub threads: Arc<Supervisor>,
    pub recent: Arc<RecentCache>,
    pub ws_slots: Arc<Semaphore>,
    pub started_at: u64,
}

impl AppState {
    pub fn new(cfg: Arc<Config>, omp: OmpProbe) -> Self {
        let recent = Arc::new(RecentCache::new(cfg.session_root.clone()));
        let threads = Arc::new(Supervisor::new(cfg.clone(), omp, recent.clone()));
        let slots = cfg.ws_slots;
        Self {
            cfg,
            threads,
            recent,
            ws_slots: Arc::new(Semaphore::new(slots)),
            started_at: now_ms(),
        }
    }

    /// Test state with a stub probe and a temp session root.
    pub fn for_test(cfg: Arc<Config>) -> Self {
        Self::new(cfg, OmpProbe::test_stub())
    }
}
