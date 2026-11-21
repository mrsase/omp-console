use std::net::SocketAddr;
use std::path::PathBuf;

/// Process-wide configuration, read once. Every field is resolved; nothing
/// below reads the environment after startup.
#[derive(Debug, Clone)]
pub struct Config {
    pub addr: SocketAddr,
    pub omp_bin: String,
    pub session_root: PathBuf,
    pub home: PathBuf,
    pub server_cwd: PathBuf,
    pub max_threads: usize,
    pub ws_slots: usize,
    /// Lowercased `Host` values, including the port.
    pub allowed_hosts: Vec<String>,
    /// Lowercased origins, no trailing slash.
    pub allowed_origins: Vec<String>,
    pub dev: bool,
    pub allow_remote: bool,
    pub skip_version_check: bool,
    /// When set, assets are read from this directory instead of the embedded
    /// bundle. Intended for `vite dev` and tests.
    pub static_dir: Option<PathBuf>,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .ok_or("cannot determine HOME")?;
        let server_cwd = std::env::current_dir().map_err(|error| error.to_string())?;

        let addr_text = env_or("OMP_CONSOLE_ADDR", "127.0.0.1:8787");
        let addr: SocketAddr = addr_text
            .parse()
            .map_err(|_| format!("invalid OMP_CONSOLE_ADDR: {addr_text}"))?;
        let allow_remote = env_or("OMP_CONSOLE_ALLOW_REMOTE", "0") == "1";
        if !addr.ip().is_loopback() && !allow_remote {
            return Err(format!(
                "refusing to bind non-loopback address {addr}; set OMP_CONSOLE_ALLOW_REMOTE=1 to override"
            ));
        }

        let session_root =
            env_path("OMP_CONSOLE_SESSIONS").unwrap_or_else(|| home.join(".omp/agent/sessions"));
        let max_threads = env_or("OMP_CONSOLE_MAX_THREADS", "8")
            .parse::<usize>()
            .unwrap_or(8)
            .clamp(1, 64);
        let ws_slots = env_or("OMP_CONSOLE_WS_SLOTS", "16")
            .parse::<usize>()
            .unwrap_or(16)
            .clamp(1, 64);
        let dev = env_or("OMP_CONSOLE_DEV", "0") == "1";

        let port = addr.port();
        let mut allowed_hosts = vec![
            format!("127.0.0.1:{port}"),
            format!("localhost:{port}"),
            format!("[::1]:{port}"),
        ];
        if addr.ip().is_loopback() && addr.port() != 8787 {
            allowed_hosts.push(format!("{}", addr));
        }
        for value in env_or("OMP_CONSOLE_ALLOWED_HOSTS", "").split(',') {
            let value = value.trim().to_ascii_lowercase();
            if !value.is_empty() && !allowed_hosts.contains(&value) {
                allowed_hosts.push(value);
            }
        }

        let mut allowed_origins = vec![
            format!("http://127.0.0.1:{port}"),
            format!("http://localhost:{port}"),
            format!("http://[::1]:{port}"),
        ];
        if dev {
            allowed_origins.push("http://127.0.0.1:5173".into());
            allowed_origins.push("http://localhost:5173".into());
        }
        for value in env_or("OMP_CONSOLE_ALLOWED_ORIGINS", "").split(',') {
            let value = value.trim().trim_end_matches('/').to_ascii_lowercase();
            if !value.is_empty() && !allowed_origins.contains(&value) {
                allowed_origins.push(value);
            }
        }

        Ok(Self {
            addr,
            omp_bin: env_or("OMP_BIN", "omp"),
            session_root,
            home,
            server_cwd,
            max_threads,
            ws_slots,
            allowed_hosts,
            allowed_origins,
            dev,
            allow_remote,
            skip_version_check: env_or("OMP_CONSOLE_SKIP_VERSION_CHECK", "0") == "1",
            static_dir: env_path("OMP_CONSOLE_STATIC"),
        })
    }

    /// A deterministic configuration for tests: loopback, a temp session root.
    pub fn for_test(session_root: PathBuf) -> Self {
        let addr: SocketAddr = "127.0.0.1:8787".parse().unwrap();
        Self {
            addr,
            omp_bin: "omp".into(),
            session_root,
            home: std::env::temp_dir(),
            server_cwd: std::env::temp_dir(),
            max_threads: 2,
            ws_slots: 4,
            allowed_hosts: vec!["127.0.0.1:8787".into()],
            allowed_origins: vec!["http://127.0.0.1:8787".into()],
            dev: false,
            allow_remote: false,
            skip_version_check: false,
            static_dir: None,
        }
    }

    pub fn host_allowed(&self, host: &str) -> bool {
        let host = host.to_ascii_lowercase();
        self.allowed_hosts.iter().any(|allowed| allowed == &host)
    }

    pub fn origin_allowed(&self, origin: &str) -> bool {
        let origin = origin.trim_end_matches('/').to_ascii_lowercase();
        origin != "null"
            && self
                .allowed_origins
                .iter()
                .any(|allowed| allowed == &origin)
    }

    pub fn static_dir_name(&self) -> String {
        self.static_dir
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "<embedded>".into())
    }
}
