//! The omp RPC wire contract.
//!
//! This crate owns frame classification, protocol-v2 chunk reassembly, the
//! outbound command allowlist, dialog shapes, and the supported `omp` range.
//! It has no async runtime, no filesystem walks, and no UI: the server and the
//! TypeScript reducer both consume the same rules.
//!
//! The governing rule is ADR 0001: **known types are validated, unknown types
//! are preserved and surfaced, and malformed input never disappears silently.**

pub mod chunk;
pub mod command;
pub mod dialog;
pub mod fixture;
pub mod frame;
pub mod limits;
pub mod version;

pub use chunk::{ChunkError, Feed, Reassembler};
pub use command::{ALLOWED, Command, CommandError};
pub use dialog::{Method, Question, UiRequest, UiResponse};
pub use frame::{Class, Frame, FrameError, PromptResult, PromptStatus, Ready, ResponseMeta};
pub use version::{Support, Version};
