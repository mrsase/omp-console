//! Protocol v2 `rpc_chunk` reassembly with `omp`'s own acceptance rules.
//!
//! A real chunk sequence only exists for a logical frame above one physical
//! line, so every bound here is strict on purpose: a sequence that the real
//! encoder would never produce is rejected rather than half-forwarded.

use std::fmt;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::Deserialize;
use serde_json::value::RawValue;

use crate::limits::{
    CHUNK_PAYLOAD, MAX_CHUNK_COUNT, MAX_ID, MAX_PHYSICAL_FRAME, MAX_REASSEMBLED_FRAME,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkError(String);

impl ChunkError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }

    pub fn message(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ChunkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ChunkError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Feed {
    /// Not a chunk; the caller forwards the line.
    Pass,
    /// A chunk was accepted; wait for the rest.
    Pending,
    /// A complete logical frame.
    Done(Vec<u8>),
    /// A chunk sequence was interrupted by a non-chunk line; it was dropped
    /// and the caller forwards this line.
    Interrupted,
}

#[derive(Deserialize)]
struct Probe<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Chunk {
    chunk_id: String,
    index: usize,
    count: usize,
    byte_length: usize,
    data: String,
}

struct State {
    id: String,
    count: usize,
    byte_length: usize,
    next: usize,
    data: Vec<u8>,
}

pub struct Reassembler {
    state: Option<State>,
    max: usize,
}

impl Default for Reassembler {
    fn default() -> Self {
        Self::new(MAX_REASSEMBLED_FRAME)
    }
}

impl Reassembler {
    pub fn new(max: usize) -> Self {
        Self {
            state: None,
            max: max.clamp(MAX_PHYSICAL_FRAME, MAX_REASSEMBLED_FRAME),
        }
    }

    pub fn set_max(&mut self, max: usize) {
        self.max = max.clamp(MAX_PHYSICAL_FRAME, MAX_REASSEMBLED_FRAME);
    }

    pub fn reset(&mut self) {
        self.state = None;
    }

    pub fn pending(&self) -> bool {
        self.state.is_some()
    }

    fn decode(data: &str) -> Result<Vec<u8>, ChunkError> {
        if data.is_empty() {
            return Err(ChunkError::new("invalid rpc chunk data"));
        }
        let bytes = BASE64
            .decode(data.as_bytes())
            .map_err(|_| ChunkError::new("invalid rpc chunk data"))?;
        if BASE64.encode(&bytes) != data {
            return Err(ChunkError::new("invalid rpc chunk data"));
        }
        Ok(bytes)
    }

    pub fn feed(&mut self, line: &[u8]) -> Result<Feed, ChunkError> {
        let probe: Probe<'_> = serde_json::from_slice(line)
            .map_err(|error| ChunkError::new(format!("invalid rpc frame: {error}")))?;
        if probe.kind != "rpc_chunk" {
            return Ok(if self.state.take().is_some() {
                Feed::Interrupted
            } else {
                Feed::Pass
            });
        }

        let chunk: Chunk = serde_json::from_slice(line)
            .map_err(|error| ChunkError::new(format!("invalid rpc chunk: {error}")))?;
        if chunk.chunk_id.is_empty() || chunk.chunk_id.len() > MAX_ID {
            self.state = None;
            return Err(ChunkError::new("invalid rpc chunk metadata: chunkId"));
        }
        if chunk.count < 2 || chunk.count > MAX_CHUNK_COUNT || chunk.index >= chunk.count {
            self.state = None;
            return Err(ChunkError::new("invalid rpc chunk metadata: index/count"));
        }
        if chunk.byte_length < MAX_PHYSICAL_FRAME || chunk.byte_length > self.max {
            self.state = None;
            return Err(ChunkError::new(format!(
                "rpc chunk byteLength {} is outside {}..={}",
                chunk.byte_length, MAX_PHYSICAL_FRAME, self.max
            )));
        }
        let bytes = match Self::decode(&chunk.data) {
            Ok(bytes) => bytes,
            Err(error) => {
                self.state = None;
                return Err(error);
            }
        };
        if bytes.len() > CHUNK_PAYLOAD {
            self.state = None;
            return Err(ChunkError::new("rpc chunk payload exceeds 256 KiB"));
        }

        if self.state.is_none() {
            if chunk.index != 0 {
                return Err(ChunkError::new("rpc chunk sequence must start at index 0"));
            }
            self.state = Some(State {
                id: chunk.chunk_id.clone(),
                count: chunk.count,
                byte_length: chunk.byte_length,
                next: 0,
                data: Vec::with_capacity(chunk.byte_length.min(MAX_PHYSICAL_FRAME)),
            });
        }

        {
            let state = self.state.as_ref().expect("state initialized");
            if state.id != chunk.chunk_id {
                self.state = None;
                return Err(ChunkError::new("rpc chunk sequence mismatch: chunkId"));
            }
            if state.count != chunk.count {
                self.state = None;
                return Err(ChunkError::new("rpc chunk sequence mismatch: count"));
            }
            if state.byte_length != chunk.byte_length {
                self.state = None;
                return Err(ChunkError::new("rpc chunk sequence mismatch: byteLength"));
            }
            if state.next != chunk.index {
                self.state = None;
                return Err(ChunkError::new("rpc chunk sequence mismatch: index order"));
            }
            if state.data.len() + bytes.len() > state.byte_length {
                self.state = None;
                return Err(ChunkError::new(
                    "rpc chunk sequence exceeds declared length",
                ));
            }
        }

        let state = self.state.as_mut().expect("state initialized");
        state.data.extend_from_slice(&bytes);
        state.next += 1;
        if state.next < state.count {
            return Ok(Feed::Pending);
        }

        let state = self.state.take().expect("state initialized");
        if state.data.len() != state.byte_length {
            return Err(ChunkError::new(format!(
                "rpc chunk sequence length mismatch: {} != {}",
                state.data.len(),
                state.byte_length
            )));
        }
        let text = std::str::from_utf8(&state.data)
            .map_err(|_| ChunkError::new("reassembled frame is not valid UTF-8"))?;
        let raw: &RawValue = serde_json::from_str(text)
            .map_err(|error| ChunkError::new(format!("reassembled frame is not JSON: {error}")))?;
        if !raw.get().trim_start().starts_with('{') {
            return Err(ChunkError::new("reassembled frame is not a JSON object"));
        }
        Ok(Feed::Done(state.data))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn chunk(id: &str, index: usize, count: usize, total: usize, data: &[u8]) -> Vec<u8> {
        json!({
            "type": "rpc_chunk",
            "chunkId": id,
            "index": index,
            "count": count,
            "byteLength": total,
            "data": BASE64.encode(data),
        })
        .to_string()
        .into_bytes()
    }

    fn logical(extra: usize) -> Vec<u8> {
        let mut body =
            br#"{"type":"response","command":"get_messages","success":true,"data":{"pad":""#
                .to_vec();
        body.extend(std::iter::repeat_n(b'x', extra));
        body.extend_from_slice(br#""}}"#);
        assert!(body.len() >= MAX_PHYSICAL_FRAME);
        body
    }

    fn feed_payload(payload: &[u8]) -> Vec<Result<Feed, ChunkError>> {
        let mut r = Reassembler::new(MAX_REASSEMBLED_FRAME);
        let count = payload.len().div_ceil(CHUNK_PAYLOAD);
        payload
            .chunks(CHUNK_PAYLOAD)
            .enumerate()
            .map(|(index, slice)| r.feed(&chunk("c1", index, count, payload.len(), slice)))
            .collect()
    }

    #[test]
    fn reassembles_in_order() {
        let payload = logical(MAX_PHYSICAL_FRAME);
        let feeds = feed_payload(&payload);
        for feed in &feeds[..feeds.len() - 1] {
            assert_eq!(feed.as_ref().unwrap(), &Feed::Pending);
        }
        assert_eq!(
            feeds.last().unwrap().as_ref().unwrap(),
            &Feed::Done(payload)
        );
    }

    #[test]
    fn rejects_count_one_and_short_byte_length() {
        let mut r = Reassembler::new(MAX_REASSEMBLED_FRAME);
        assert!(
            r.feed(&chunk("c1", 0, 1, MAX_PHYSICAL_FRAME, b"ab"))
                .is_err()
        );
        assert!(r.feed(&chunk("c1", 0, 2, 99, b"ab")).is_err());
    }

    #[test]
    fn rejects_out_of_order_and_interleaved_ids() {
        let mut r = Reassembler::new(MAX_REASSEMBLED_FRAME);
        r.feed(&chunk("c1", 0, 3, MAX_PHYSICAL_FRAME + 4, b"ab"))
            .unwrap();
        assert!(
            r.feed(&chunk("c1", 2, 3, MAX_PHYSICAL_FRAME + 4, b"cd"))
                .is_err()
        );
        let mut r = Reassembler::new(MAX_REASSEMBLED_FRAME);
        r.feed(&chunk("c1", 0, 3, MAX_PHYSICAL_FRAME + 4, b"ab"))
            .unwrap();
        assert!(
            r.feed(&chunk("c2", 1, 3, MAX_PHYSICAL_FRAME + 4, b"cd"))
                .is_err()
        );
    }

    #[test]
    fn rejects_bad_base64_and_oversized_chunk() {
        let mut r = Reassembler::new(MAX_REASSEMBLED_FRAME);
        let bad = json!({
            "type": "rpc_chunk",
            "chunkId": "c1",
            "index": 0,
            "count": 2,
            "byteLength": MAX_PHYSICAL_FRAME,
            "data": "!!!",
        })
        .to_string()
        .into_bytes();
        assert!(r.feed(&bad).is_err());

        let mut r = Reassembler::new(MAX_REASSEMBLED_FRAME);
        let payload = vec![0u8; CHUNK_PAYLOAD + 1];
        assert!(
            r.feed(&chunk("c1", 0, 2, MAX_PHYSICAL_FRAME + 1, &payload))
                .is_err()
        );
    }

    #[test]
    fn flags_interrupted_sequences_and_passes_the_line() {
        let mut r = Reassembler::new(MAX_REASSEMBLED_FRAME);
        r.feed(&chunk("c1", 0, 2, MAX_PHYSICAL_FRAME + 4, b"ab"))
            .unwrap();
        assert_eq!(r.feed(br#"{"type":"ready"}"#).unwrap(), Feed::Interrupted);
        assert_eq!(r.feed(br#"{"type":"ready"}"#).unwrap(), Feed::Pass);
    }

    #[test]
    fn rejects_non_utf8_and_non_object_payloads() {
        let mut bad = vec![b'{'];
        bad.extend(std::iter::repeat_n(b'x', MAX_PHYSICAL_FRAME));
        bad.push(0xff);
        let feeds = feed_payload(&bad);
        assert!(feeds.last().unwrap().is_err());

        let mut array = vec![b'['];
        array.extend(std::iter::repeat_n(b'0', MAX_PHYSICAL_FRAME));
        array.push(b']');
        let feeds = feed_payload(&array);
        assert!(feeds.last().unwrap().is_err());
    }
}
