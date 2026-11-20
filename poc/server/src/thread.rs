use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU8, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use bytes::Bytes;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{broadcast, mpsc, watch};
use tokio::time::sleep;
use uuid::Uuid;

use crate::config::Config;
use crate::error::ApiError;
use crate::fsapi;
use crate::session;

const STATUS_STARTING: u8 = 0;
const STATUS_READY: u8 = 1;
const STATUS_EXITED: u8 = 2;

const FRAME_CHANNEL: usize = 256;
const CMD_CHANNEL: usize = 128;
const DEFAULT_MAX_REASSEMBLED: usize = 64 * 1024 * 1024;
const DEFAULT_MAX_FRAME: usize = 1024 * 1024;
const STDERR_RING: usize = 240;
const STDERR_LINE_CHARS: usize = 2000;
const STDERR_TOTAL_CHARS: usize = 64 * 1024;
const MAX_DIALOGS: usize = 64;

pub const MAX_INBOUND_FRAME: usize = 1024 * 1024;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone)]
pub enum LifecycleEvent {
    Upsert(Arc<ThreadInfo>),
    Removed(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyInfo {
    pub protocol_version: u32,
    #[serde(default)]
    pub supported_protocol_versions: Vec<u32>,
    pub max_frame_bytes: usize,
    pub max_reassembled_frame_bytes: usize,
    #[serde(default)]
    pub supports_bash_exclude_from_context: bool,
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
    pub ready: Option<ReadyInfo>,
}

#[derive(Default)]
struct ThreadMeta {
    model: Option<String>,
    model_name: Option<String>,
    session_name: Option<String>,
    session_file: Option<String>,
    session_id: Option<String>,
    thinking: Option<String>,
}

#[derive(Deserialize, Default)]
struct ModelSeed {
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize, Default)]
struct MetaSeed {
    #[serde(default)]
    model: Option<ModelSeed>,
    #[serde(default, rename = "sessionName")]
    session_name: Option<String>,
    #[serde(default, rename = "sessionFile")]
    session_file: Option<String>,
    #[serde(default, rename = "sessionId")]
    session_id: Option<String>,
    #[serde(default, rename = "thinkingLevel")]
    thinking: Option<String>,
}

#[derive(Deserialize, Default)]
struct StatsSeed {
    #[serde(default, rename = "sessionFile")]
    session_file: Option<String>,
    #[serde(default, rename = "sessionId")]
    session_id: Option<String>,
}

#[derive(Deserialize)]
struct ClientResponse<T> {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    data: Option<T>,
}

pub struct RpcThread {
    pub id: String,
    pub cwd: PathBuf,
    pub created_at: u64,
    resume: Option<String>,
    pid: u32,
    frames: broadcast::Sender<Arc<Bytes>>,
    lifecycle: broadcast::Sender<LifecycleEvent>,
    cmd_tx: Mutex<Option<mpsc::Sender<Bytes>>>,
    kill_tx: watch::Sender<bool>,
    removed: AtomicBool,
    status: AtomicU8,
    exit_code: AtomicI32,
    last_activity: AtomicU64,
    ready: RwLock<Option<ReadyInfo>>,
    meta: RwLock<ThreadMeta>,
    dialogs: RwLock<HashMap<String, Arc<Bytes>>>,
    stderr: Mutex<VecDeque<String>>,
}

impl RpcThread {
    pub async fn spawn(
        cfg: &Config,
        lifecycle: broadcast::Sender<LifecycleEvent>,
        cwd: PathBuf,
        resume: Option<String>,
        model: Option<String>,
        thinking: Option<String>,
    ) -> Result<Arc<Self>, ApiError> {
        let mut cmd = Command::new(&cfg.omp_bin);
        cmd.arg("--mode").arg("rpc-ui").arg("--cwd").arg(&cwd);
        if cwd == cfg.home {
            // omp refuses to start in the home directory unless asked.
            cmd.arg("--allow-home");
        }
        if let Some(path) = &resume {
            cmd.arg("--resume").arg(path);
        }
        if let Some(model) = &model {
            // `=` keeps the value in one argv entry even if it starts with `-`.
            cmd.arg(format!("--model={model}"));
        }
        if let Some(level) = &thinking {
            cmd.arg("--thinking").arg(level);
        }
        cmd.current_dir(&cwd)
            .env("PI_NO_TITLE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd
            .spawn()
            .map_err(|e| ApiError::Internal(format!("failed to start `{}`: {e}", cfg.omp_bin)))?;
        let pid = child.id().unwrap_or(0);
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| ApiError::Internal("child stdin unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ApiError::Internal("child stdout unavailable".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| ApiError::Internal("child stderr unavailable".into()))?;

        let (frame_tx, _) = broadcast::channel(FRAME_CHANNEL);
        let (cmd_tx, cmd_rx) = mpsc::channel::<Bytes>(CMD_CHANNEL);
        let (kill_tx, kill_rx) = watch::channel(false);

        let thread = Arc::new(Self {
            id: Uuid::new_v4().to_string(),
            cwd,
            created_at: now_ms(),
            resume,
            pid,
            frames: frame_tx,
            lifecycle,
            cmd_tx: Mutex::new(Some(cmd_tx)),
            kill_tx,
            removed: AtomicBool::new(false),
            status: AtomicU8::new(STATUS_STARTING),
            exit_code: AtomicI32::new(i32::MIN),
            last_activity: AtomicU64::new(now_ms()),
            ready: RwLock::new(None),
            meta: RwLock::new(ThreadMeta::default()),
            dialogs: RwLock::new(HashMap::new()),
            stderr: Mutex::new(VecDeque::new()),
        });

        tokio::spawn(writer_loop(stdin, cmd_rx));
        tokio::spawn(reader_loop(thread.clone(), stdout));
        tokio::spawn(stderr_loop(thread.clone(), stderr));
        tokio::spawn(waiter(thread.clone(), child, kill_rx));

        Ok(thread)
    }

    pub fn info(&self) -> ThreadInfo {
        let meta = self.meta.read();
        let ready = self.ready.read().clone();
        let exit = self.exit_code.load(Ordering::Acquire);
        let title = meta
            .session_name
            .clone()
            .or_else(|| {
                self.cwd
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
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
        }
    }

    fn publish(&self) {
        if self.removed.load(Ordering::Acquire) {
            return;
        }
        let _ = self
            .lifecycle
            .send(LifecycleEvent::Upsert(Arc::new(self.info())));
    }

    fn broadcast_frame(&self, line: &[u8]) {
        let envelope = frame_envelope(&self.id, line);
        let _ = self.frames.send(envelope);
    }

    fn notice(&self, level: &str, message: &str) {
        let envelope = notice_envelope(&self.id, level, message);
        let _ = self.frames.send(envelope);
    }

    pub fn subscribe_frames(&self) -> broadcast::Receiver<Arc<Bytes>> {
        self.frames.subscribe()
    }

    pub fn dialogs(&self) -> Vec<Arc<Bytes>> {
        self.dialogs.read().values().cloned().collect()
    }

    pub fn remove_dialog(&self, id: &str) {
        self.dialogs.write().remove(id);
    }

    fn try_send_static(&self, frame: &'static [u8]) {
        if let Some(tx) = self.cmd_tx.lock().as_ref() {
            let _ = tx.try_send(Bytes::from_static(frame));
        }
    }

    fn max_frame_bytes(&self) -> usize {
        self.ready
            .read()
            .as_ref()
            .map(|ready| ready.max_frame_bytes.clamp(4096, 16 * 1024 * 1024))
            .unwrap_or(DEFAULT_MAX_FRAME)
    }

    pub fn stderr_lines(&self) -> Vec<String> {
        self.stderr.lock().iter().cloned().collect()
    }

    pub async fn send_frame(&self, frame: Bytes) -> bool {
        let tx = self.cmd_tx.lock().as_ref().cloned();
        match tx {
            Some(tx) => tx.send(frame).await.is_ok(),
            None => false,
        }
    }

    async fn send_internal(&self, frame: &'static [u8]) {
        let _ = self.send_frame(Bytes::from_static(frame)).await;
    }

    fn with_meta(&self, update: impl FnOnce(&mut ThreadMeta)) {
        let mut meta = self.meta.write();
        let before = (
            meta.model.clone(),
            meta.model_name.clone(),
            meta.session_name.clone(),
            meta.session_file.clone(),
            meta.session_id.clone(),
            meta.thinking.clone(),
        );
        update(&mut meta);
        let after = (
            meta.model.clone(),
            meta.model_name.clone(),
            meta.session_name.clone(),
            meta.session_file.clone(),
            meta.session_id.clone(),
            meta.thinking.clone(),
        );
        drop(meta);
        if before != after {
            self.publish();
        }
    }

    fn mark_exited(&self, code: Option<i32>) {
        let previous = self.status.swap(STATUS_EXITED, Ordering::AcqRel);
        if let Some(code) = code {
            self.exit_code.store(code, Ordering::Release);
        }
        self.cmd_tx.lock().take();
        self.dialogs.write().clear();
        if previous != STATUS_EXITED {
            self.publish();
        }
    }

    /// Asks the agent loop to stop, closes stdin, and force-kills if the child
    /// does not exit within `grace`.
    pub async fn stop(&self, grace: Duration) {
        if self.status.load(Ordering::Acquire) == STATUS_EXITED {
            self.cmd_tx.lock().take();
            return;
        }
        let _ = self
            .send_frame(Bytes::from_static(b"{\"type\":\"abort\"}"))
            .await;
        // Never await a full command channel here: the child may have stopped
        // reading stdin, and the grace deadline must stay reachable.
        self.try_send_static(b"{\"id\":\"_ompweb_stop\",\"type\":\"abort\"}");
        self.cmd_tx.lock().take();

        let deadline = tokio::time::Instant::now() + grace;
        while self.status.load(Ordering::Acquire) != STATUS_EXITED {
            if tokio::time::Instant::now() >= deadline {
                self.force_kill();
                sleep(Duration::from_millis(400)).await;
                break;
            }
            sleep(Duration::from_millis(40)).await;
        }
    }

    fn force_kill(&self) {
        if self.status.load(Ordering::Acquire) == STATUS_EXITED {
            return;
        }
        // The waiter owns the `Child`; signaling through it avoids PID reuse.
        let _ = self.kill_tx.send(true);
    }

    fn apply_meta(&self, seed: MetaSeed) {
        self.with_meta(|meta| {
            if let Some(model) = seed.model
                && let (Some(provider), Some(id)) = (model.provider, model.id)
            {
                meta.model = Some(format!("{provider}/{id}"));
                meta.model_name = model.name;
            }
            if seed.session_name.is_some() {
                meta.session_name = seed.session_name;
            }
            if seed.session_file.is_some() {
                meta.session_file = seed.session_file;
            }
            if seed.session_id.is_some() {
                meta.session_id = seed.session_id;
            }
            if seed.thinking.is_some() {
                meta.thinking = seed.thinking;
            }
        });
    }

    fn apply_stats(&self, seed: StatsSeed) {
        self.with_meta(|meta| {
            if seed.session_file.is_some() {
                meta.session_file = seed.session_file;
            }
            if seed.session_id.is_some() {
                meta.session_id = seed.session_id;
            }
        });
    }

    /// Keeps `ThreadInfo` fresh from the replies the UI asks for, so a session
    /// switch/fork/rename is reflected in lifecycle updates and resume.
    fn track_client_response(&self, line: &[u8]) {
        let Some(command) = client_response_command(line) else {
            return;
        };
        match command {
            "get_state" => {
                if let Ok(response) = serde_json::from_slice::<ClientResponse<MetaSeed>>(line)
                    && response.success
                    && let Some(seed) = response.data
                {
                    self.apply_meta(seed);
                }
            }
            "get_session_stats" => {
                if let Ok(response) = serde_json::from_slice::<ClientResponse<StatsSeed>>(line)
                    && response.success
                    && let Some(seed) = response.data
                {
                    self.apply_stats(seed);
                }
            }
            _ => {}
        }
    }

    async fn handle_frame(self: &Arc<Self>, line: &[u8]) {
        // The envelope wraps this line verbatim; a non-object or trailing
        // garbage would let the child forge envelope keys in the browser.
        if !is_json_object(line) {
            self.notice("error", "dropped malformed omp frame");
            return;
        }
        if line.starts_with(b"{\"id\":\"_ompweb_") {
            self.handle_internal(line);
            return;
        }
        self.track_client_response(line);

        if line.starts_with(b"{\"type\":\"ready\"") {
            match serde_json::from_slice::<ReadyInfo>(line) {
                Ok(ready) => {
                    let negotiate_v2 = ready.supported_protocol_versions.contains(&2);
                    *self.ready.write() = Some(ready);
                    self.status.store(STATUS_READY, Ordering::Release);
                    self.publish();
                    self.broadcast_frame(line);

                    if negotiate_v2 {
                        self.send_internal(
                            b"{\"id\":\"_ompweb_neg\",\"type\":\"negotiate_protocol\",\"protocolVersion\":2}",
                        )
                        .await;
                    }
                    self.send_internal(
                        b"{\"id\":\"_ompweb_filter\",\"type\":\"set_event_filter\",\"events\":null,\"messageUpdates\":\"delta\"}",
                    )
                    .await;
                    self.send_internal(
                        b"{\"id\":\"_ompweb_ask\",\"type\":\"set_ask_dialog\",\"enabled\":true}",
                    )
                    .await;
                    self.send_internal(b"{\"id\":\"_ompweb_state\",\"type\":\"get_state\"}")
                        .await;
                    self.send_internal(
                        b"{\"id\":\"_ompweb_stats\",\"type\":\"get_session_stats\"}",
                    )
                    .await;
                }
                Err(err) => self.notice("error", &format!("invalid ready frame: {err}")),
            }
            return;
        }

        if line.starts_with(b"{\"type\":\"extension_ui_request\"") {
            self.handle_ui_request(line);
        } else if line.starts_with(b"{\"type\":\"session_info_update\"") {
            self.handle_session_info(line);
        }

        self.broadcast_frame(line);
    }

    fn handle_session_info(&self, line: &[u8]) {
        #[derive(Deserialize)]
        struct Update<'a> {
            #[serde(default, borrow)]
            title: Option<&'a str>,
            #[serde(default, rename = "sessionId", borrow)]
            session_id: Option<&'a str>,
        }
        let Ok(update) = serde_json::from_slice::<Update>(line) else {
            return;
        };
        let title = update.title.map(str::to_owned);
        let session_id = update.session_id.map(str::to_owned);
        self.with_meta(|meta| {
            if title.is_some() {
                meta.session_name = title;
            }
            if session_id.is_some() {
                meta.session_id = session_id;
            }
        });
    }

    fn handle_ui_request(&self, line: &[u8]) {
        #[derive(Deserialize)]
        struct UiRequest<'a> {
            #[serde(borrow)]
            id: &'a str,
            #[serde(borrow)]
            method: &'a str,
            #[serde(default, rename = "targetId", borrow)]
            target_id: Option<&'a str>,
        }

        let envelope = frame_envelope(&self.id, line);
        if let Ok(req) = serde_json::from_slice::<UiRequest>(line) {
            match req.method {
                "select" | "confirm" | "input" | "editor" | "ask" => {
                    let mut dialogs = self.dialogs.write();
                    if dialogs.len() >= MAX_DIALOGS
                        && let Some(oldest) = dialogs.keys().next().cloned()
                    {
                        dialogs.remove(&oldest);
                    }
                    dialogs.insert(req.id.to_string(), envelope.clone());
                }
                "cancel" => {
                    if let Some(target) = req.target_id {
                        self.dialogs.write().remove(target);
                    }
                }
                _ => {}
            }
        }
        let _ = self.frames.send(envelope);
    }

    fn handle_internal(&self, line: &[u8]) {
        #[derive(Deserialize)]
        struct Response {
            #[serde(default)]
            id: String,
            #[serde(default)]
            success: bool,
            #[serde(default)]
            error: Option<String>,
            #[serde(default)]
            data: Option<serde_json::Value>,
        }

        let Ok(resp) = serde_json::from_slice::<Response>(line) else {
            return;
        };

        match resp.id.as_str() {
            "_ompweb_state" => {
                if let Some(data) = resp.data
                    && let Ok(seed) = serde_json::from_value::<MetaSeed>(data)
                {
                    self.apply_meta(seed);
                }
            }
            "_ompweb_stats" => {
                if let Some(data) = resp.data
                    && let Ok(seed) = serde_json::from_value::<StatsSeed>(data)
                {
                    self.apply_stats(seed);
                }
            }
            "_ompweb_ask" if !resp.success => {
                let detail = resp.error.unwrap_or_else(|| "not supported".into());
                self.notice(
                    "info",
                    &format!(
                        "rich ask dialog unavailable ({detail}); using select/editor fallback"
                    ),
                );
            }
            "_ompweb_filter" | "_ompweb_neg" if !resp.success => {
                let detail = resp.error.unwrap_or_else(|| "unknown error".into());
                self.notice("warning", &format!("protocol negotiation issue: {detail}"));
            }
            _ => {}
        }
    }
}

async fn writer_loop(mut stdin: ChildStdin, mut rx: mpsc::Receiver<Bytes>) {
    while let Some(frame) = rx.recv().await {
        if stdin.write_all(&frame).await.is_err() {
            break;
        }
        if stdin.write_all(b"\n").await.is_err() {
            break;
        }
        if stdin.flush().await.is_err() {
            break;
        }
    }
}

enum ReadLine {
    Eof,
    Line,
    TooLarge,
}

/// Reads one newline-terminated line, dropping (and draining) anything past
/// `limit` so a giant child frame cannot grow the backend heap.
async fn read_line_capped<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    limit: usize,
) -> std::io::Result<ReadLine> {
    buf.clear();
    let mut too_large = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(if too_large {
                ReadLine::TooLarge
            } else if buf.is_empty() {
                ReadLine::Eof
            } else {
                ReadLine::Line
            });
        }
        if let Some(position) = available.iter().position(|byte| *byte == b'\n') {
            if !too_large {
                if buf.len() + position > limit {
                    too_large = true;
                    buf.clear();
                } else {
                    buf.extend_from_slice(&available[..position]);
                }
            }
            reader.consume(position + 1);
            return Ok(if too_large {
                ReadLine::TooLarge
            } else {
                ReadLine::Line
            });
        }
        let length = available.len();
        if !too_large {
            if buf.len() + length > limit {
                too_large = true;
                buf.clear();
            } else {
                buf.extend_from_slice(available);
            }
        }
        reader.consume(length);
    }
}

