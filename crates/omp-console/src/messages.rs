//! WebSocket envelopes built around an untrusted child frame. The child line is
//! always nested as a JSON value, so it cannot forge top-level keys.

use bytes::Bytes;

pub fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
}

pub fn frame_envelope(thread: &str, raw: &str) -> Bytes {
    let mut out = String::with_capacity(raw.len() + thread.len() + 48);
    out.push_str("{\"op\":\"frame\",\"thread\":");
    out.push_str(&json_string(thread));
    out.push_str(",\"frame\":");
    out.push_str(raw);
    out.push('}');
    Bytes::from(out)
}

pub fn notice_envelope(thread: &str, level: &str, message: &str) -> Bytes {
    Bytes::from(format!(
        "{{\"op\":\"notice\",\"thread\":{},\"level\":{},\"message\":{}}}",
        json_string(thread),
        json_string(level),
        json_string(message)
    ))
}

pub fn lagged_envelope(thread: &str, skipped: u64) -> Bytes {
    Bytes::from(format!(
        "{{\"op\":\"lagged\",\"thread\":{},\"skipped\":{skipped}}}",
        json_string(thread)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_ids_and_keeps_the_frame_verbatim() {
        let frame = frame_envelope("a\"b", r#"{"type":"agent_start"}"#);
        assert_eq!(
            frame.as_ref(),
            br#"{"op":"frame","thread":"a\"b","frame":{"type":"agent_start"}}"#
        );
        let notice = notice_envelope("t", "error", "a\nb");
        assert!(notice.windows(2).any(|window| window == b"\\n"));
    }
}
