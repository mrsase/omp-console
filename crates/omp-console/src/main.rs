use std::sync::Arc;
use std::time::Duration;

use omp_console::config::Config;
use omp_console::ompbin;
use omp_console::state::AppState;
use tracing_subscriber::EnvFilter;

const HELP: &str = "\
omp-console — a local web console for omp sessions

Usage:
  omp-console            serve on 127.0.0.1:8787
  omp-console --version  print the version
  omp-console --help     print this help

Configuration (environment):
  OMP_CONSOLE_ADDR, OMP_BIN, OMP_CONSOLE_SESSIONS, OMP_CONSOLE_MAX_THREADS,
  OMP_CONSOLE_WS_SLOTS, OMP_CONSOLE_ALLOWED_HOSTS, OMP_CONSOLE_ALLOWED_ORIGINS,
  OMP_CONSOLE_DEV, OMP_CONSOLE_ALLOW_REMOTE, OMP_CONSOLE_SKIP_VERSION_CHECK,
  OMP_CONSOLE_STATIC, RUST_LOG
";

fn version() -> String {
    format!("omp-console {}", env!("CARGO_PKG_VERSION"))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--version" || arg == "-V") {
        println!("{}", version());
        return Ok(());
    }
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print!("{HELP}");
        return Ok(());
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("omp_console=info")),
        )
        .with_target(false)
        .compact()
        .init();

    let cfg = match Config::from_env() {
        Ok(cfg) => Arc::new(cfg),
        Err(error) => {
            eprintln!("omp-console: {error}");
            std::process::exit(2);
        }
    };
    let addr = cfg.addr;
    if cfg.allow_remote && !addr.ip().is_loopback() {
        tracing::warn!("binding {addr}: this exposes an unauthenticated console beyond loopback");
    }

    let omp = ompbin::probe(&cfg.omp_bin).await;
    if omp.supported {
        tracing::info!(
            "omp {} at {}",
            omp.version.as_deref().unwrap_or("?"),
            omp.bin
        );
    } else {
        tracing::warn!("{}", omp.message);
    }
    tracing::info!("session root: {}", cfg.session_root.display());
    tracing::info!("assets: {}", cfg.static_dir_name());

    let state = AppState::new(cfg, omp);
    {
        let threads = state.threads.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(300));
            loop {
                ticker.tick().await;
                threads.prune_exited(Duration::from_secs(3600));
            }
        });
    }

    let app = omp_console::router(state.clone());
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("listening on http://{addr}");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    tracing::info!("stopping child sessions");
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
            Ok(mut signal) => {
                signal.recv().await;
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
