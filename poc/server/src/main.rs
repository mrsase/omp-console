mod api;
mod config;
mod error;
mod fsapi;
mod recent;
mod session;
mod state;
mod thread;
mod ws;

use std::sync::Arc;

use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::state::AppState;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("omp_web=info,tower_http=warn")),
        )
        .with_target(false)
        .compact()
        .init();

    let cfg = Arc::new(Config::from_env()?);
    let addr = cfg.addr;
    if !cfg.static_dir.join("index.html").is_file() {
        tracing::warn!(
            "web assets not found at {}; run `bun run build` in web/",
            cfg.static_dir.display()
        );
    }

    let state = AppState::new(cfg);
    {
        let threads = state.threads.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(300));
            loop {
                ticker.tick().await;
                threads.prune_exited(std::time::Duration::from_secs(3600));
            }
        });
    }
    let app = api::router(state.clone());

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("omp-web listening on http://{addr}");
    tracing::info!("omp binary: {}", state.cfg.omp_bin);
    tracing::info!("session root: {}", state.cfg.session_root.display());

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    tracing::info!("shutting down child sessions");
    state.threads.stop_all().await;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
