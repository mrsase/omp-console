//! The extension UI sub-protocol: requests the child sends, and the shape of
//! the answers it accepts.
//!
//! `omp` owns the deadline. The console renders the request and answers it; a
//! `cancel` from the child closes a dialog that is already resolved.

use serde_json::Value;
use serde_json::value::RawValue;

use crate::frame::FrameError;
use crate::limits::MAX_ID;

pub const KNOWN_METHODS: &[&str] = &[
    "select",
    "confirm",
    "input",
    "editor",
    "ask",
    "cancel",
    "notify",
    "setStatus",
    "setWidget",
    "setTitle",
    "set_editor_text",
    "open_url",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OptionRow {
    pub label: String,
    pub description: Option<String>,
    pub preview: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    pub id: String,
    pub question: String,
    pub header: Option<String>,
    pub options: Vec<OptionRow>,
    pub multi: bool,
    pub recommended: Option<usize>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Method {
    Select {
        title: String,
        options: Vec<String>,
        details: Vec<Option<String>>,
        timeout: Option<u64>,
    },
    Confirm {
        title: String,
        message: String,
        timeout: Option<u64>,
    },
    Input {
        title: String,
        placeholder: Option<String>,
        secret: bool,
        timeout: Option<u64>,
    },
    Editor {
        title: String,
        prefill: Option<String>,
        prompt_style: bool,
    },
    Ask {
        questions: Vec<Question>,
        timeout: Option<u64>,
    },
    Cancel {
        target_id: String,
    },
    Notify {
        message: String,
        level: String,
    },
    SetStatus {
        key: String,
        text: Option<String>,
    },
    SetWidget {
        key: String,
        lines: Option<Vec<String>>,
        placement: Option<String>,
    },
    SetTitle {
        title: String,
    },
    SetEditorText {
        text: String,
    },
    OpenUrl {
        url: String,
        launch_url: Option<String>,
        instructions: Option<String>,
    },
    Unknown {
        method: String,
    },
}

#[derive(Debug, Clone)]
pub struct UiRequest<'a> {
    pub id: String,
    pub method: Method,
    pub raw: &'a RawValue,
}

fn invalid(kind: &str, message: impl Into<String>) -> FrameError {
    FrameError::Invalid {
        kind: kind.into(),
        message: message.into(),
    }
}

fn obj<'a>(value: &'a Value, what: &str) -> Result<&'a serde_json::Map<String, Value>, FrameError> {
    value
        .as_object()
        .ok_or_else(|| invalid("extension_ui_request", format!("{what} must be an object")))
}

fn text(value: &Value, key: &str) -> Result<String, FrameError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| invalid("extension_ui_request", format!("`{key}` must be a string")))
}

fn opt_text(value: &Value, key: &str) -> Result<Option<String>, FrameError> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(invalid(
            "extension_ui_request",
            format!("`{key}` must be a string when present"),
        )),
    }
}

fn opt_u64(value: &Value, key: &str) -> Result<Option<u64>, FrameError> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => number
            .as_u64()
            .map(Some)
            .ok_or_else(|| invalid("extension_ui_request", format!("`{key}` must be u64"))),
        Some(_) => Err(invalid(
            "extension_ui_request",
            format!("`{key}` must be a number"),
        )),
    }
}

fn opt_bool(value: &Value, key: &str) -> Result<bool, FrameError> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(flag)) => Ok(*flag),
        Some(_) => Err(invalid(
            "extension_ui_request",
            format!("`{key}` must be a boolean"),
        )),
    }
}

fn strings(value: Option<&Value>, key: &str) -> Result<Vec<String>, FrameError> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str().map(str::to_owned).ok_or_else(|| {
                    invalid(
                        "extension_ui_request",
                        format!("`{key}` must contain only strings"),
                    )
                })
            })
            .collect(),
        Some(_) => Err(invalid(
            "extension_ui_request",
            format!("`{key}` must be an array"),
        )),
    }
}

