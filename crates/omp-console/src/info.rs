use omp_protocol::frame::Ready;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolState {
    pub version: u8,
    pub delta: bool,
    pub event_filter: bool,
    pub degraded: Option<String>,
}

impl Default for ProtocolState {
    fn default() -> Self {
        Self {
            version: 1,
            delta: false,
            event_filter: false,
            degraded: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadInfo {
    pub id: String,
    pub cwd: String,
    pub status: String,
    pub pid: u32,
    pub created_at: u64,
    pub last_activity: u64,
    pub exit_code: Option<i32>,
    pub resume: Option<String>,
    pub title: String,
    pub model: Option<String>,
    pub model_name: Option<String>,
    pub session_name: Option<String>,
    pub session_file: Option<String>,
    pub session_id: Option<String>,
    pub thinking: Option<String>,
    pub ready: Option<Ready>,
    pub protocol: ProtocolState,
    pub unknown_frames: u64,
    pub unknown_kinds: Vec<String>,
}
