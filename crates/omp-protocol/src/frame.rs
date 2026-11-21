//! Frame envelopes: classify one JSONL line without losing anything.
//!
//! The rule the console lives by (ADR 0001): a **known type** with an invalid
//! body is rejected with a notice; an **unknown type** is preserved verbatim
//! and surfaced as evidence. Neither may panic or disappear silently.

use std::fmt;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

/// Session events that `omp` may filter (`set_event_filter`).
pub const SESSION_EVENTS: &[&str] = &[
    "agent_start",
    "agent_end",
    "turn_start",
    "turn_end",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_stream_update",
    "tool_execution_end",
    "auto_compaction_start",
    "auto_compaction_end",
    "manual_compaction_start",
    "manual_compaction_end",
    "auto_retry_start",
    "auto_retry_end",
    "cache_warming_start",
    "cache_warming_end",
    "retry_fallback_applied",
    "retry_fallback_succeeded",
    "model_changed",
    "config_warnings_changed",
    "advisor_cost_changed",
    "advisor_yielded",
    "ttsr_triggered",
    "todo_reminder",
    "todo_auto_clear",
    "irc_message",
    "notice",
    "thinking_level_changed",
    "goal_updated",
    "queue_update",
];

/// Frames that are not session events and are never filtered.
pub const NON_EVENT_TYPES: &[&str] = &[
    "ready",
    "response",
    "prompt_result",
    "session_settled",
    "extension_ui_response",
    "extension_ui_request",
    "extension_error",
    "available_commands_update",
    "session_info_update",
    "command_output",
    "config_update",
    "rpc_frame_error",
    "rpc_chunk",
    "host_tool_call",
    "host_tool_cancel",
    "host_uri_request",
    "host_uri_cancel",
    "subagent_lifecycle",
    "subagent_progress",
    "subagent_event",
    "live_phase",
    "live_levels",
    "live_transcript",
    "live_end",
    "dictation_state",
    "dictation_transcript",
    "dictation_end",
    "btw_delta",
    "btw_record",
];

/// Frames the UI treats as known session events but does not act on.
pub const IGNORED_EVENTS: &[&str] = &[
    "advisor_cost_changed",
    "advisor_yielded",
    "cache_warming_start",
    "cache_warming_end",
    "config_warnings_changed",
    "retry_fallback_applied",
    "retry_fallback_succeeded",
    "ttsr_triggered",
    "goal_updated",
    "irc_message",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    /// Not exactly one JSON object.
    NotObject(String),
    /// A known type whose body does not satisfy its contract.
    Invalid { kind: String, message: String },
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotObject(message) => write!(f, "not a single JSON object: {message}"),
            Self::Invalid { kind, message } => write!(f, "{kind}: {message}"),
        }
    }
}

impl std::error::Error for FrameError {}

#[derive(Deserialize)]
struct Header<'a> {
    #[serde(rename = "type", borrow)]
    kind: &'a str,
    #[serde(default, borrow)]
    id: Option<&'a str>,
}

/// The `ready` frame. `maxFrameBytes` includes the newline.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Ready {
    pub protocol_version: u32,
    #[serde(default)]
    pub supported_protocol_versions: Vec<u32>,
    pub max_frame_bytes: usize,
    pub max_reassembled_frame_bytes: usize,
    #[serde(default)]
    pub supports_bash_exclude_from_context: bool,
}

