//! The omp-console server: process supervision, HTTP/WS, static assets, session
//! discovery. Protocol shapes live in `omp-protocol`; this crate never defines
//! a second one.

pub mod api;
pub mod assets;
pub mod child;
pub mod config;
pub mod dialogs;
pub mod error;
pub mod fsbrowse;
pub mod http;
pub mod info;
pub mod messages;
pub mod meta;
pub mod ompbin;
pub mod ring;
pub mod sessions;
pub mod state;
pub mod supervisor;
pub mod thread;
pub mod ws;

pub use http::router;
pub use state::AppState;
