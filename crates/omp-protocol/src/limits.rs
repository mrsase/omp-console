//! Every protocol-facing limit in one place. Values mirror `omp`'s encoder:
//! `MAX_RPC_FRAME_BYTES` (including the newline), `MAX_RPC_REASSEMBLED_BYTES`,
//! and the 256 KiB chunk payload.

/// Largest physical JSONL line, including its trailing newline.
pub const MAX_PHYSICAL_FRAME: usize = 1024 * 1024;
/// Largest logical frame after reassembly.
pub const MAX_REASSEMBLED_FRAME: usize = 64 * 1024 * 1024;
/// Raw bytes carried by one `rpc_chunk` before base64 encoding.
pub const CHUNK_PAYLOAD: usize = 256 * 1024;
/// `omp` refuses more chunks than this.
pub const MAX_CHUNK_COUNT: usize = MAX_REASSEMBLED_FRAME.div_ceil(CHUNK_PAYLOAD);
/// Largest command the browser may send to a child.
pub const MAX_COMMAND: usize = 1024 * 1024;
/// Attachments per prompt.
pub const MAX_IMAGES: usize = 4;
/// Dialog ids, chunk ids, and command ids share this ceiling.
pub const MAX_ID: usize = 128;

/// The largest content a line reader may accumulate, excluding the newline.
///
/// `advertised` is `ready.maxFrameBytes`. A child may advertise less; a larger
/// value is clamped so a misbehaving child cannot raise the ceiling.
pub fn max_line_bytes(advertised: Option<usize>) -> usize {
    advertised
        .unwrap_or(MAX_PHYSICAL_FRAME)
        .clamp(4096, 16 * MAX_PHYSICAL_FRAME)
        .saturating_sub(1)
}

/// The reassembly ceiling from `ready.maxReassembledFrameBytes`.
pub fn max_reassembled_bytes(advertised: Option<usize>) -> usize {
    advertised
        .unwrap_or(MAX_REASSEMBLED_FRAME)
        .clamp(MAX_PHYSICAL_FRAME, MAX_REASSEMBLED_FRAME)
}
