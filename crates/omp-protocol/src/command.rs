//! Outbound commands: the one allowlist the browser boundary trusts.
//!
//! The console validates the command's shape, then forwards the original bytes
//! to the child. Large image payloads are never parsed and re-serialized for
//! transport.

use std::fmt;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Map, Value};

use crate::limits::{MAX_COMMAND, MAX_ID, MAX_IMAGES};

/// v1.0 commands. Adding one is a product decision with a test.
pub const ALLOWED: &[&str] = &[
    "prompt",
    "steer",
    "follow_up",
    "remove_queued_message",
    "promote_queued_message",
    "abort",
    "abort_and_restore_queue",
    "set_model",
    "set_thinking_level",
    "set_session_name",
    "new_session",
    "fork",
    "export_html",
    "compact",
    "set_auto_compaction",
    "get_state",
    "get_session_stats",
    "get_messages",
    "get_available_models",
    "get_available_thinking_levels",
    "get_available_commands",
    "extension_ui_response",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandError(String);

impl CommandError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }

    pub fn message(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CommandError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Command<'a> {
    pub kind: String,
    pub id: Option<String>,
    pub raw: &'a str,
}

fn non_empty_text(value: &Value, key: &str) -> Result<String, CommandError> {
    match value.get(key) {
        Some(Value::String(text)) if !text.trim().is_empty() => Ok(text.clone()),
        _ => Err(CommandError::new(format!(
            "`{key}` must be a non-empty string"
        ))),
    }
}

fn optional_text(value: &Value, key: &str) -> Result<Option<String>, CommandError> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(CommandError::new(format!("`{key}` must be a string"))),
    }
}

fn token(value: &str, key: &str) -> Result<(), CommandError> {
    if value.len() > 200 || value.chars().any(char::is_control) {
        return Err(CommandError::new(format!("`{key}` is not a valid token")));
    }
    Ok(())
}

fn validate_images(images: Option<&Value>) -> Result<(), CommandError> {
    let Some(images) = images else {
        return Ok(());
    };
    if images.is_null() {
        return Ok(());
    }
    let items = images
        .as_array()
        .ok_or_else(|| CommandError::new("`images` must be an array"))?;
    if items.len() > MAX_IMAGES {
        return Err(CommandError::new(format!(
            "at most {MAX_IMAGES} images per message"
        )));
    }
    for image in items {
        if image.get("type").and_then(Value::as_str) != Some("image") {
            return Err(CommandError::new("image entries need `type: \"image\"`"));
        }
        let mime = image
            .get("mimeType")
            .and_then(Value::as_str)
            .ok_or_else(|| CommandError::new("image entry needs `mimeType`"))?;
        if !mime.starts_with("image/") {
            return Err(CommandError::new("image `mimeType` must be image/*"));
        }
        let data = image
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| CommandError::new("image entry needs base64 `data`"))?;
        if data.is_empty() {
            return Err(CommandError::new("image `data` is empty"));
        }
        let decoded = BASE64
            .decode(data.as_bytes())
            .map_err(|_| CommandError::new("image `data` is not base64"))?;
        if BASE64.encode(&decoded) != data {
            return Err(CommandError::new("image `data` is not canonical base64"));
        }
    }
    Ok(())
}

fn validate_prompt(object: &Map<String, Value>) -> Result<(), CommandError> {
    let message = object
        .get("message")
        .and_then(Value::as_str)
        .ok_or_else(|| CommandError::new("`message` must be a string"))?;
    let images = object.get("images");
    validate_images(images)?;
    let has_images = images
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty());
    if message.trim().is_empty() && !has_images {
        return Err(CommandError::new("a prompt needs text or an image"));
    }
    if let Some(behavior) = object.get("streamingBehavior") {
        match behavior.as_str() {
            Some("steer" | "followUp") => {}
            _ => {
                return Err(CommandError::new(
                    "`streamingBehavior` must be \"steer\" or \"followUp\"",
                ));
            }
        }
    }
    Ok(())
}