async fn reader_loop(thread: Arc<RpcThread>, stdout: ChildStdout) {
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::with_capacity(8192);
    let mut reassembler = Reassembler::new(DEFAULT_MAX_REASSEMBLED);

    loop {
        let limit = thread.max_frame_bytes();
        match read_line_capped(&mut reader, &mut line, limit).await {
            Ok(ReadLine::Eof) => break,
            Ok(ReadLine::TooLarge) => {
                reassembler.reset();
                thread.notice("error", "dropped oversized omp frame");
            }
            Ok(ReadLine::Line) => {
                while matches!(line.last(), Some(b'\n' | b'\r')) {
                    line.pop();
                }
                if line.is_empty() {
                    continue;
                }
                thread.last_activity.store(now_ms(), Ordering::Relaxed);
                let is_ready = line.starts_with(b"{\"type\":\"ready\"");
                match reassembler.feed(&line) {
                    Ok(Feed::Pass) => thread.handle_frame(&line).await,
                    Ok(Feed::Pending) => {}
                    Ok(Feed::Done(frame)) => thread.handle_frame(&frame).await,
                    Ok(Feed::Interrupted) => {
                        thread.notice("warning", "interrupted rpc chunk sequence dropped");
                        thread.handle_frame(&line).await;
                    }
                    Err(err) => thread.notice("error", &format!("rpc chunk error: {err}")),
                }
                if is_ready && let Some(ready) = thread.ready.read().as_ref() {
                    reassembler.set_max(ready.max_reassembled_frame_bytes);
                }
            }
            Err(err) => {
                thread.notice("error", &format!("failed reading omp stdout: {err}"));
                break;
            }
        }
    }
}

