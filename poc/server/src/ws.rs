use std::sync::Arc;

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use tokio::sync::{broadcast, mpsc};

use crate::state::AppState;
use crate::thread::{LifecycleEvent, MAX_INBOUND_FRAME, ThreadInfo, json_string, notice_envelope};

const CLIENT_QUEUE: usize = 256;

pub async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    let Ok(permit) = state.ws_slots.clone().try_acquire_owned() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "too many open consoles").into_response();
    };
    ws.max_message_size(MAX_INBOUND_FRAME + 4096)
        .max_frame_size(MAX_INBOUND_FRAME + 4096)
        .on_upgrade(move |socket| async move {
            // Held for the lifetime of the socket.
            let _permit = permit;
            handle_socket(socket, state).await;
        })
}

#[derive(Serialize)]
struct Hello<'a> {
    op: &'static str,
    version: &'a str,
    threads: Vec<ThreadInfo>,
}

/// Parsed with `RawValue` for `frame` so commands are forwarded to the child
/// without a parse/serialize round trip. (An internally tagged enum cannot hold
/// a `RawValue`, hence the flat struct.)
#[derive(Deserialize)]
struct ClientMessage {
    op: String,
    #[serde(default)]
    thread: Option<String>,
    #[serde(default)]
    frame: Option<Box<RawValue>>,
}

struct ViewSub {
    task: tokio::task::JoinHandle<()>,
}

impl Drop for ViewSub {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn send_text(tx: &mpsc::Sender<Message>, text: String) -> bool {
    tx.send(Message::Text(text.into())).await.is_ok()
}

fn frame_message(bytes: &Arc<Bytes>) -> Option<Message> {
    let text = std::str::from_utf8(bytes).ok()?;
    Some(Message::Text(text.to_owned().into()))
}

async fn send_envelope(
    tx: &mpsc::Sender<Message>,
    thread: &str,
    level: &str,
    message: &str,
) -> bool {
    let envelope = notice_envelope(thread, level, message);
    match frame_message(&envelope) {
        Some(msg) => tx.send(msg).await.is_ok(),
        None => false,
    }
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Message>(CLIENT_QUEUE);
    // Subscribe before listing threads so a lifecycle event racing the hello
    // frame is queued instead of lost.
    let mut lifecycle = state.threads.subscribe();

    let hello = Hello {
        op: "hello",
        version: env!("CARGO_PKG_VERSION"),
        threads: state.threads.list(),
    };
    let hello_text = serde_json::to_string(&hello).unwrap_or_else(|_| "{}".into());
    if !send_text(&tx, hello_text).await {
        return;
    }

    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
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
                    let msg = format!("{{\"op\":\"thread\",\"thread\":{body}}}");
                    if !send_text(&lifecycle_tx, msg).await {
                        break;
                    }
                }
                Ok(LifecycleEvent::Removed(id)) => {
                    let msg = format!("{{\"op\":\"thread_removed\",\"id\":{}}}", json_string(&id));
                    if !send_text(&lifecycle_tx, msg).await {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let mut view: Option<(String, ViewSub)> = None;

    while let Some(Ok(message)) = stream.next().await {
        let text = match message {
            Message::Text(text) => text,
            Message::Close(_) => break,
            _ => continue,
        };
        if text.len() > MAX_INBOUND_FRAME + 4096 {
            let _ = send_envelope(&tx, "", "warning", "frame exceeds the transport limit").await;
            continue;
        }

        let message = match serde_json::from_str::<ClientMessage>(text.as_str()) {
            Ok(message) => message,
            Err(_) => {
                let _ = send_envelope(&tx, "", "warning", "invalid websocket message").await;
                continue;
            }
        };

        match message.op.as_str() {
            "ping" => {
                let _ = send_text(&tx, "{\"op\":\"pong\"}".into()).await;
            }
            "view" => {
                view = None;
                let Some(id) = message.thread else { continue };
                let Some(thread) = state.threads.get(&id) else {
                    let _ = send_envelope(&tx, &id, "warning", "session not found").await;
                    continue;
                };

                let mut frames = thread.subscribe_frames();
                let out = tx.clone();
                let view_id = id.clone();
                let task = tokio::spawn(async move {
                    loop {
                        match frames.recv().await {
                            Ok(frame) => match frame_message(&frame) {
                                Some(msg) => {
                                    if out.send(msg).await.is_err() {
                                        break;
                                    }
                                }
                                None => continue,
                            },
                            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                                let msg = format!(
                                    "{{\"op\":\"lagged\",\"thread\":{},\"skipped\":{skipped}}}",
                                    json_string(&view_id)
                                );
                                if !send_text(&out, msg).await {
                                    break;
                                }
                            }
                            Err(broadcast::error::RecvError::Closed) => break,
                        }
                    }
                });

                view = Some((id, ViewSub { task }));

                // Dialogs may have arrived before this client attached.
                for dialog in thread.dialogs() {
                    if let Some(msg) = frame_message(&dialog)
                        && tx.send(msg).await.is_err()
                    {
                        break;
                    }
                }
            }
            "command" => {
                let Some(thread) = message.thread else {
                    let _ = send_envelope(&tx, "", "warning", "command is missing a thread").await;
                    continue;
                };
                let Some(frame) = message.frame else {
                    let _ =
                        send_envelope(&tx, &thread, "warning", "command is missing a frame").await;
                    continue;
                };
                let raw = frame.get();
                if raw.len() > MAX_INBOUND_FRAME {
                    let _ = send_envelope(
                        &tx,
                        &thread,
                        "error",
                        "command exceeds the 1 MiB inbound frame limit",
                    )
                    .await;
                    continue;
                }
                if !raw.starts_with('{') {
                    let _ = send_envelope(&tx, &thread, "warning", "command must be a JSON object")
                        .await;
                    continue;
                }
                let Some(session) = state.threads.get(&thread) else {
                    let _ = send_envelope(&tx, &thread, "warning", "session not found").await;
                    continue;
                };
                if raw.starts_with("{\"type\":\"extension_ui_response\"")
                    && let Ok(value) = serde_json::from_str::<serde_json::Value>(raw)
                    && let Some(id) = value.get("id").and_then(|v| v.as_str())
                {
                    session.remove_dialog(id);
                }
                if !session
                    .send_frame(Bytes::copy_from_slice(raw.as_bytes()))
                    .await
                {
                    let _ = send_envelope(
                        &tx,
                        &thread,
                        "warning",
                        "session is no longer accepting commands",
                    )
                    .await;
                }
            }
            _ => {
                let _ = send_envelope(&tx, "", "warning", "unknown websocket operation").await;
            }
        }
    }

    drop(view);
    lifecycle_task.abort();
    drop(tx);
    let _ = writer.await;
}
