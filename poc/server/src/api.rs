use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tower_http::services::{ServeDir, ServeFile};

use crate::error::ApiError;
use crate::fsapi::{self, FsListing};
use crate::recent::RecentSession;
use crate::state::AppState;
use crate::thread::{CreateParams, ThreadInfo};
use crate::ws;

pub fn router(state: AppState) -> Router {
    let static_dir = state.cfg.static_dir.clone();
    let index = static_dir.join("index.html");
    let serve = ServeDir::new(&static_dir).not_found_service(ServeFile::new(index));

    Router::new()
        .route("/healthz", get(health))
        .route("/ws", get(ws::ws_handler))
        .nest("/api", api_routes())
        .fallback_service(serve)
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

/// Rejects requests whose Host/Origin do not belong to this console. Loopback
/// binding alone does not stop DNS rebinding or cross-site WebSocket use.
async fn guard(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_ascii_lowercase())
        .or_else(|| {
            request
                .uri()
                .authority()
                .map(|authority| authority.to_string().to_ascii_lowercase())
        });
    let host_allowed = host.as_deref().is_some_and(|host| {
        state
            .cfg
            .allowed_hosts
            .iter()
            .any(|allowed| allowed == host)
    });
    if !host_allowed {
        return (StatusCode::MISDIRECTED_REQUEST, "unrecognized Host header").into_response();
    }

    if request
        .headers()
        .get("sec-fetch-site")
        .and_then(|value| value.to_str().ok())
        == Some("cross-site")
    {
        return (StatusCode::FORBIDDEN, "cross-site request rejected").into_response();
    }

    let websocket = request
        .headers()
        .get(header::UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
    let state_change = !request.method().is_safe();
    if (websocket || state_change)
        && let Some(origin) = request
            .headers()
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
    {
        let normalized = origin.trim_end_matches('/').to_ascii_lowercase();
        let allowed = normalized != "null"
            && state
                .cfg
                .allowed_origins
                .iter()
                .any(|allowed| allowed == &normalized);
        if !allowed {
            return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
        }
    }

    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        ),
    );
    response
}

fn api_routes() -> Router<AppState> {
    Router::new()
        .route("/info", get(info))
        .route("/threads", get(list_threads).post(create_thread))
        .route("/threads/{id}", delete(delete_thread))
        .route("/threads/{id}/stderr", get(thread_stderr))
        .route("/recent", get(recent_sessions))
        .route("/fs", get(browse))
        .fallback(api_not_found)
}

async fn api_not_found() -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": "unknown API endpoint" })),
    )
}

async fn health() -> &'static str {
    "ok"
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerInfo {
    version: &'static str,
    omp_bin: String,
    home: String,
    cwd: String,
    max_threads: usize,
    session_root: String,
    static_ready: bool,
    addr: String,
}

async fn info(State(state): State<AppState>) -> Json<ServerInfo> {
    Json(ServerInfo {
        version: env!("CARGO_PKG_VERSION"),
        omp_bin: state.cfg.omp_bin.clone(),
        home: state.cfg.home.display().to_string(),
        cwd: state.cfg.server_cwd.display().to_string(),
        max_threads: state.cfg.max_threads,
        session_root: state.cfg.session_root.display().to_string(),
        static_ready: state.cfg.static_dir.join("index.html").is_file(),
        addr: state.cfg.addr.to_string(),
    })
}

async fn list_threads(State(state): State<AppState>) -> Json<Vec<ThreadInfo>> {
    Json(state.threads.list())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateThreadRequest {
    cwd: Option<String>,
    resume: Option<String>,
    model: Option<String>,
    thinking: Option<String>,
}

async fn create_thread(
    State(state): State<AppState>,
    Json(body): Json<CreateThreadRequest>,
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
    let filter = query.cwd.filter(|c| !c.trim().is_empty());
    let sessions = all
        .iter()
        .filter(|s| filter.as_deref().is_none_or(|cwd| s.cwd == cwd))
        .take(limit)
        .cloned()
        .collect();
    Json(sessions)
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
    let path = fsapi::expand(&raw, &state.cfg);
    let listing = tokio::task::spawn_blocking(move || fsapi::listing(&path))
        .await
        .map_err(ApiError::internal)??;
    Ok((StatusCode::OK, Json(listing)))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    use super::*;
    use crate::config::Config;

    fn test_app() -> Router {
        let cfg = Arc::new(Config {
            addr: "127.0.0.1:8787".parse().unwrap(),
            omp_bin: "omp".into(),
            static_dir: PathBuf::from("/nonexistent"),
            session_root: std::env::temp_dir().join("omp-web-test-sessions"),
            max_threads: 1,
            server_cwd: std::env::temp_dir(),
            home: std::env::temp_dir(),
            allowed_hosts: vec!["127.0.0.1:8787".into()],
            allowed_origins: vec!["http://127.0.0.1:8787".into()],
        });
        router(AppState::new(cfg))
    }

    async fn status(request: Request<Body>) -> StatusCode {
        test_app().oneshot(request).await.unwrap().status()
    }

    #[tokio::test]
    async fn accepts_allowed_host_and_sets_security_headers() {
        let response = test_app()
            .oneshot(
                Request::builder()
                    .uri("/api/info")
                    .header("host", "127.0.0.1:8787")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::X_FRAME_OPTIONS).unwrap(),
            "DENY"
        );
        assert!(
            response
                .headers()
                .get(header::CONTENT_SECURITY_POLICY)
                .is_some()
        );
    }

    #[tokio::test]
    async fn rejects_foreign_host() {
        let status = status(
            Request::builder()
                .uri("/api/info")
                .header("host", "evil.example:8787")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::MISDIRECTED_REQUEST);
    }

    #[tokio::test]
    async fn rejects_cross_site_state_change() {
        let status = status(
            Request::builder()
                .method("POST")
                .uri("/api/threads")
                .header("host", "127.0.0.1:8787")
                .header("origin", "http://evil.example")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"cwd":"/"}"#))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn rejects_cross_site_websocket_upgrade() {
        let status = status(
            Request::builder()
                .uri("/ws")
                .header("host", "127.0.0.1:8787")
                .header("origin", "http://evil.example")
                .header("connection", "Upgrade")
                .header("upgrade", "websocket")
                .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
                .header("sec-websocket-version", "13")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
}
