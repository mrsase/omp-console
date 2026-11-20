use std::net::SocketAddr;
use std::path::PathBuf;

/// Process-wide configuration, read once at startup.
pub struct Config {
    pub addr: SocketAddr,
    pub omp_bin: String,
    pub static_dir: PathBuf,
    pub session_root: PathBuf,
    pub max_threads: usize,
    pub server_cwd: PathBuf,
    pub home: PathBuf,
    /// `Host` header values accepted by the HTTP/WS guard, lowercased.
    pub allowed_hosts: Vec<String>,
    /// Browser origins accepted for WebSocket and state-changing requests.
    pub allowed_origins: Vec<String>,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .ok_or("cannot determine HOME")?;
        let server_cwd = std::env::current_dir().map_err(|e| e.to_string())?;

        let addr_text = env_or("OMP_WEB_ADDR", "127.0.0.1:8787");
        let addr: SocketAddr = addr_text
            .parse()
            .map_err(|_| format!("invalid OMP_WEB_ADDR: {addr_text}"))?;

        let omp_bin = env_or("OMP_BIN", "omp");

        let session_root = std::env::var_os("OMP_WEB_SESSIONS")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".omp/agent/sessions"));

        let static_dir = match std::env::var_os("OMP_WEB_STATIC") {
            Some(dir) => PathBuf::from(dir),
            None => {
                let local = server_cwd.join("web/dist");
                if local.is_dir() {
                    local
                } else {
                    server_cwd.join("../web/dist")
                }
            }
        };

        let max_threads = env_or("OMP_WEB_MAX_THREADS", "8")
            .parse::<usize>()
            .unwrap_or(8)
            .clamp(1, 64);

        let allow_remote = env_or("OMP_WEB_ALLOW_REMOTE", "0") == "1";
        if !addr.ip().is_loopback() && !allow_remote {
            return Err(format!(
                "refusing to bind non-loopback address {addr}; set OMP_WEB_ALLOW_REMOTE=1 to override"
            ));
        }

        let port = addr.port();
        let mut allowed_hosts = vec![
            format!("127.0.0.1:{port}"),
            format!("localhost:{port}"),
            format!("[::1]:{port}"),
        ];
        let mut allowed_origins = vec![
            format!("http://127.0.0.1:{port}"),
            format!("http://localhost:{port}"),
            format!("http://[::1]:{port}"),
            "http://127.0.0.1:5173".to_string(),
            "http://localhost:5173".to_string(),
        ];
        for value in env_or("OMP_WEB_ALLOWED_HOSTS", "").split(',') {
            let value = value.trim().to_ascii_lowercase();
            if !value.is_empty() {
                allowed_hosts.push(value);
            }
        }
        for value in env_or("OMP_WEB_ALLOWED_ORIGINS", "").split(',') {
            let value = value.trim().trim_end_matches('/').to_ascii_lowercase();
            if !value.is_empty() {
                allowed_origins.push(value);
            }
        }

        Ok(Self {
            addr,
            omp_bin,
            static_dir,
            session_root,
            max_threads,
            server_cwd,
            home,
            allowed_hosts,
            allowed_origins,
        })
    }
}
