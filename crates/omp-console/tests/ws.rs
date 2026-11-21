#![cfg(unix)]
//! End-to-end WebSocket contract against a live server and the child fixture:
//! hello, view replay, a command response, and the command allowlist.

use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use omp_console::config::Config;
use omp_console::ompbin::OmpProbe;
use omp_console::state::AppState;
use omp_console::thread::CreateParams;
use serde_json::Value;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

async fn next_json(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Value {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("websocket frame within 5s")
            .expect("socket open")
            .expect("websocket ok");
        if let Message::Text(text) = message {
            return serde_json::from_str(text.as_str()).expect("json frame");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hello_view_replay_and_allowlist() {
    let dir = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let fixture =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/stub_child.mjs");
    let script = dir.path().join("omp-stub.sh");
    let pid_file = dir.path().join("child.pid");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nexec node {} --pid-file {} \"$@\"\n",
            fixture.display(),
            pid_file.display()
        ),
    )
    .unwrap();
    let mut permissions = std::fs::metadata(&script).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&script, permissions).unwrap();

    let mut cfg = Config::for_test(dir.path().join("sessions"));
    std::fs::create_dir_all(&cfg.session_root).unwrap();
    std::fs::create_dir_all(dir.path().join("work")).unwrap();
    cfg.addr = addr;
    cfg.allowed_hosts = vec![addr.to_string()];
    cfg.server_cwd = dir.path().join("work");
    cfg.home = dir.path().to_path_buf();
    cfg.omp_bin = script.display().to_string();
    let state = AppState::new(Arc::new(cfg), OmpProbe::test_stub());
    let thread = state
        .threads
        .create(CreateParams {
            cwd: Some(dir.path().join("work").display().to_string()),
            ..Default::default()
        })
        .await
        .unwrap();

    let app = omp_console::router(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
        .await
        .unwrap();
    let hello = next_json(&mut socket).await;
    assert_eq!(hello["op"], "hello");
    assert_eq!(hello["threads"][0]["id"], thread.id);

    socket
        .send(Message::Text(
            format!("{{\"op\":\"view\",\"thread\":\"{}\"}}", thread.id).into(),
        ))
        .await
        .unwrap();
    let ready = loop {
        let frame = next_json(&mut socket).await;
        if frame["op"] == "frame" {
            assert_eq!(frame["thread"], thread.id);
            if frame["frame"]["type"] == "ready" {
                break frame;
            }
        }
    };
    assert_eq!(ready["frame"]["supportedProtocolVersions"][1], 2);

    socket
        .send(Message::Text(
            format!(
                "{{\"op\":\"command\",\"thread\":\"{}\",\"frame\":{{\"id\":\"cmd-1\",\"type\":\"get_state\"}}}}",
                thread.id
            )
            .into(),
        ))
        .await
        .unwrap();
    let response = loop {
        let frame = next_json(&mut socket).await;
        if frame["op"] == "frame" && frame["frame"]["id"] == "cmd-1" {
            break frame;
        }
    };
    assert_eq!(response["frame"]["command"], "get_state");
    assert_eq!(response["frame"]["success"], true);

    socket
        .send(Message::Text(
            format!(
                "{{\"op\":\"command\",\"thread\":\"{}\",\"frame\":{{\"type\":\"bash\",\"command\":\"id\"}}}}",
                thread.id
            )
            .into(),
        ))
        .await
        .unwrap();
    let notice = loop {
        let frame = next_json(&mut socket).await;
        if frame["op"] == "notice" {
            break frame;
        }
    };
    assert!(notice["message"].as_str().unwrap().contains("not enabled"));

    state.threads.remove(&thread.id).await.unwrap();
    drop(socket);
    server.abort();
}
