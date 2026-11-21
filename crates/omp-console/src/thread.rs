use std::collections::{BTreeSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU8, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use bytes::Bytes;
use omp_protocol::dialog::{self, Method};
use omp_protocol::frame::{self, Class, Ready, ResponseMeta};
use omp_protocol::limits;
use tokio::sync::{broadcast, mpsc};
use uuid::Uuid;

use crate::child;
use crate::config::Config;
use crate::dialogs::Dialogs;
use crate::error::ApiError;
use crate::messages::{frame_envelope, json_string, notice_envelope};
use crate::meta;
use crate::ompbin::now_ms;

const STATUS_STARTING: u8 = 0;
const STATUS_READY: u8 = 1;
const STATUS_EXITED: u8 = 2;
const CMD_CHANNEL: usize = 128;
const STDERR_RING: usize = 240;
const STDERR_LINE_CHARS: usize = 2000;
const STDERR_TOTAL_CHARS: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub enum LifecycleEvent {
    Upsert(Arc<ThreadInfo>),
    Removed(String),
}

pub use crate::info::{ProtocolState, ThreadInfo};

#[derive(Debug, Clone, Default)]
pub struct CreateParams {
    pub cwd: Option<String>,
    pub resume: Option<String>,
    pub model: Option<String>,
    pub thinking: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SpawnParams {
    pub cwd: PathBuf,
    pub resume: Option<String>,
    pub model: Option<String>,
    pub thinking: Option<String>,
}

pub struct RpcThread {
    pub id: String,
    pub cwd: PathBuf,
    pub created_at: u64,
    pub pid: u32,
    resume: Option<String>,
    ring: Arc<crate::ring::FrameRing>,
    lifecycle: broadcast::Sender<LifecycleEvent>,
    cmd_tx: Mutex<Option<mpsc::Sender<Bytes>>>,
    status: AtomicU8,
    exit_code: AtomicI32,
    last_activity: AtomicU64,
    removed: AtomicBool,
    ready: RwLock<Option<Ready>>,
    protocol: RwLock<ProtocolState>,
    meta: RwLock<meta::Meta>,
    dialogs: RwLock<Dialogs>,
    stderr: Mutex<VecDeque<String>>,
    unknown_frames: AtomicU64,
    unknown_kinds: RwLock<BTreeSet<String>>,
    stop_lock: tokio::sync::Mutex<()>,
}

impl RpcThread {
    pub async fn spawn(
        cfg: &Config,
        lifecycle: broadcast::Sender<LifecycleEvent>,
        ring: Arc<crate::ring::FrameRing>,
        params: SpawnParams,
    ) -> Result<Arc<Self>, ApiError> {
        let spawned = child::spawn(
            cfg,
            &params.cwd,
            params.resume.as_deref(),
            params.model.as_deref(),
            params.thinking.as_deref(),
        )
        .await?;
        let (cmd_tx, cmd_rx) = mpsc::channel(CMD_CHANNEL);
        let thread = Arc::new(Self {
            id: Uuid::new_v4().to_string(),
            cwd: params.cwd,
            created_at: now_ms(),
            pid: spawned.pid,
            resume: params.resume,
            ring,
            lifecycle,
            cmd_tx: Mutex::new(Some(cmd_tx)),
            status: AtomicU8::new(STATUS_STARTING),
            exit_code: AtomicI32::new(i32::MIN),
            last_activity: AtomicU64::new(now_ms()),
            removed: AtomicBool::new(false),
            ready: RwLock::new(None),
            protocol: RwLock::new(ProtocolState::default()),
            meta: RwLock::new(meta::Meta::default()),
            dialogs: RwLock::new(Dialogs::default()),
            stderr: Mutex::new(VecDeque::new()),
            unknown_frames: AtomicU64::new(0),
            unknown_kinds: RwLock::new(BTreeSet::new()),
            stop_lock: tokio::sync::Mutex::new(()),
        });
        tokio::spawn(child::writer_loop(spawned.stdin, cmd_rx));
        tokio::spawn(child::reader_loop(thread.clone(), spawned.stdout));
        tokio::spawn(child::stderr_loop(thread.clone(), spawned.stderr));
        tokio::spawn(child::waiter(thread.clone(), spawned.child));
        Ok(thread)
    }

    pub fn info(&self) -> ThreadInfo {
        let meta = self.meta.read().expect("meta");
        let ready = self.ready.read().expect("ready").clone();
        let exit = self.exit_code.load(Ordering::Acquire);
        let title = meta
            .session_name
            .clone()
            .or_else(|| {
                self.cwd
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
            })
            .unwrap_or_else(|| self.id.chars().take(8).collect());
        ThreadInfo {
            id: self.id.clone(),
            cwd: self.cwd.display().to_string(),
            status: match self.status.load(Ordering::Acquire) {
                STATUS_READY => "ready",
                STATUS_EXITED => "exited",
                _ => "starting",
            }
            .into(),
            pid: self.pid,
            created_at: self.created_at,
            last_activity: self.last_activity.load(Ordering::Relaxed),
            exit_code: (exit != i32::MIN).then_some(exit),
            resume: self.resume.clone(),
            title,
            model: meta.model.clone(),
            model_name: meta.model_name.clone(),
            session_name: meta.session_name.clone(),
            session_file: meta.session_file.clone(),
            session_id: meta.session_id.clone(),
            thinking: meta.thinking.clone(),
            ready,
            protocol: self.protocol.read().expect("protocol").clone(),
            unknown_frames: self.unknown_frames.load(Ordering::Relaxed),
            unknown_kinds: self
                .unknown_kinds
                .read()
                .expect("unknown kinds")
                .iter()
                .cloned()
                .collect(),
        }
    }

    pub fn ring(&self) -> Arc<crate::ring::FrameRing> {
        self.ring.clone()
    }

    pub fn pending_dialogs(&self) -> Vec<Arc<Bytes>> {
        self.dialogs.read().expect("dialogs").snapshot()
    }

    pub fn touch(&self) {
        self.last_activity.store(now_ms(), Ordering::Relaxed);
    }

    pub fn line_limit(&self) -> usize {
        limits::max_line_bytes(
            self.ready
                .read()
                .expect("ready")
                .as_ref()
                .map(|ready| ready.max_frame_bytes),
        )
    }

    pub fn reassembled_limit(&self) -> usize {
        limits::max_reassembled_bytes(
            self.ready
                .read()
                .expect("ready")
                .as_ref()
                .map(|ready| ready.max_reassembled_frame_bytes),
        )
    }

    pub fn has_exited(&self) -> bool {
        self.status.load(Ordering::Acquire) == STATUS_EXITED
    }

    pub fn stderr_lines(&self) -> Vec<String> {
        self.stderr
            .lock()
            .expect("stderr")
            .iter()
            .cloned()
            .collect()
    }

    pub fn push_stderr(&self, line: &[u8]) {
        let mut text = String::from_utf8_lossy(line).into_owned();
        if text.chars().nth(STDERR_LINE_CHARS).is_some() {
            text = format!(
                "{}…",
                text.chars().take(STDERR_LINE_CHARS).collect::<String>()
            );
        }
        let mut ring = self.stderr.lock().expect("stderr");
        if ring.len() == STDERR_RING {
            ring.pop_front();
        }
        ring.push_back(text);
        let mut total: usize = ring.iter().map(String::len).sum();
        while total > STDERR_TOTAL_CHARS && ring.len() > 1 {
            if let Some(old) = ring.pop_front() {
                total = total.saturating_sub(old.len());
            }
        }
    }

    pub async fn send_frame(&self, frame: Bytes) -> bool {
        let sender = self.cmd_tx.lock().expect("cmd").clone();
        match sender {
            Some(sender) => tokio::time::timeout(Duration::from_secs(1), sender.send(frame))
                .await
                .is_ok_and(|result| result.is_ok()),
            None => false,
        }
    }

    async fn send_internal(&self, frame: &'static [u8]) {
        self.send_frame(Bytes::from_static(frame)).await;
    }

    fn try_send_static(&self, frame: &'static [u8]) {
        if let Some(sender) = self.cmd_tx.lock().expect("cmd").as_ref() {
            let _ = sender.try_send(Bytes::from_static(frame));
        }
    }

    pub fn request_stop(&self) {
        self.try_send_static(b"{\"type\":\"abort\"}");
        self.cmd_tx.lock().expect("cmd").take();
    }

    pub async fn stop(&self, grace: Duration) {
        let _guard = self.stop_lock.lock().await;
        if self.has_exited() {
            self.cmd_tx.lock().expect("cmd").take();
            return;
        }
        self.request_stop();
        let deadline = tokio::time::Instant::now() + grace;
        while !self.has_exited() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        // The child may have exited while a tool grandchild kept running, so
        // the group is checked independently of `has_exited`.
        if child::group_alive(self.pid) {
            child::signal_group(self.pid, child::SIGTERM);
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        if child::group_alive(self.pid) {
            child::signal_group(self.pid, child::SIGKILL);
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        while !self.has_exited() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        if !self.has_exited() {
            self.mark_exited(None);
        }
    }

    pub fn close(&self) {
        self.removed.store(true, Ordering::Release);
        self.ring.close();
    }

    pub(crate) fn publish(&self) {
        if self.removed.load(Ordering::Acquire) {
            return;
        }
        let _ = self
            .lifecycle
            .send(LifecycleEvent::Upsert(Arc::new(self.info())));
    }

    pub(crate) fn mark_exited(&self, code: Option<i32>) {
        let previous = self.status.swap(STATUS_EXITED, Ordering::AcqRel);
        if let Some(code) = code {
            self.exit_code.store(code, Ordering::Release);
        }
        self.cmd_tx.lock().expect("cmd").take();
        self.dialogs.write().expect("dialogs").clear();
        if previous != STATUS_EXITED {
            self.publish();
        }
    }

    pub fn notice(&self, level: &str, message: &str) {
        let envelope = notice_envelope(&self.id, level, message);
        self.ring.push(envelope);
    }

    fn push_raw(&self, raw: &str) {
        self.ring.push(frame_envelope(&self.id, raw));
    }

    pub(crate) async fn handle_frame(&self, bytes: &[u8]) {
        let Ok(text) = std::str::from_utf8(bytes) else {
            self.notice("error", "dropped a non-UTF-8 omp frame");
            return;
        };
        let parsed = match frame::parse(text) {
            Ok(frame) => frame,
            Err(error) => {
                self.notice("error", &format!("protocol: {error}"));
                return;
            }
        };

        match parsed.class {
            Class::Ready => {
                let ready = parsed.ready();
                let raw = parsed.raw_str();
                if ready.is_none() {
                    self.notice("error", "invalid ready frame");
                    return;
                }
                self.on_ready(ready, raw).await;
            }
            Class::Response => {
                let meta = parsed.response();
                let raw = parsed.raw_str();
                let id = parsed.id;
                self.on_response(meta, raw, id).await;
            }
            Class::UiRequest => {
                let raw = parsed.raw_str();
                self.on_ui_request(raw);
            }
            Class::Unknown => {
                let kind = parsed.kind.to_string();
                let raw = parsed.raw_str();
                self.unknown_frames.fetch_add(1, Ordering::Relaxed);
                let new_kind = self
                    .unknown_kinds
                    .write()
                    .expect("unknown kinds")
                    .insert(kind.clone());
                self.push_raw(raw);
                if new_kind {
                    self.notice(
                        "warning",
                        &format!("unknown omp frame `{kind}`; kept as protocol evidence"),
                    );
                    self.publish();
                }
            }
            _ => {
                let raw = parsed.raw_str();
                let kind = parsed.kind;
                let refresh = self.apply_event_metadata(kind, raw);
                self.push_raw(raw);
                if refresh {
                    self.send_internal(b"{\"id\":\"_omp_state\",\"type\":\"get_state\"}")
                        .await;
                }
            }
        }
    }

    async fn on_ready(&self, ready: Option<Ready>, raw: &str) {
        let Some(ready) = ready else { return };
        *self.ready.write().expect("ready") = Some(ready.clone());
        {
            let mut protocol = self.protocol.write().expect("protocol");
            protocol.version = ready.protocol_version.min(2) as u8;
        }
        self.status.store(STATUS_READY, Ordering::Release);
        self.push_raw(raw);
        self.publish();

        if ready.supports_v2() {
            self.send_internal(
                b"{\"id\":\"_omp_neg\",\"type\":\"negotiate_protocol\",\"protocolVersion\":2}",
            )
            .await;
        }
        self.send_internal(
            b"{\"id\":\"_omp_filter\",\"type\":\"set_event_filter\",\"events\":null,\"messageUpdates\":\"delta\"}",
        )
        .await;
        self.send_internal(b"{\"id\":\"_omp_ask\",\"type\":\"set_ask_dialog\",\"enabled\":true}")
            .await;
        self.send_internal(b"{\"id\":\"_omp_state\",\"type\":\"get_state\"}")
            .await;
        self.send_internal(b"{\"id\":\"_omp_stats\",\"type\":\"get_session_stats\"}")
            .await;
    }

    async fn on_response(&self, meta: Option<ResponseMeta>, raw: &str, id: Option<&str>) {
        let Some(meta) = meta else { return };
        if meta.command.is_empty() {
            return;
        }
        if id.is_some_and(|id| id.starts_with("_omp_")) {
            self.on_internal(&meta, raw).await;
            return;
        }
        if meta.success && matches!(meta.command.as_str(), "get_state" | "get_session_stats") {
            self.apply_meta_response(&meta.command, raw);
        }
        self.push_raw(raw);
    }

    async fn on_internal(&self, meta: &ResponseMeta, raw: &str) {
        let value: serde_json::Value = serde_json::from_str(raw).unwrap_or_default();
        let id = value
            .get("id")
            .and_then(|id| id.as_str())
            .unwrap_or_default();
        match id {
            "_omp_neg" => {
                let mut protocol = self.protocol.write().expect("protocol");
                if meta.success {
                    protocol.version = 2;
                } else {
                    protocol.degraded = Some(
                        meta.error
                            .clone()
                            .unwrap_or_else(|| "negotiation failed".into()),
                    );
                }
                drop(protocol);
                self.publish();
            }
            "_omp_filter" => {
                if meta.success {
                    let delta = value
                        .get("data")
                        .and_then(|data| data.get("messageUpdates"))
                        .and_then(|updates| updates.as_str())
                        == Some("delta");
                    {
                        let mut protocol = self.protocol.write().expect("protocol");
                        protocol.delta = delta;
                        protocol.event_filter = true;
                    }
                    self.publish();
                } else {
                    self.send_internal(
                        b"{\"id\":\"_omp_filter_full\",\"type\":\"set_event_filter\",\"events\":null}",
                    )
                    .await;
                }
            }
            "_omp_filter_full" => {
                let mut protocol = self.protocol.write().expect("protocol");
                if meta.success {
                    protocol.event_filter = true;
                    protocol.delta = false;
                } else {
                    protocol.degraded = Some(
                        meta.error
                            .clone()
                            .unwrap_or_else(|| "event filter unavailable".into()),
                    );
                }
                drop(protocol);
                self.publish();
            }
            "_omp_ask" if !meta.success => {
                self.notice(
                    "info",
                    "rich ask dialog unavailable; using the select/input fallback",
                );
            }
            "_omp_state" => self.apply_state_value(value.get("data")),
            "_omp_stats" => self.apply_stats_value(value.get("data")),
            _ => {}
        }
    }

    fn apply_meta_response(&self, command: &str, raw: &str) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
            return;
        };
        if command == "get_state" {
            self.apply_state_value(value.get("data"));
        } else {
            self.apply_stats_value(value.get("data"));
        }
    }

    fn apply_state_value(&self, data: Option<&serde_json::Value>) {
        if meta::apply_state(&self.meta, data) {
            self.publish();
        }
    }

    fn apply_stats_value(&self, data: Option<&serde_json::Value>) {
        if meta::apply_stats(&self.meta, data) {
            self.publish();
        }
    }

    fn on_ui_request(&self, raw: &str) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
            return;
        };
        let id = value
            .get("id")
            .and_then(|id| id.as_str())
            .unwrap_or_default();
        let method = value
            .get("method")
            .and_then(|method| method.as_str())
            .unwrap_or_default();
        if id.is_empty() {
            return;
        }
        let Ok(parsed) = serde_json::from_str::<&serde_json::value::RawValue>(raw) else {
            return;
        };
        if let Ok(request) = dialog::parse(parsed) {
            match request.method {
                Method::Cancel { target_id } => {
                    self.dialogs.write().expect("dialogs").remove(&target_id);
                }
                Method::Select { .. }
                | Method::Confirm { .. }
                | Method::Input { .. }
                | Method::Editor { .. }
                | Method::Ask { .. } => {
                    self.dialogs
                        .write()
                        .expect("dialogs")
                        .insert(id.to_string(), frame_envelope(&self.id, raw).into());
                }
                _ => {}
            }
        }
        let _ = method;
        self.push_raw(raw);
    }

    pub fn answer_dialog(&self, id: &str) {
        self.dialogs.write().expect("dialogs").remove(id);
        let cancel = format!(
            "{{\"type\":\"extension_ui_request\",\"id\":{},\"method\":\"cancel\",\"targetId\":{}}}",
            json_string(&format!("_console_cancel_{id}")),
            json_string(id)
        );
        self.push_raw(&cancel);
    }

    fn apply_event_metadata(&self, kind: &str, raw: &str) -> bool {
        let refresh = meta::apply_event(&self.meta, kind, raw);
        if refresh {
            self.publish();
        }
        refresh
    }
}