async fn stderr_loop(thread: Arc<RpcThread>, stderr: ChildStderr) {
    let mut reader = BufReader::new(stderr);
    let mut line = Vec::new();
    loop {
        match read_line_capped(&mut reader, &mut line, 64 * 1024).await {
            Ok(ReadLine::Line) => {
                let mut text = String::from_utf8_lossy(&line).into_owned();
                if text.chars().nth(STDERR_LINE_CHARS).is_some() {
                    text = format!(
                        "{}…",
                        text.chars().take(STDERR_LINE_CHARS).collect::<String>()
                    );
                }
                let mut ring = thread.stderr.lock();
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
            Ok(ReadLine::TooLarge) => {
                let mut ring = thread.stderr.lock();
                if ring.len() == STDERR_RING {
                    ring.pop_front();
                }
                ring.push_back("[stderr line dropped: too long]".into());
            }
            Ok(ReadLine::Eof) | Err(_) => break,
        }
    }
}

async fn waiter(thread: Arc<RpcThread>, mut child: Child, mut kill_rx: watch::Receiver<bool>) {
    let status = tokio::select! {
        status = child.wait() => status,
        changed = kill_rx.changed() => {
            if changed.is_ok() && *kill_rx.borrow() {
                let _ = child.start_kill();
            }
            child.wait().await
        }
    };
    let code = status.ok().and_then(|s| s.code());
    thread.mark_exited(code);
}

// ---------------------------------------------------------------------------
// Outbound envelopes
// ---------------------------------------------------------------------------

fn client_response_command(line: &[u8]) -> Option<&'static str> {
    let head = &line[..line.len().min(320)];
    if !head
        .windows(b"\"type\":\"response\"".len())
        .any(|window| window == b"\"type\":\"response\"")
    {
        return None;
    }
    const GET_STATE: &[u8] = b"\"command\":\"get_state\"";
    const GET_STATS: &[u8] = b"\"command\":\"get_session_stats\"";
    if head
        .windows(GET_STATE.len())
        .any(|window| window == GET_STATE)
    {
        Some("get_state")
    } else if head
        .windows(GET_STATS.len())
        .any(|window| window == GET_STATS)
    {
        Some("get_session_stats")
    } else {
        None
    }
}