fn validate_answers(value: &Value) -> Result<(), CommandError> {
    let answers = value
        .get("answers")
        .and_then(Value::as_array)
        .ok_or_else(|| CommandError::new("`answers` must be an array"))?;
    if answers.is_empty() || answers.len() > 32 {
        return Err(CommandError::new("`answers` must have 1..=32 entries"));
    }
    for answer in answers {
        non_empty_text(answer, "id")?;
        let selected = answer
            .get("selectedOptions")
            .and_then(Value::as_array)
            .ok_or_else(|| CommandError::new("answer needs `selectedOptions`"))?;
        if selected.len() > 32 || selected.iter().any(|item| item.as_str().is_none()) {
            return Err(CommandError::new(
                "`selectedOptions` must be up to 32 strings",
            ));
        }
        optional_text(answer, "customInput")?;
    }
    Ok(())
}

fn validate_ui_response(value: &Value) -> Result<(), CommandError> {
    non_empty_text(value, "id")?;
    let mut answers = 0;
    if value.get("value").is_some() {
        value
            .get("value")
            .and_then(Value::as_str)
            .ok_or_else(|| CommandError::new("`value` must be a string"))?;
        answers += 1;
    }
    if value.get("confirmed").is_some() {
        if value.get("confirmed").and_then(Value::as_bool).is_none() {
            return Err(CommandError::new("`confirmed` must be a boolean"));
        }
        answers += 1;
    }
    if value.get("answers").is_some() {
        validate_answers(value)?;
        answers += 1;
    }
    if value.get("cancelled").is_some() {
        if value.get("cancelled").and_then(Value::as_bool) != Some(true) {
            return Err(CommandError::new("`cancelled` must be true"));
        }
        answers += 1;
    }
    if answers != 1 {
        return Err(CommandError::new(
            "a dialog response must carry exactly one of value, confirmed, answers, cancelled",
        ));
    }
    Ok(())
}

