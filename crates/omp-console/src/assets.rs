use axum::body::Body;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

use crate::config::Config;

#[derive(RustEmbed)]
#[folder = "../../web/dist/"]
struct Embedded;

fn sanitize(path: &str) -> Option<String> {
    let path = path.trim_start_matches('/');
    if path.is_empty() {
        return Some("index.html".into());
    }
    if path.contains('\\') || path.contains('%') || path.contains('\0') {
        return None;
    }
    if path
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return None;
    }
    Some(path.to_owned())
}

fn response(bytes: Vec<u8>, name: &str) -> Response {
    let mime = mime_guess::from_path(name).first_or_octet_stream();
    let cache = if name.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(header::CACHE_CONTROL, cache)
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Serve one asset. `accepts_html` allows the SPA fallback for client routes.
pub async fn serve(cfg: &Config, path: &str, accepts_html: bool) -> Response {
    let Some(name) = sanitize(path) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    if let Some(dir) = &cfg.static_dir {
        let candidate = dir.join(&name);
        if let Ok(bytes) = tokio::fs::read(&candidate).await {
            return response(bytes, &name);
        }
        if accepts_html
            && !name.starts_with("api/")
            && !name.starts_with("ws")
            && let Ok(bytes) = tokio::fs::read(dir.join("index.html")).await
        {
            return response(bytes, "index.html");
        }
        return StatusCode::NOT_FOUND.into_response();
    }

    if let Some(asset) = Embedded::get(&name) {
        return response(asset.data.into_owned(), &name);
    }
    if accepts_html
        && !name.starts_with("api/")
        && !name.starts_with("ws")
        && let Some(asset) = Embedded::get("index.html")
    {
        return response(asset.data.into_owned(), "index.html");
    }
    StatusCode::NOT_FOUND.into_response()
}

pub fn has_index() -> bool {
    Embedded::get("index.html").is_some()
}

#[cfg(test)]
mod tests {
    use super::sanitize;

    #[test]
    fn rejects_traversal_and_encoded_paths() {
        assert_eq!(sanitize("/").as_deref(), Some("index.html"));
        assert_eq!(sanitize("/assets/a.js").as_deref(), Some("assets/a.js"));
        for bad in ["/../etc/passwd", "/a//b", "/a/%2e%2e/b", "/a\\b", "/a%00b"] {
            assert!(sanitize(bad).is_none(), "{bad}");
        }
    }
}
