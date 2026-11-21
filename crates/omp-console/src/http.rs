use axum::Router;
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;

use crate::api;
use crate::assets;
use crate::state::AppState;
use crate::ws;

const CSP: &str = "default-src 'self'; img-src 'self' data: blob:; \
style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; \
object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/ws", get(ws::ws_handler))
        .nest("/api", api::routes())
        .fallback(static_handler)
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

fn secure(mut response: Response) -> Response {
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
        HeaderValue::from_static(CSP),
    );
    response
}

fn reject(status: StatusCode, message: &'static str) -> Response {
    secure((status, message).into_response())
}

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
    let Some(host) = host else {
        return reject(StatusCode::MISDIRECTED_REQUEST, "unrecognized Host header");
    };
    if !state.cfg.host_allowed(&host) {
        return reject(StatusCode::MISDIRECTED_REQUEST, "unrecognized Host header");
    }

    if request
        .headers()
        .get("sec-fetch-site")
        .and_then(|value| value.to_str().ok())
        == Some("cross-site")
    {
        return reject(StatusCode::FORBIDDEN, "cross-site request rejected");
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
        && !state.cfg.origin_allowed(origin)
    {
        return reject(StatusCode::FORBIDDEN, "origin not allowed");
    }

    secure(next.run(request).await)
}

async fn health() -> &'static str {
    "ok"
}

fn accepts_html(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("text/html") || value.contains("*/*"))
}

async fn static_handler(State(state): State<AppState>, uri: Uri, headers: HeaderMap) -> Response {
    let response = assets::serve(&state.cfg, uri.path(), accepts_html(&headers)).await;
    secure(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use std::sync::Arc;
    use tower::ServiceExt;

    use crate::config::Config;

    fn app() -> Router {
        let cfg = Arc::new(Config::for_test(std::env::temp_dir()));
        router(AppState::for_test(cfg))
    }

    async fn status(request: Request) -> StatusCode {
        app().oneshot(request).await.unwrap().status()
    }

    #[tokio::test]
    async fn accepts_allowed_host_and_sets_security_headers() {
        let response = app()
            .oneshot(
                Request::builder()
                    .uri("/healthz")
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
    async fn rejects_foreign_host_and_cross_site_writes() {
        assert_eq!(
            status(
                Request::builder()
                    .uri("/api/info")
                    .header("host", "evil.example:8787")
                    .body(Body::empty())
                    .unwrap()
            )
            .await,
            StatusCode::MISDIRECTED_REQUEST
        );
        assert_eq!(
            status(
                Request::builder()
                    .method("POST")
                    .uri("/api/threads")
                    .header("host", "127.0.0.1:8787")
                    .header("origin", "http://evil.example")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"cwd":"/"}"#))
                    .unwrap()
            )
            .await,
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn rejects_cross_site_websocket_upgrade() {
        assert_eq!(
            status(
                Request::builder()
                    .uri("/ws")
                    .header("host", "127.0.0.1:8787")
                    .header("origin", "http://evil.example")
                    .header("connection", "Upgrade")
                    .header("upgrade", "websocket")
                    .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
                    .header("sec-websocket-version", "13")
                    .body(Body::empty())
                    .unwrap()
            )
            .await,
            StatusCode::FORBIDDEN
        );
    }
}