/// Validate one browser command. The returned `raw` is the exact input.
pub fn validate(raw: &str) -> Result<Command<'_>, CommandError> {
    if raw.len() > MAX_COMMAND {
        return Err(CommandError::new(format!(
            "command exceeds the {MAX_COMMAND}-byte limit"
        )));
    }
    let value: Value = serde_json::from_str(raw)
        .map_err(|error| CommandError::new(format!("invalid command JSON: {error}")))?;
    let object = value
        .as_object()
        .ok_or_else(|| CommandError::new("command must be a JSON object"))?;
    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .filter(|kind| !kind.is_empty())
        .ok_or_else(|| CommandError::new("command needs a non-empty `type`"))?
        .to_owned();
    if !ALLOWED.contains(&kind.as_str()) {
        return Err(CommandError::new(format!(
            "command `{kind}` is not enabled in this console"
        )));
    }
    let id = optional_text(&value, "id")?;
    if let Some(id) = &id
        && (id.is_empty()
            || id.len() > MAX_ID
            || id.starts_with("_omp_")
            || id.chars().any(char::is_control))
    {
        return Err(CommandError::new("invalid or reserved command `id`"));
    }

    match kind.as_str() {
        "prompt" | "steer" | "follow_up" => validate_prompt(object)?,
        "remove_queued_message" => {
            non_empty_text(&value, "message")?;
            match value.get("queue").and_then(Value::as_str) {
                Some("steering" | "followUp") => {}
                _ => {
                    return Err(CommandError::new(
                        "`queue` must be \"steering\" or \"followUp\"",
                    ));
                }
            }
        }
        "promote_queued_message" => {
            non_empty_text(&value, "message")?;
        }
        "set_model" => {
            let provider = non_empty_text(&value, "provider")?;
            let model = non_empty_text(&value, "modelId")?;
            token(&provider, "provider")?;
            token(&model, "modelId")?;
            if provider.contains('/') || model.contains('/') {
                return Err(CommandError::new(
                    "provider and modelId are separate fields",
                ));
            }
        }
        "set_thinking_level" => {
            let level = non_empty_text(&value, "level")?;
            if level.len() > 32
                || !level
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                return Err(CommandError::new("invalid thinking level"));
            }
        }
        "set_session_name" => {
            let name = non_empty_text(&value, "name")?;
            if name.chars().count() > 200 || name.chars().any(char::is_control) {
                return Err(CommandError::new("session name is too long or invalid"));
            }
        }
        "set_auto_compaction" if value.get("enabled").and_then(Value::as_bool).is_none() => {
            return Err(CommandError::new("`enabled` must be a boolean"));
        }
        "set_auto_compaction" => {}
        "new_session" => {
            optional_text(&value, "parentSession")?;
        }
        "fork" => {
            optional_text(&value, "entryId")?;
        }
        "export_html" => {
            optional_text(&value, "outputPath")?;
        }
        "extension_ui_response" => validate_ui_response(&value)?,
        // abort, abort_and_restore_queue, compact, get_*
        _ => {}
    }

    Ok(Command { kind, id, raw })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(raw: &str) {
        validate(raw).unwrap_or_else(|error| panic!("{raw}: {error}"));
    }

    #[test]
    fn accepts_the_enabled_catalog() {
        ok(r#"{"id":"1","type":"abort"}"#);
        ok(r#"{"id":"2","type":"prompt","message":"hi"}"#);
        ok(
            r#"{"id":"3","type":"prompt","message":"","images":[{"type":"image","mimeType":"image/png","data":"YQ=="}]}"#,
        );
        ok(r#"{"id":"4","type":"set_model","provider":"openai","modelId":"gpt"}"#);
        ok(r#"{"id":"5","type":"set_thinking_level","level":"high"}"#);
        ok(r#"{"id":"6","type":"remove_queued_message","message":"x","queue":"followUp"}"#);
        ok(r#"{"type":"extension_ui_response","id":"ui-1","confirmed":true}"#);
        ok(r#"{"type":"extension_ui_response","id":"ui-1","cancelled":true}"#);
    }

    #[test]
    fn rejects_unlisted_commands_and_bad_fields() {
        for raw in [
            r#"{"type":"bash","command":"id"}"#,
            r#"{"type":"switch_session","sessionPath":"/tmp/x"}"#,
            r#"{"type":"set_model","provider":"openai"}"#,
            r#"{"type":"remove_queued_message","message":"x","queue":"later"}"#,
            r#"{"type":"set_auto_compaction","enabled":"yes"}"#,
            r#"{"type":"extension_ui_response","id":"ui-1","value":"x","confirmed":true}"#,
            r#"{"type":"extension_ui_response","id":"ui-1","cancelled":false}"#,
            r#"{"id":"_omp_state","type":"get_state"}"#,
        ] {
            assert!(validate(raw).is_err(), "{raw}");
        }
    }

    #[test]
    fn rejects_bad_images_and_oversized_commands() {
        assert!(validate(r#"{"type":"prompt","message":"x","images":[{"type":"image","mimeType":"image/png","data":"!"}]}"#).is_err());
        let images = [r#"{"type":"image","mimeType":"image/png","data":"YQ=="}"#; 5];
        let raw = format!(
            r#"{{"type":"prompt","message":"x","images":[{}]}}"#,
            images.join(",")
        );
        assert!(validate(&raw).is_err());

        let huge = format!(
            r#"{{"type":"prompt","message":"{}"}}"#,
            "x".repeat(MAX_COMMAND)
        );
        assert!(validate(&huge).is_err());
    }

    #[test]
    fn keeps_raw_bytes_and_id() {
        let raw = r#"{"id":"cmd-9","type":"get_state","extra":true}"#;
        let command = validate(raw).unwrap();
        assert_eq!(command.kind, "get_state");
        assert_eq!(command.id.as_deref(), Some("cmd-9"));
        assert_eq!(command.raw, raw);
    }
}
