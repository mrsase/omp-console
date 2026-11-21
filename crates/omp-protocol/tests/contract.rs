//! Contract tests: the committed fixtures are the shared truth between Rust and
//! the TypeScript reducer. These tests are deliberately about classification
//! and validation, not about any particular UI.

use std::collections::BTreeSet;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use omp_protocol::chunk::{Feed, Reassembler};
use omp_protocol::command;
use omp_protocol::dialog::{self, Method};
use omp_protocol::fixture;
use omp_protocol::frame::{self, Class, FrameError, PromptStatus};
use omp_protocol::limits::{CHUNK_PAYLOAD, MAX_PHYSICAL_FRAME, MAX_REASSEMBLED_FRAME};
use serde_json::Value;

/// An owned fixture frame: the raw line plus its classification. Tests that
/// need a typed body borrow `raw` for the duration of the check.
struct Owned {
    kind: String,
    class: Class,
    raw: String,
}

impl Owned {
    fn frame(&self) -> frame::Frame<'_> {
        frame::parse(&self.raw).expect("fixture line parses")
    }
}

fn parsed(name: &str) -> Vec<Owned> {
    fixture::lines(name)
        .unwrap()
        .into_iter()
        .map(|line| {
            let frame =
                frame::parse(&line).unwrap_or_else(|error| panic!("{name}: {error}\n{line}"));
            Owned {
                kind: frame.kind.to_string(),
                class: frame.class,
                raw: line,
            }
        })
        .collect()
}

#[test]
fn every_fixture_line_is_one_object() {
    for name in fixture::NAMES {
        let lines = fixture::lines(name).unwrap();
        assert!(!lines.is_empty(), "{name} is empty");
        for line in &lines {
            let raw: &serde_json::value::RawValue = serde_json::from_str(line)
                .unwrap_or_else(|error| panic!("{name}: {error}: {line}"));
            assert!(raw.get().trim_start().starts_with('{'), "{name}: {line}");
        }
    }
}

#[test]
fn handshake_is_ready_then_correlated_responses() {
    let frames = parsed("handshake");
    assert_eq!(frames[0].class, Class::Ready);
    let ready = frames[0].frame().ready().expect("ready body");
    assert!(ready.supports_v2());
    assert_eq!(ready.max_frame_bytes, MAX_PHYSICAL_FRAME);
    assert_eq!(ready.max_reassembled_frame_bytes, MAX_REASSEMBLED_FRAME);

    let commands: Vec<String> = frames
        .iter()
        .filter_map(|frame| frame.frame().response())
        .map(|response| response.command)
        .collect();
    for expected in [
        "negotiate_protocol",
        "set_event_filter",
        "set_ask_dialog",
        "get_state",
        "get_session_stats",
        "get_available_thinking_levels",
        "get_available_models",
        "get_available_commands",
    ] {
        assert!(
            commands.iter().any(|command| command == expected),
            "missing {expected}"
        );
    }
    assert!(frames.iter().any(|frame| frame.class == Class::Ignored));
    assert!(frames.iter().all(|frame| frame.class != Class::Unknown));
}

#[test]
fn stream_yields_a_complete_turn_and_no_unknowns() {
    let frames = parsed("stream");
    let kinds: BTreeSet<&str> = frames.iter().map(|frame| frame.kind.as_str()).collect();
    for expected in [
        "agent_start",
        "turn_start",
        "message_start",
        "message_update",
        "message_end",
        "tool_execution_start",
        "tool_execution_update",
        "tool_execution_end",
        "extension_ui_request",
        "turn_end",
        "agent_end",
        "prompt_result",
        "session_settled",
    ] {
        assert!(kinds.contains(expected), "missing {expected}");
    }
    assert!(frames.iter().all(|frame| frame.class != Class::Unknown));

    let result = frames
        .iter()
        .find_map(|frame| frame.frame().prompt_result())
        .expect("prompt_result");
    assert_eq!(result.status, PromptStatus::Completed);
    assert!(result.session_settled);

    let updates = frames
        .iter()
        .filter(|frame| frame.kind == "message_update")
        .count();
    assert!(updates > 10, "expected delta updates, got {updates}");
}

#[test]
fn resume_rehydrates_five_messages() {
    let lines = fixture::lines("resume").unwrap();
    let messages = lines
        .iter()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find_map(|value| {
            (value.get("command").and_then(Value::as_str) == Some("get_messages"))
                .then(|| value.get("data")?.get("messages")?.as_array().cloned())
                .flatten()
        })
        .expect("get_messages response");
    assert_eq!(messages.len(), 5);
    assert_eq!(
        messages[1].get("role").and_then(Value::as_str),
        Some("assistant")
    );
    assert_eq!(
        messages[1]
            .get("content")
            .and_then(Value::as_array)
            .map(Vec::len),
        Some(3)
    );
}

