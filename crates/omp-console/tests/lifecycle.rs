#![cfg(unix)]
//! Process supervision against a real child fixture: ready, metadata, the cap,
//! and the guarantee that a tool grandchild does not survive teardown.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use omp_console::config::Config;
use omp_console::ompbin::OmpProbe;
use omp_console::state::AppState;
use omp_console::thread::CreateParams;

fn wrapper(dir: &Path, ignore_term: bool) -> PathBuf {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/stub_child.mjs");
    let pid_file = dir.join("child.pid");
    let script = dir.join("omp-stub.sh");
    let extra = if ignore_term { " --ignore-term" } else { "" };
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nexec {} {} --pid-file {} {} \"$@\"\n",
            std::env::var("NODE_BIN").unwrap_or_else(|_| "node".into()),
            fixture.display(),
            pid_file.display(),
            extra
        ),
    )
    .unwrap();
    let mut permissions = std::fs::metadata(&script).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&script, permissions).unwrap();
    pid_file
}

fn state(dir: &Path, bin: &Path, max_threads: usize) -> AppState {
    let mut cfg = Config::for_test(dir.join("sessions"));
    cfg.session_root = dir.join("sessions");
    std::fs::create_dir_all(&cfg.session_root).unwrap();
    std::fs::create_dir_all(dir.join("work")).unwrap();
    cfg.server_cwd = dir.join("work");
    cfg.home = dir.to_path_buf();
    cfg.omp_bin = bin.display().to_string();
    cfg.max_threads = max_threads;
    AppState::new(Arc::new(cfg), OmpProbe::test_stub())
}

async fn wait_ready(state: &AppState, id: &str) -> omp_console::info::ThreadInfo {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let info = state.threads.get(id).unwrap().info();
        if info.status == "ready" && info.protocol.version == 2 {
            return info;
        }
        assert!(
            Instant::now() < deadline,
            "child never became ready: {info:?}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn read_pids(path: &Path) -> (i32, i32) {
    for _ in 0..200 {
        if let Ok(text) = std::fs::read_to_string(path) {
            let mut lines = text.lines();
            if let (Some(pid), Some(grandchild)) = (lines.next(), lines.next()) {
                let pid = pid.trim().parse().unwrap_or(0);
                let grandchild = grandchild
                    .trim()
                    .strip_prefix("grandchild=")
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0);
                if pid > 0 && grandchild > 0 {
                    return (pid, grandchild);
                }
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("pid file was not written: {}", path.display());
}

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

async fn wait_dead(pid: i32) {
    for _ in 0..200 {
        if !alive(pid) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("process {pid} survived teardown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ready_cap_and_no_orphan_grandchild() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = wrapper(dir.path(), false);
    let state = state(dir.path(), &dir.path().join("omp-stub.sh"), 1);

    let first = state
        .threads
        .create(CreateParams {
            cwd: Some(dir.path().join("work").display().to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    let info = wait_ready(&state, &first.id).await;
    assert_eq!(info.model.as_deref(), Some("stub/stub-model"));
    assert!(info.pid > 0);

    let second = state
        .threads
        .create(CreateParams {
            cwd: Some(dir.path().join("work").display().to_string()),
            ..Default::default()
        })
        .await;
    assert!(matches!(
        second,
        Err(omp_console::error::ApiError::TooMany(_))
    ));

    let (pid, grandchild) = read_pids(&pid_file);
    assert_eq!(pid as u32, info.pid);
    state.threads.remove(&first.id).await.unwrap();
    wait_dead(pid).await;
    wait_dead(grandchild).await;
    assert!(state.threads.get(&first.id).is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sigterm_is_escalated_to_sigkill() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = wrapper(dir.path(), true);
    let state = state(dir.path(), &dir.path().join("omp-stub.sh"), 1);
    let thread = state
        .threads
        .create(CreateParams {
            cwd: Some(dir.path().join("work").display().to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    wait_ready(&state, &thread.id).await;
    let (pid, grandchild) = read_pids(&pid_file);
    state.threads.remove(&thread.id).await.unwrap();
    wait_dead(pid).await;
    wait_dead(grandchild).await;
}