fn is_json_object(line: &[u8]) -> bool {
    serde_json::from_slice::<&serde_json::value::RawValue>(line)
        .map(|value| value.get().trim_start().starts_with('{'))
        .unwrap_or(false)
}

pub fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
}

pub fn frame_envelope(thread_id: &str, frame: &[u8]) -> Arc<Bytes> {
    const PREFIX: &[u8] = b"{\"op\":\"frame\",\"thread\":\"";
    let mut out = Vec::with_capacity(PREFIX.len() + thread_id.len() + 16 + frame.len());
    out.extend_from_slice(PREFIX);
    out.extend_from_slice(thread_id.as_bytes());
    out.extend_from_slice(b"\",\"frame\":");
    out.extend_from_slice(frame);
    out.push(b'}');
    Arc::new(Bytes::from(out))
}

pub fn notice_envelope(thread_id: &str, level: &str, message: &str) -> Arc<Bytes> {
    let body = format!(
        "{{\"op\":\"notice\",\"thread\":{},\"level\":{},\"message\":{}}}",
        json_string(thread_id),
        json_string(level),
        json_string(message)
    );
    Arc::new(Bytes::from(body))
}

// ---------------------------------------------------------------------------
// RPC v2 chunk reassembly
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ChunkFrame {
    #[serde(rename = "chunkId")]
    chunk_id: String,
    index: usize,
    count: usize,
    #[serde(rename = "byteLength")]
    byte_length: usize,
    data: String,
}