#[test]
fn dialogs_cover_every_method_and_reject_bad_bodies() {
    let lines = fixture::lines("dialogs").unwrap();
    let mut methods = BTreeSet::new();
    for line in &lines {
        let value: Value = serde_json::from_str(line).unwrap();
        if value.get("type").and_then(Value::as_str) != Some("extension_ui_request") {
            continue;
        }
        let raw: &serde_json::value::RawValue = serde_json::from_str(line).unwrap();
        let request = dialog::parse(raw).unwrap();
        methods.insert(match request.method {
            Method::Select { .. } => "select",
            Method::Confirm { .. } => "confirm",
            Method::Input { .. } => "input",
            Method::Editor { .. } => "editor",
            Method::Ask { .. } => "ask",
            Method::Cancel { .. } => "cancel",
            Method::Notify { .. } => "notify",
            Method::SetStatus { .. } => "setStatus",
            Method::SetWidget { .. } => "setWidget",
            Method::SetTitle { .. } => "setTitle",
            Method::SetEditorText { .. } => "set_editor_text",
            Method::OpenUrl { .. } => "open_url",
            Method::Unknown { .. } => "unknown",
        });
    }
    for expected in dialog::KNOWN_METHODS {
        assert!(methods.contains(expected), "missing method {expected}");
    }

    let bad =
        br#"{"type":"extension_ui_request","id":"x","method":"select","title":"t","options":"no"}"#;
    assert!(dialog::parse(serde_json::from_slice(bad).unwrap()).is_err());
}

#[test]
fn every_command_fixture_is_enabled_and_valid() {
    let lines = fixture::lines("commands").unwrap();
    for line in &lines {
        command::validate(line).unwrap_or_else(|error| panic!("{error}: {line}"));
    }
    let kinds: BTreeSet<String> = lines
        .iter()
        .map(|line| command::validate(line).unwrap().kind)
        .collect();
    assert!(kinds.contains("prompt"));
    assert!(kinds.contains("abort_and_restore_queue"));
    assert!(kinds.contains("extension_ui_response"));
}

#[test]
fn unknown_frames_are_surfaced_and_malformed_ones_rejected() {
    let frames = parsed("unknown");
    let future = frames
        .iter()
        .find(|frame| frame.kind == "future_frame_kind")
        .expect("future frame");
    assert_eq!(future.class, Class::Unknown);
    assert!(future.raw.contains("not yet negotiated"));

    assert!(frames.iter().any(|frame| frame.kind == "rpc_frame_error"));
    assert!(
        frames
            .iter()
            .any(|frame| frame.class == Class::Response
                && !frame.frame().response().unwrap().success)
    );
    assert!(
        frames
            .iter()
            .any(|frame| frame.kind == "subagent_lifecycle")
    );

    let error = frame::parse(r#"{"type":"agent_start"},"op":"thread_removed""#).unwrap_err();
    assert!(matches!(error, FrameError::NotObject(_)));
    assert!(frame::parse(r#"{"type":"response","success":true}"#).is_err());
}

#[test]
fn chunk_plan_reassembles_the_documented_logical_frame() {
    const TARGET: usize = 1_101_005;
    const SEED: &str = "omp-console-chunk-fixture-v1:";
    let prefix = br#"{"type":"fixture_padding","pad":""#;
    let suffix = br#""}"#;
    let pad = TARGET - prefix.len() - suffix.len();
    let mut logical = prefix.to_vec();
    logical.extend(
        std::iter::repeat_n(SEED.as_bytes(), pad.div_ceil(SEED.len()))
            .flatten()
            .take(pad),
    );
    logical.extend_from_slice(suffix);
    assert_eq!(logical.len(), TARGET);

    let count = logical.len().div_ceil(CHUNK_PAYLOAD);
    assert_eq!(count, 5);
    let mut reassembler = Reassembler::new(MAX_REASSEMBLED_FRAME);
    for index in 0..count {
        let start = index * CHUNK_PAYLOAD;
        let end = (start + CHUNK_PAYLOAD).min(logical.len());
        let line = serde_json::json!({
            "type": "rpc_chunk",
            "chunkId": "fixture-chunk-1",
            "index": index,
            "count": count,
            "byteLength": logical.len(),
            "data": BASE64.encode(&logical[start..end]),
        })
        .to_string();
        let feed = reassembler.feed(line.as_bytes()).unwrap();
        if index + 1 == count {
            assert_eq!(feed, Feed::Done(logical.clone()));
        } else {
            assert_eq!(feed, Feed::Pending);
        }
    }
}