impl Ready {
    pub fn supports_v2(&self) -> bool {
        self.supported_protocol_versions.contains(&2)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PromptStatus {
    Completed,
    Aborted,
    Error,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromptResult {
    #[serde(default)]
    pub agent_invoked: bool,
    pub status: PromptStatus,
    #[serde(default)]
    pub session_settled: bool,
    #[serde(default)]
    pub error: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResponseMeta {
    pub command: String,
    pub success: bool,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
}

/// What a frame is, as far as the console is concerned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Class {
    Ready,
    Response,
    PromptResult,
    SessionSettled,
    UiRequest,
    Event,
    Ignored,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Typed {
    Ready,
    Response,
    PromptResult,
    None,
}

/// A validated frame. `raw` is always the original line, never a re-encoding.
#[derive(Debug, Clone)]
pub struct Frame<'a> {
    pub kind: &'a str,
    pub id: Option<&'a str>,
    pub class: Class,
    pub typed: Typed,
    pub raw: &'a RawValue,
}

impl<'a> Frame<'a> {
    pub fn ready(&self) -> Option<Ready> {
        (self.typed == Typed::Ready)
            .then(|| typed(self.raw, "ready").ok())
            .flatten()
    }

    pub fn response(&self) -> Option<ResponseMeta> {
        (self.typed == Typed::Response)
            .then(|| typed(self.raw, "response").ok())
            .flatten()
    }

    pub fn prompt_result(&self) -> Option<PromptResult> {
        (self.typed == Typed::PromptResult)
            .then(|| typed(self.raw, "prompt_result").ok())
            .flatten()
    }

    pub fn is_event(&self) -> bool {
        self.class == Class::Event
    }

    pub fn raw_str(&self) -> &'a str {
        self.raw.get()
    }
}

fn typed<T: DeserializeOwned>(raw: &RawValue, kind: &str) -> Result<T, FrameError> {
    serde_json::from_str(raw.get()).map_err(|error| FrameError::Invalid {
        kind: kind.into(),
        message: error.to_string(),
    })
}

/// Parse one line. Unknown types are `Ok(Frame { class: Unknown })`; malformed
/// JSON is `Err(NotObject)`; a bad known body is `Err(Invalid)`.
///
/// The caller keeps the line so it can forward `raw` byte-for-byte.
pub fn parse(line: &str) -> Result<Frame<'_>, FrameError> {
    let trimmed = line.trim();
    if !trimmed.starts_with('{') {
        return Err(FrameError::NotObject("expected an object".into()));
    }
    let raw: &RawValue =
        serde_json::from_str(line).map_err(|error| FrameError::NotObject(error.to_string()))?;
    let header: Header<'_> = serde_json::from_str(raw.get())
        .map_err(|error| FrameError::NotObject(format!("missing or invalid `type`: {error}")))?;
    if header.kind.is_empty() {
        return Err(FrameError::NotObject("empty `type`".into()));
    }

    let (class, typed) = match header.kind {
        "ready" => {
            let ready: Ready = typed(raw, "ready")?;
            if ready.supported_protocol_versions.is_empty() && ready.protocol_version == 0 {
                return Err(FrameError::Invalid {
                    kind: "ready".into(),
                    message: "protocolVersion and supportedProtocolVersions are empty".into(),
                });
            }
            (Class::Ready, Typed::Ready)
        }
        "response" => {
            let meta: ResponseMeta = typed(raw, "response")?;
            if meta.command.is_empty() {
                return Err(FrameError::Invalid {
                    kind: "response".into(),
                    message: "empty `command`".into(),
                });
            }
            (Class::Response, Typed::Response)
        }
        "prompt_result" => {
            typed::<PromptResult>(raw, "prompt_result")?;
            (Class::PromptResult, Typed::PromptResult)
        }
        "session_settled" => (Class::SessionSettled, Typed::None),
        "extension_ui_request" => {
            crate::dialog::validate_request(raw)?;
            (Class::UiRequest, Typed::None)
        }
        kind if SESSION_EVENTS.contains(&kind) => {
            if IGNORED_EVENTS.contains(&kind) {
                (Class::Ignored, Typed::None)
            } else {
                (Class::Event, Typed::None)
            }
        }
        kind if NON_EVENT_TYPES.contains(&kind) => (Class::Event, Typed::None),
        _ => (Class::Unknown, Typed::None),
    };

    Ok(Frame {
        kind: header.kind,
        id: header.id,
        class,
        typed,
        raw,
    })
}

/// Whether the console knows this type at all. Used to count ignored frames
/// separately from unknown ones.
pub fn is_known(kind: &str) -> bool {
    NON_EVENT_TYPES.contains(&kind) || SESSION_EVENTS.contains(&kind)
}

/// Whether a UI request method is one the console can render.
pub fn is_known_ui_method(method: &str) -> bool {
    crate::dialog::KNOWN_METHODS.contains(&method)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ready_and_reports_v2() {
        let line = r#"{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864,"supportsBashExcludeFromContext":true}"#;
        let frame = parse(line).unwrap();
        assert_eq!(frame.class, Class::Ready);
        let ready = frame.ready().unwrap();
        assert!(ready.supports_v2());
        assert_eq!(ready.max_frame_bytes, 1024 * 1024);
    }

    #[test]
    fn classifies_known_ignored_event_and_unknown() {
        assert_eq!(
            parse(r#"{"type":"agent_start"}"#).unwrap().class,
            Class::Event
        );
        assert_eq!(
            parse(r#"{"type":"advisor_cost_changed"}"#).unwrap().class,
            Class::Ignored
        );
        let unknown = parse(r#"{"type":"future_frame","payload":1}"#).unwrap();
        assert_eq!(unknown.class, Class::Unknown);
        assert_eq!(unknown.kind, "future_frame");
    }

    #[test]
    fn rejects_non_objects_and_trailing_garbage() {
        for line in ["[]", "1", "null", "\"ready\"", "", "{\"type\":\"ready\"} x"] {
            assert!(parse(line).is_err(), "{line}");
        }
    }

    #[test]
    fn rejects_envelope_spoof_lines() {
        let spoof = r#"{"type":"agent_start"},"op":"thread_removed","id":"other"}"#;
        assert!(parse(spoof).is_err());
    }

    #[test]
    fn rejects_known_type_with_bad_body() {
        let error = parse(r#"{"type":"response","success":true}"#).unwrap_err();
        assert!(matches!(error, FrameError::Invalid { .. }));
        let error = parse(r#"{"type":"prompt_result","status":"weird"}"#).unwrap_err();
        assert!(matches!(error, FrameError::Invalid { .. }));
    }

    #[test]
    fn keeps_raw_bytes_verbatim() {
        let line = r#"{"type":"agent_start","extra":{"b":1,"a":2}}"#;
        let frame = parse(line).unwrap();
        assert_eq!(frame.raw_str(), line);
    }
}