fn parse_question(value: &Value) -> Result<Question, FrameError> {
    let id = text(value, "id")?;
    if id.is_empty() || id.len() > MAX_ID {
        return Err(invalid("ask", "question id is empty or too long"));
    }
    let question = text(value, "question")?;
    let options = match value.get("options") {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                let _ = obj(item, "option")?;
                let label = text(item, "label")?;
                if label.is_empty() {
                    return Err(invalid("ask", "option label is empty"));
                }
                let description = opt_text(item, "description")?;
                let preview = opt_text(item, "preview")?;
                Ok(OptionRow {
                    label,
                    description,
                    preview,
                })
            })
            .collect::<Result<Vec<_>, FrameError>>()?,
        _ => return Err(invalid("ask", "`options` must be an array")),
    };
    if options.is_empty() {
        return Err(invalid("ask", "a question needs at least one option"));
    }
    let recommended = opt_u64(value, "recommended")?;
    if let Some(index) = recommended
        && index as usize >= options.len()
    {
        return Err(invalid("ask", "`recommended` is outside the options"));
    }
    Ok(Question {
        id,
        question,
        header: opt_text(value, "header")?,
        options,
        multi: opt_bool(value, "multi")?,
        recommended: recommended.map(|index| index as usize),
    })
}

/// Validate and decode one `extension_ui_request`. Unknown methods are kept
/// (the UI surfaces them as raw evidence), not rejected.
pub fn parse<'a>(raw: &'a RawValue) -> Result<UiRequest<'a>, FrameError> {
    let value: Value = serde_json::from_str(raw.get())
        .map_err(|error| invalid("extension_ui_request", format!("invalid body: {error}")))?;
    obj(&value, "the request")?;
    let id = text(&value, "id")?;
    if id.is_empty() || id.len() > MAX_ID {
        return Err(invalid("extension_ui_request", "id is empty or too long"));
    }
    let name = text(&value, "method")?;
    let method = match name.as_str() {
        "select" => {
            let options = strings(value.get("options"), "options")?;
            let details = match value.get("optionDetails") {
                None | Some(Value::Null) => vec![None; options.len()],
                Some(Value::Array(items)) => items
                    .iter()
                    .map(|item| opt_text(item, "description"))
                    .collect::<Result<Vec<_>, _>>()?,
                Some(_) => {
                    return Err(invalid("select", "`optionDetails` must be an array"));
                }
            };
            Method::Select {
                title: text(&value, "title")?,
                options,
                details,
                timeout: opt_u64(&value, "timeout")?,
            }
        }
        "confirm" => Method::Confirm {
            title: text(&value, "title")?,
            message: text(&value, "message")?,
            timeout: opt_u64(&value, "timeout")?,
        },
        "input" => Method::Input {
            title: text(&value, "title")?,
            placeholder: opt_text(&value, "placeholder")?,
            secret: opt_bool(&value, "secret")?,
            timeout: opt_u64(&value, "timeout")?,
        },
        "editor" => Method::Editor {
            title: text(&value, "title")?,
            prefill: opt_text(&value, "prefill")?,
            prompt_style: opt_bool(&value, "promptStyle")?,
        },
        "ask" => {
            let questions = match value.get("questions") {
                Some(Value::Array(items)) if !items.is_empty() => items
                    .iter()
                    .map(parse_question)
                    .collect::<Result<Vec<_>, _>>()?,
                _ => return Err(invalid("ask", "`questions` must be a non-empty array")),
            };
            Method::Ask {
                questions,
                timeout: opt_u64(&value, "timeout")?,
            }
        }
        "cancel" => Method::Cancel {
            target_id: text(&value, "targetId")?,
        },
        "notify" => Method::Notify {
            message: text(&value, "message")?,
            level: opt_text(&value, "notifyType")?.unwrap_or_else(|| "info".into()),
        },
        "setStatus" => Method::SetStatus {
            key: text(&value, "statusKey")?,
            text: opt_text(&value, "statusText")?,
        },
        "setWidget" => Method::SetWidget {
            key: text(&value, "widgetKey")?,
            lines: match value.get("widgetLines") {
                None | Some(Value::Null) => None,
                Some(_) => Some(strings(value.get("widgetLines"), "widgetLines")?),
            },
            placement: opt_text(&value, "widgetPlacement")?,
        },
        "setTitle" => Method::SetTitle {
            title: text(&value, "title")?,
        },
        "set_editor_text" => Method::SetEditorText {
            text: text(&value, "text")?,
        },
        "open_url" => {
            let url = text(&value, "url")?;
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return Err(invalid("open_url", "url must be http(s)"));
            }
            Method::OpenUrl {
                url,
                launch_url: opt_text(&value, "launchUrl")?,
                instructions: opt_text(&value, "instructions")?,
            }
        }
        other => Method::Unknown {
            method: other.to_owned(),
        },
    };
    Ok(UiRequest { id, method, raw })
}

