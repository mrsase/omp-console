use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use omp_protocol::command;
use omp_protocol::limits::MAX_COMMAND;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use tokio::sync::{broadcast, mpsc};

use crate::messages::{json_string, lagged_envelope, notice_envelope};
use crate::ring::{FrameRing, Read};
use crate::state::AppState;
use crate::thread::{LifecycleEvent, RpcThread, ThreadInfo};

const CLIENT_QUEUE: usize = 256;
const INBOUND_LIMIT: usize = MAX_COMMAND + 4096;
const HEARTBEAT: Duration = Duration::from_secs(30);
const IDLE_LIMIT: Duration = Duration::from_secs(95);

pub async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    let Ok(permit) = state.ws_slots.clone().try_acquire_owned() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "too many open consoles").into_response();
    };
    ws.max_message_size(INBOUND_LIMIT)
        .max_frame_size(INBOUND_LIMIT)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            handle_socket(socket, state).await;
        })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Hello<'a> {
    op: &'static str,
    version: &'a str,
    protocol: Protocol,
    threads: Vec<ThreadInfo>,
}

#[derive(Serialize)]
struct Protocol {
    min: u8,
    max: u8,
}

#[derive(Deserialize)]
struct ClientMessage {
    op: String,
    #[serde(default)]
    thread: Option<String>,
    #[serde(default)]
    frame: Option<Box<RawValue>>,
}

async fn send_text(tx: &mpsc::Sender<Message>, text: String) -> bool {
    tx.send(Message::Text(text.into())).await.is_ok()
}

async fn send_bytes(tx: &mpsc::Sender<Message>, bytes: &[u8]) -> bool {
    match std::str::from_utf8(bytes) {
        Ok(text) => send_text(tx, text.to_owned()).await,
        Err(_) => false,
    }
}

async fn notice(tx: &mpsc::Sender<Message>, thread: &str, level: &str, message: &str) -> bool {
    send_bytes(tx, &notice_envelope(thread, level, message)).await
}

fn spawn_view(thread: Arc<RpcThread>, tx: mpsc::Sender<Message>) -> tokio::task::JoinHandle<()> {
    let ring: Arc<FrameRing> = thread.ring();
    let id = thread.id.clone();
    tokio::spawn(async move {
        let mut cursor = 0;
        let mut changes = ring.subscribe();
        loop {
            match ring.read(&mut cursor) {
                Read::Frame(frame) => {
                    if !send_bytes(&tx, &frame).await {
                        break;
                    }
                }
                Read::Lagged(skipped) => {
                    if !send_bytes(&tx, &lagged_envelope(&id, skipped)).await {
                        break;
                    }
                    for dialog in thread.pending_dialogs() {
                        if !send_bytes(&tx, &dialog).await {
                            return;
                        }
                    }
                }
                Read::Empty => {
                    if changes.changed().await.is_err() {
                        break;
                    }
                }
                Read::Closed => break,
            }
        }
    })
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Message>(CLIENT_QUEUE);
    let mut lifecycle = state.threads.subscribe();

    let hello = Hello {
        op: "hello",
        version: env!("CARGO_PKG_VERSION"),
        protocol: Protocol { min: 1, max: 2 },
        threads: state.threads.list(),
    };
    let hello = serde_json::to_string(&hello).unwrap_or_else(|_| "{}".into());
    if !send_text(&tx, hello).await {
        return;
    }

    let writer = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            if sink.send(message).await.is_err() {
                break;
            }
        }
    });

    let lifecycle_tx = tx.clone();
    let lifecycle_task = tokio::spawn(async move {
        loop {
            match lifecycle.recv().await {
                Ok(LifecycleEvent::Upsert(info)) => {
                    let body = serde_json::to_string(info.as_ref()).unwrap_or_else(|_| "{}".into());
                    if !send_text(
                        &lifecycle_tx,
                        format!("{{\"op\":\"thread\",\"thread\":{body}}}"),
                    )
                    .await
                    {
                        break;
                    }
                }
                Ok(LifecycleEvent::Removed(id)) => {
                    let message =
                        format!("{{\"op\":\"thread_removed\",\"id\":{}}}", json_string(&id));
                    if !send_text(&lifecycle_tx, message).await {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let _ = notice(
                        &lifecycle_tx,
                        "",
                        "warning",
                        "lifecycle events dropped; reload the session list",
                    )
                    .await;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let mut view: Option<tokio::task::JoinHandle<()>> = None;
    let mut last_seen = Instant::now();

    loop {
        tokio::select! {
            message = stream.next() => {
                let Some(Ok(message)) = message else { break };
                last_seen = Instant::now();
                let text = match message {
                    Message::Text(text) => text,
                    Message::Close(_) => break,
                    Message::Ping(_) | Message::Pong(_) | Message::Binary(_) => continue,
                };
                if text.len() > INBOUND_LIMIT {
                    let _ = notice(&tx, "", "warning", "frame exceeds the transport limit").await;
                    continue;
                }
                let message = match serde_json::from_str::<ClientMessage>(text.as_str()) {
                    Ok(message) => message,
                    Err(_) => {
                        let _ = notice(&tx, "", "warning", "invalid websocket message").await;
                        continue;
                    }
                };
                let ClientMessage { op, thread, frame } = message;
                match op.as_str() {
                    "ping" => {
                        let _ = send_text(&tx, "{\"op\":\"pong\"}".into()).await;
                    }
                    "view" => {
                        if let Some(task) = view.take() {
                            task.abort();
                        }
                        let Some(id) = thread else { continue };
                        let Some(thread) = state.threads.get(&id) else {
                            let _ = notice(&tx, &id, "warning", "session not found").await;
                            continue;
                        };
                        view = Some(spawn_view(thread, tx.clone()));
                    }
                    "command" => {
                        let Some(id) = thread else {
                            let _ = notice(&tx, "", "warning", "command is missing a thread").await;
                            continue;
                        };
                        let Some(frame) = frame else {
                            let _ = notice(&tx, &id, "warning", "command is missing a frame").await;
                            continue;
                        };
                        let raw = frame.get();
                        let command = match command::validate(raw) {
                            Ok(command) => command,
                            Err(error) => {
                                let _ = notice(&tx, &id, "warning", &error.to_string()).await;
                                continue;
                            }
                        };
                        let Some(thread) = state.threads.get(&id) else {
                            let _ = notice(&tx, &id, "warning", "session not found").await;
                            continue;
                        };
                        if command.kind == "extension_ui_response"
                            && let Ok(value) = serde_json::from_str::<serde_json::Value>(raw)
                            && let Some(dialog) = value.get("id").and_then(|id| id.as_str())
                        {
                            thread.answer_dialog(dialog);
                        }
                        if !thread
                            .send_frame(bytes::Bytes::copy_from_slice(raw.as_bytes()))
                            .await
                        {
                            let _ = notice(
                                &tx,
                                &id,
                                "warning",
                                "session is no longer accepting commands",
                            )
                            .await;
                        }
                    }
                    _ => {
                        let _ = notice(&tx, "", "warning", "unknown websocket operation").await;
                    }
                }
            }
            _ = tokio::time::sleep(HEARTBEAT) => {
                if last_seen.elapsed() > IDLE_LIMIT {
                    break;
                }
            }
        }
    }

    if let Some(task) = view.take() {
        task.abort();
    }
    lifecycle_task.abort();
    drop(tx);
    let _ = writer.await;
}
