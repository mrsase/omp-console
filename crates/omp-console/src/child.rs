use std::process::Stdio;
use std::sync::Arc;

use bytes::Bytes;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;

use crate::config::Config;
use crate::error::ApiError;
use crate::thread::RpcThread;

/// The resources a spawned child hands to the supervisor. The waiter owns the
/// `Child`; the thread never needs it.
pub struct Spawned {
    pub child: Child,
    pub pid: u32,
    pub stdin: ChildStdin,
    pub stdout: ChildStdout,
    pub stderr: ChildStderr,
}

pub async fn spawn(
    cfg: &Config,
    cwd: &std::path::Path,
    resume: Option<&str>,
    model: Option<&str>,
    thinking: Option<&str>,
) -> Result<Spawned, ApiError> {
    let mut command = Command::new(&cfg.omp_bin);
    command.arg("--mode").arg("rpc-ui").arg("--cwd").arg(cwd);
    if cwd == cfg.home {
        command.arg("--allow-home");
    }
    if let Some(path) = resume {
        command.arg("--resume").arg(path);
    }
    if let Some(model) = model {
        command.arg(format!("--model={model}"));
    }
    if let Some(level) = thinking {
        command.arg("--thinking").arg(level);
    }
    command
        .current_dir(cwd)
        .env("PI_NO_TITLE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        command.process_group(0);
    }

    let mut child = command.spawn().map_err(|error| {
        ApiError::Internal(format!("failed to start `{}`: {error}", cfg.omp_bin))
    })?;
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
    Ok(Spawned {
        child,
        pid,
        stdin,
        stdout,
        stderr,
    })
}

pub async fn writer_loop(mut stdin: ChildStdin, mut rx: mpsc::Receiver<Bytes>) {
    while let Some(frame) = rx.recv().await {
        if stdin.write_all(&frame).await.is_err() || stdin.write_all(b"\n").await.is_err() {
            break;
        }
        if stdin.flush().await.is_err() {
            break;
        }
    }
}

pub enum ReadLine {
    Eof,
    Line,
    TooLarge,
}

/// Read one newline-terminated line, draining anything past `limit` so a
/// broken child cannot grow the console heap.
pub async fn read_line_capped<R: AsyncBufRead + Unpin>(
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

pub async fn reader_loop(thread: Arc<RpcThread>, stdout: ChildStdout) {
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::with_capacity(8192);
    let mut reassembler = omp_protocol::Reassembler::default();
    loop {
        let limit = thread.line_limit();
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
                thread.touch();
                match reassembler.feed(&line) {
                    Ok(omp_protocol::Feed::Pass) => thread.handle_frame(&line).await,
                    Ok(omp_protocol::Feed::Pending) => {}
                    Ok(omp_protocol::Feed::Done(frame)) => thread.handle_frame(&frame).await,
                    Ok(omp_protocol::Feed::Interrupted) => {
                        thread.notice("warning", "interrupted rpc chunk sequence dropped");
                        thread.handle_frame(&line).await;
                    }
                    Err(error) => {
                        thread.notice("error", &format!("rpc chunk error: {error}"));
                    }
                }
                reassembler.set_max(thread.reassembled_limit());
            }
            Err(error) => {
                thread.notice("error", &format!("failed reading omp stdout: {error}"));
                break;
            }
        }
    }
}

pub async fn stderr_loop(thread: Arc<RpcThread>, stderr: ChildStderr) {
    let mut reader = BufReader::new(stderr);
    let mut line = Vec::new();
    loop {
        match read_line_capped(&mut reader, &mut line, 64 * 1024).await {
            Ok(ReadLine::Line) => thread.push_stderr(&line),
            Ok(ReadLine::TooLarge) => thread.push_stderr(b"[stderr line dropped: too long]"),
            Ok(ReadLine::Eof) | Err(_) => break,
        }
    }
}

pub async fn waiter(thread: Arc<RpcThread>, mut child: Child) {
    let status = child.wait().await;
    let code = status.ok().and_then(|status| status.code());
    thread.mark_exited(code);
}

#[cfg(unix)]
pub const SIGTERM: i32 = libc::SIGTERM;
#[cfg(unix)]
pub const SIGKILL: i32 = libc::SIGKILL;

#[cfg(not(unix))]
pub const SIGTERM: i32 = 15;
#[cfg(not(unix))]
pub const SIGKILL: i32 = 9;

#[cfg(unix)]
pub fn signal_group(pid: u32, signal: i32) {
    if pid == 0 {
        return;
    }
    // The child was placed in its own process group, so the group id is its pid.
    unsafe {
        libc::kill(-(pid as i32), signal);
    }
}

#[cfg(not(unix))]
pub fn signal_group(pid: u32, signal: i32) {
    let _ = (pid, signal);
}

/// Whether any process remains in the child's process group.
pub fn group_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        pid != 0 && unsafe { libc::kill(-(pid as i32), 0) } == 0
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}