struct ChunkState {
    id: String,
    count: usize,
    next: usize,
    byte_len: usize,
    data: Vec<u8>,
}

#[derive(Debug, PartialEq)]
pub enum Feed {
    Pass,
    Interrupted,
    Pending,
    Done(Vec<u8>),
}

pub struct Reassembler {
    state: Option<ChunkState>,
    max: usize,
}

impl Reassembler {
    pub fn new(max: usize) -> Self {
        Self {
            state: None,
            max: max.max(1024),
        }
    }

    pub fn set_max(&mut self, max: usize) {
        self.max = max.max(1024);
    }

    pub fn reset(&mut self) {
        self.state = None;
    }

    fn looks_like_chunk(line: &[u8]) -> bool {
        // omp's encoder writes `type` first for chunk frames. Checking the
        // actual type avoids misclassifying normal frames whose payload happens
        // to contain a `chunkId` field.
        line.starts_with(b"{\"type\":\"rpc_chunk\"")
    }

    pub fn feed(&mut self, line: &[u8]) -> Result<Feed, String> {
        if !Self::looks_like_chunk(line) {
            return Ok(if self.state.take().is_some() {
                Feed::Interrupted
            } else {
                Feed::Pass
            });
        }

        let chunk: ChunkFrame =
            serde_json::from_slice(line).map_err(|e| format!("invalid chunk frame: {e}"))?;
        if chunk.count == 0 || chunk.index >= chunk.count {
            self.state = None;
            return Err("invalid chunk index or count".into());
        }
        if chunk.byte_length > self.max {
            self.state = None;
            return Err(format!(
                "frame of {} bytes exceeds the {}-byte limit",
                chunk.byte_length, self.max
            ));
        }

        if self.state.is_none() {
            if chunk.index != 0 {
                return Err("chunk sequence did not start at index 0".into());
            }
            self.state = Some(ChunkState {
                id: chunk.chunk_id.clone(),
                count: chunk.count,
                next: 0,
                byte_len: chunk.byte_length,
                data: Vec::with_capacity(chunk.byte_length.min(1024 * 1024)),
            });
        }

        {
            let state = self.state.as_ref().expect("state initialized");
            let mismatch = if state.id != chunk.chunk_id {
                Some("interleaved chunk ids")
            } else if state.count != chunk.count {
                Some("chunk count changed mid-sequence")
            } else if state.next != chunk.index {
                Some("chunk index out of order")
            } else {
                None
            };
            if let Some(reason) = mismatch {
                self.state = None;
                return Err(reason.into());
            }
        }

        let bytes = match BASE64.decode(chunk.data.as_bytes()) {
            Ok(bytes) => bytes,
            Err(error) => {
                self.state = None;
                return Err(format!("invalid chunk base64: {error}"));
            }
        };

        let fits = {
            let state = self.state.as_ref().expect("state initialized");
            state.data.len() + bytes.len() <= state.byte_len
        };
        if !fits {
            self.state = None;
            return Err("chunk payload exceeds declared byte length".into());
        }
        let state = self.state.as_mut().expect("state initialized");
        state.data.extend_from_slice(&bytes);
        state.next += 1;

        if state.next == state.count {
            let state = self.state.take().expect("state initialized");
            if state.data.len() != state.byte_len {
                return Err(format!(
                    "reassembled {} bytes, expected {}",
                    state.data.len(),
                    state.byte_len
                ));
            }
            if std::str::from_utf8(&state.data).is_err() {
                return Err("reassembled frame is not valid UTF-8".into());
            }
            return Ok(Feed::Done(state.data));
        }

        Ok(Feed::Pending)
    }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

pub struct CreateParams {
    pub cwd: Option<String>,
    pub resume: Option<String>,
    pub model: Option<String>,
    pub thinking: Option<String>,
}

const THINKING_LEVELS: &[&str] = &[
    "inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max", "auto",
];

pub struct ThreadRegistry {
    threads: RwLock<HashMap<String, Arc<RpcThread>>>,
    lifecycle: broadcast::Sender<LifecycleEvent>,
    cfg: Arc<Config>,
    create_lock: tokio::sync::Mutex<()>,
}

impl ThreadRegistry {
    pub fn new(cfg: Arc<Config>) -> Self {
        let (lifecycle, _) = broadcast::channel(256);
        Self {
            threads: RwLock::new(HashMap::new()),
            lifecycle,
            cfg,
            create_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<LifecycleEvent> {
        self.lifecycle.subscribe()
    }

    pub fn get(&self, id: &str) -> Option<Arc<RpcThread>> {
        self.threads.read().get(id).cloned()
    }

    pub fn list(&self) -> Vec<ThreadInfo> {
        let mut threads: Vec<Arc<RpcThread>> = self.threads.read().values().cloned().collect();
        threads.sort_by_key(|thread| std::cmp::Reverse(thread.created_at));
        threads.iter().map(|t| t.info()).collect()
    }

    /// Drops exited sessions that nobody has touched for a while so lifecycle
    /// broadcasts and the in-memory map do not grow without bound.
    pub fn prune_exited(&self, max_age: Duration) {
        let cutoff = now_ms().saturating_sub(max_age.as_millis() as u64);
        let ids: Vec<String> = self
            .threads
            .read()
            .iter()
            .filter(|(_, thread)| {
                thread.status.load(Ordering::Acquire) == STATUS_EXITED
                    && thread.last_activity.load(Ordering::Relaxed) < cutoff
            })
            .map(|(id, _)| id.clone())
            .collect();
        if ids.is_empty() {
            return;
        }
        let mut threads = self.threads.write();
        for id in ids {
            if let Some(thread) = threads.remove(&id) {
                thread.removed.store(true, Ordering::Release);
                let _ = self.lifecycle.send(LifecycleEvent::Removed(id));
            }
        }
    }

    pub async fn create(&self, params: CreateParams) -> Result<Arc<RpcThread>, ApiError> {
        let _guard = self.create_lock.lock().await;

        let running = self
            .threads
            .read()
            .values()
            .filter(|t| t.status.load(Ordering::Acquire) != STATUS_EXITED)
            .count();
        if running >= self.cfg.max_threads {
            return Err(ApiError::TooMany(format!(
                "at most {} concurrent omp sessions",
                self.cfg.max_threads
            )));
        }

        let resume = params
            .resume
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let resume_path = match &resume {
            Some(raw) => {
                let path = fsapi::expand(raw, &self.cfg);
                let canonical = std::fs::canonicalize(&path)
                    .map_err(|_| ApiError::BadRequest("session file not found".into()))?;
                let root = std::fs::canonicalize(&self.cfg.session_root)
                    .unwrap_or_else(|_| self.cfg.session_root.clone());
                if !canonical.starts_with(&root)
                    || canonical.extension().and_then(|ext| ext.to_str()) != Some("jsonl")
                {
                    return Err(ApiError::BadRequest(
                        "resume file must be a .jsonl session under the session root".into(),
                    ));
                }
                Some(canonical)
            }
            None => None,
        };

        let cwd = match params
            .cwd
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        {
            Some(raw) => fsapi::expand(&raw, &self.cfg),
            None => match &resume_path {
                Some(path) => {
                    let header = session::read(path)
                        .ok_or_else(|| ApiError::BadRequest("cannot read session header".into()))?;
                    header.cwd.map(PathBuf::from).ok_or_else(|| {
                        ApiError::BadRequest("session has no working directory".into())
                    })?
                }
                None => self.cfg.server_cwd.clone(),
            },
        };

        let cwd = std::fs::canonicalize(&cwd)
            .map_err(|e| ApiError::BadRequest(format!("{}: {e}", cwd.display())))?;
        if !cwd.is_dir() {
            return Err(ApiError::BadRequest(format!(
                "{} is not a directory",
                cwd.display()
            )));
        }

        let model = params
            .model
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        if let Some(model) = &model
            && (!model.contains('/') || model.chars().any(char::is_whitespace))
        {
            return Err(ApiError::BadRequest(
                "model must be provider/modelId".into(),
            ));
        }

        let thinking = params
            .thinking
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
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
            cwd,
            resume_path.map(|p| p.display().to_string()),
            model,
            thinking,
        )
        .await?;

        self.threads
            .write()
            .insert(thread.id.clone(), thread.clone());
        thread.publish();
        Ok(thread)
    }

    pub async fn remove(&self, id: &str) -> Result<(), ApiError> {
        let thread = self
            .threads
            .write()
            .remove(id)
            .ok_or_else(|| ApiError::NotFound(format!("no session {id}")))?;
        thread.removed.store(true, Ordering::Release);
        thread.stop(Duration::from_secs(2)).await;
        let _ = self.lifecycle.send(LifecycleEvent::Removed(id.to_string()));
        Ok(())
    }

    pub async fn stop_all(&self) {
        let threads: Vec<Arc<RpcThread>> = self.threads.read().values().cloned().collect();
        let mut set = tokio::task::JoinSet::new();
        for thread in threads {
            set.spawn(async move {
                thread.stop(Duration::from_secs(2)).await;
            });
        }
        while set.join_next().await.is_some() {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(id: &str, index: usize, count: usize, total: usize, data: &[u8]) -> Vec<u8> {
        format!(
            r#"{{"type":"rpc_chunk","chunkId":"{id}","index":{index},"count":{count},"byteLength":{total},"data":"{}"}}"#,
            BASE64.encode(data)
        )
        .into_bytes()
    }

    #[test]
    fn reassembles_in_order() {
        let payload = br#"{"type":"response","success":true}"#;
        let (a, b) = payload.split_at(10);
        let mut r = Reassembler::new(1024);
        assert_eq!(
            r.feed(&chunk("c1", 0, 2, payload.len(), a)).unwrap(),
            Feed::Pending
        );
        assert_eq!(
            r.feed(&chunk("c1", 1, 2, payload.len(), b)).unwrap(),
            Feed::Done(payload.to_vec())
        );
    }

    #[test]
    fn rejects_out_of_order() {
        let mut r = Reassembler::new(1024);
        r.feed(&chunk("c1", 0, 2, 4, b"ab")).unwrap();
        assert!(r.feed(&chunk("c1", 2, 2, 4, b"cd")).is_err());
    }

    #[test]
    fn rejects_interleaved_ids() {
        let mut r = Reassembler::new(1024);
        r.feed(&chunk("c1", 0, 2, 4, b"ab")).unwrap();
        assert!(r.feed(&chunk("c2", 1, 2, 4, b"cd")).is_err());
    }

    #[test]
    fn rejects_bad_declared_length() {
        let mut r = Reassembler::new(1024);
        assert!(r.feed(&chunk("c1", 0, 1, 99, b"ab")).is_err());
    }

    #[test]
    fn flags_interrupted_sequences_and_passes_line() {
        let mut r = Reassembler::new(1024);
        r.feed(&chunk("c1", 0, 2, 4, b"ab")).unwrap();
        assert_eq!(r.feed(br#"{"type":"ready"}"#).unwrap(), Feed::Interrupted);
        assert_eq!(r.feed(br#"{"type":"ready"}"#).unwrap(), Feed::Pass);
    }

    #[test]
    fn passes_frames_that_mention_chunk_id() {
        let payload = br#"{"type":"tool_execution_end","result":{"chunkId":"nested"},"data":"x"}"#;
        let mut r = Reassembler::new(1024);
        assert_eq!(r.feed(payload).unwrap(), Feed::Pass);
    }

    #[test]
    fn rejects_envelope_spoofing_lines() {
        assert!(is_json_object(br#"{"type":"ready"}"#));
        assert!(!is_json_object(
            br#"{"type":"x"},"op":"thread_removed","id":"other"}"#
        ));
        assert!(!is_json_object(b"not json"));
        assert!(!is_json_object(b"[1,2,3]"));
    }

    #[test]
    fn rejects_non_utf8_payload() {
        let payload = [0xff, 0xfe];
        let mut r = Reassembler::new(1024);
        assert!(r.feed(&chunk("c1", 0, 1, payload.len(), &payload)).is_err());
    }
}
