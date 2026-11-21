use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use omp_console::config::Config;
use omp_console::state::AppState;
use serde_json::Value;
use tower::ServiceExt;

fn app(root: &std::path::Path) -> axum::Router {
    let mut cfg = Config::for_test(root.to_path_buf());
    cfg.session_root = root.to_path_buf();
    omp_console::router(AppState::for_test(Arc::new(cfg)))
}

fn get(path: &str) -> Request<Body> {
    Request::builder()
        .uri(path)
        .header(header::HOST, "127.0.0.1:8787")
        .header(header::ACCEPT, "application/json")
        .body(Body::empty())
        .unwrap()
}

async fn json(response: axum::response::Response) -> Value {
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn info_reports_limits_and_assets() {
    let root = tempfile::tempdir().unwrap();
    let response = app(root.path()).oneshot(get("/api/info")).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json(response).await;
    assert_eq!(body["maxThreads"], 2);
    assert_eq!(body["omp"]["supported"], true);
    assert_eq!(body["staticReady"], true);
    assert_eq!(body["sessionRoot"], root.path().display().to_string());
}

#[tokio::test]
async fn threads_start_empty_and_unknown_ids_are_404() {
    let root = tempfile::tempdir().unwrap();
    let response = app(root.path()).oneshot(get("/api/threads")).await.unwrap();
    assert_eq!(json(response).await, serde_json::json!([]));

    let response = app(root.path())
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/threads/nope")
                .header(header::HOST, "127.0.0.1:8787")
                .header(header::ORIGIN, "http://127.0.0.1:8787")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn folder_browse_is_read_only_and_lists_directories_first() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("alpha")).unwrap();
    std::fs::write(root.path().join("beta.txt"), "x").unwrap();
    let path = format!("/api/fs?path={}", root.path().display());
    let response = app(root.path()).oneshot(get(&path)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json(response).await;
    let entries = body["entries"].as_array().unwrap();
    assert_eq!(entries[0]["name"], "alpha");
    assert_eq!(entries[0]["isDir"], true);
    assert_eq!(entries[1]["name"], "beta.txt");
}

#[tokio::test]
async fn root_serves_html_and_unknown_api_is_json_404() {
    let root = tempfile::tempdir().unwrap();
    let response = app(root.path())
        .oneshot(
            Request::builder()
                .uri("/")
                .header(header::HOST, "127.0.0.1:8787")
                .header(header::ACCEPT, "text/html")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response
            .headers()
            .get(header::CONTENT_TYPE)
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("text/html")
    );

    let response = app(root.path()).oneshot(get("/api/nope")).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert!(json(response).await["error"].is_string());
}

#[tokio::test]
async fn recent_is_empty_for_a_fresh_root_and_rejects_traversal_resume() {
    let root = tempfile::tempdir().unwrap();
    let response = app(root.path())
        .oneshot(get("/api/recent?limit=5"))
        .await
        .unwrap();
    assert_eq!(json(response).await, serde_json::json!([]));

    let response = app(root.path())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/threads")
                .header(header::HOST, "127.0.0.1:8787")
                .header(header::ORIGIN, "http://127.0.0.1:8787")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"resume":"../../etc/passwd"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}
