use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{delete, get};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::assets;
use crate::error::ApiError;
use crate::fsbrowse::{self, FsListing};
use crate::ompbin::OmpProbe;
use crate::sessions::RecentSession;
use crate::state::AppState;
use crate::thread::{CreateParams, ThreadInfo};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/info", get(info))
        .route("/threads", get(list_threads).post(create_thread))
        .route("/threads/{id}", delete(delete_thread))
        .route("/threads/{id}/stderr", get(thread_stderr))
        .route("/recent", get(recent_sessions))
        .route("/fs", get(browse))
        .fallback(not_found)
}

async fn not_found() -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": "unknown API endpoint" })),
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerInfo {
    version: &'static str,
    omp: OmpProbe,
    session_root: String,
    max_threads: usize,
    ws_slots: usize,
    dev: bool,
    static_ready: bool,
    addr: String,
    started_at: u64,
}

async fn info(State(state): State<AppState>) -> Json<ServerInfo> {
    Json(ServerInfo {
        version: env!("CARGO_PKG_VERSION"),
        omp: state.threads.omp().clone(),
        session_root: state.cfg.session_root.display().to_string(),
        max_threads: state.cfg.max_threads,
        ws_slots: state.cfg.ws_slots,
        dev: state.cfg.dev,
        static_ready: assets::has_index()
            || state
                .cfg
                .static_dir
                .as_ref()
                .is_some_and(|dir| dir.join("index.html").is_file()),
        addr: state.cfg.addr.to_string(),
        started_at: state.started_at,
    })
}

async fn list_threads(State(state): State<AppState>) -> Json<Vec<ThreadInfo>> {
    Json(state.threads.list())
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CreateBody {
    cwd: Option<String>,
    resume: Option<String>,
    model: Option<String>,
    thinking: Option<String>,
}

async fn create_thread(
    State(state): State<AppState>,
    Json(body): Json<CreateBody>,
) -> Result<Json<ThreadInfo>, ApiError> {
    let thread = state
        .threads
        .create(CreateParams {
            cwd: body.cwd,
            resume: body.resume,
            model: body.model,
            thinking: body.thinking,
        })
        .await?;
    Ok(Json(thread.info()))
}

async fn delete_thread(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    state.threads.remove(&id).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Serialize)]
struct StderrBody {
    lines: Vec<String>,
}

async fn thread_stderr(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<StderrBody>, ApiError> {
    let thread = state
        .threads
        .get(&id)
        .ok_or_else(|| ApiError::NotFound(format!("no session {id}")))?;
    Ok(Json(StderrBody {
        lines: thread.stderr_lines(),
    }))
}

#[derive(Deserialize)]
struct RecentQuery {
    cwd: Option<String>,
    limit: Option<usize>,
}

async fn recent_sessions(
    State(state): State<AppState>,
    Query(query): Query<RecentQuery>,
) -> Json<Vec<RecentSession>> {
    let all = state.recent.list().await;
    let limit = query.limit.unwrap_or(40).clamp(1, 200);
    let filter = query.cwd.filter(|cwd| !cwd.trim().is_empty());
    Json(
        all.iter()
            .filter(|session| filter.as_deref().is_none_or(|cwd| session.cwd == cwd))
            .take(limit)
            .cloned()
            .collect(),
    )
}

#[derive(Deserialize)]
struct FsQuery {
    path: Option<String>,
}

async fn browse(
    State(state): State<AppState>,
    Query(query): Query<FsQuery>,
) -> Result<(StatusCode, Json<FsListing>), ApiError> {
    let raw = query.path.unwrap_or_else(|| "~".into());
    let path = fsbrowse::expand(&raw, &state.cfg);
    let listing = tokio::task::spawn_blocking(move || fsbrowse::listing(&path))
        .await
        .map_err(ApiError::internal)??;
    Ok((StatusCode::OK, Json(listing)))
}