/// Used by `frame::parse`, which already holds the `RawValue`.
pub(crate) fn validate_request(raw: &RawValue) -> Result<(), FrameError> {
    parse(raw).map(|_| ())
}

/// An answer as the child accepts it. Exactly one variant, by construction.
#[derive(Debug, Clone, PartialEq)]
pub enum UiResponse {
    Value(String),
    Confirmed(bool),
    Answers(Vec<Answer>),
    Cancelled { timed_out: bool },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answer {
    pub id: String,
    pub selected_options: Vec<String>,
    pub custom_input: Option<String>,
}

impl UiResponse {
    /// The answer payload for a request method. `omp` ignores a mismatched
    /// payload, so the console refuses to send one.
    pub fn valid_for(&self, method: &Method) -> bool {
        matches!(
            (self, method),
            (
                Self::Value(_),
                Method::Select { .. } | Method::Input { .. } | Method::Editor { .. }
            ) | (Self::Confirmed(_), Method::Confirm { .. })
                | (Self::Answers(_), Method::Ask { .. })
                | (Self::Cancelled { .. }, _)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(text: &str) -> Box<RawValue> {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn parses_approval_select() {
        let request = raw(
            r#"{"type":"extension_ui_request","id":"ui-1","method":"select","title":"Allow tool: bash\nCommand: echo hi","options":["Approve","Approve bash for this session","Deny"]}"#,
        );
        let parsed = parse(&request).unwrap();
        assert_eq!(parsed.id, "ui-1");
        assert!(matches!(parsed.method, Method::Select { ref options, .. } if options.len() == 3));
    }

    #[test]
    fn parses_rich_ask_and_bounds_recommended() {
        let ok = raw(
            r#"{"type":"extension_ui_request","id":"q","method":"ask","questions":[{"id":"s","question":"Store?","options":[{"label":"SQLite"},{"label":"Redis"}],"recommended":0}]}"#,
        );
        assert!(parse(&ok).is_ok());
        let bad = raw(
            r#"{"type":"extension_ui_request","id":"q","method":"ask","questions":[{"id":"s","question":"Store?","options":[{"label":"SQLite"}],"recommended":3}]}"#,
        );
        assert!(parse(&bad).is_err());
    }

    #[test]
    fn rejects_bad_open_url_and_keeps_unknown_methods() {
        let bad = raw(
            r#"{"type":"extension_ui_request","id":"u","method":"open_url","url":"file:///etc/passwd"}"#,
        );
        assert!(parse(&bad).is_err());
        let unknown =
            raw(r#"{"type":"extension_ui_request","id":"u","method":"future_dialog","x":1}"#);
        assert!(matches!(
            parse(&unknown).unwrap().method,
            Method::Unknown { .. }
        ));
    }

    #[test]
    fn answer_matches_method() {
        assert!(UiResponse::Confirmed(true).valid_for(&Method::Confirm {
            title: "x".into(),
            message: "y".into(),
            timeout: None
        }));
        assert!(!UiResponse::Value("x".into()).valid_for(&Method::Confirm {
            title: "x".into(),
            message: "y".into(),
            timeout: None
        }));
    }
}
