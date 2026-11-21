use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::process::Command;

use omp_protocol::version::{self, Support, Version};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpProbe {
    pub bin: String,
    pub found: bool,
    pub version: Option<String>,
    pub supported: bool,
    pub tested: bool,
    pub message: String,
    pub checked_at: u64,
}

impl OmpProbe {
    pub fn test_stub() -> Self {
        Self {
            bin: "stub".into(),
            found: true,
            version: Some(version::TESTED_VERSION.into()),
            supported: true,
            tested: true,
            message: "test stub".into(),
            checked_at: 0,
        }
    }

    pub fn check(&self, skip_version_check: bool) -> Result<(), String> {
        if !self.found {
            return Err(self.message.clone());
        }
        if !self.supported && !skip_version_check {
            return Err(self.message.clone());
        }
        Ok(())
    }
}

/// Run `omp --version` with a deadline. Never fails the server; the result is
/// surfaced in `/api/info` and checked before a spawn.
pub async fn probe(bin: &str) -> OmpProbe {
    let mut command = Command::new(bin);
    command
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let output = match tokio::time::timeout(Duration::from_secs(5), command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            return OmpProbe {
                bin: bin.into(),
                found: false,
                version: None,
                supported: false,
                tested: false,
                message: format!("cannot run `{bin} --version`: {error}"),
                checked_at: now_ms(),
            };
        }
        Err(_) => {
            return OmpProbe {
                bin: bin.into(),
                found: false,
                version: None,
                supported: false,
                tested: false,
                message: format!("`{bin} --version` timed out after 5s"),
                checked_at: now_ms(),
            };
        }
    };
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let parsed: Option<Version> = version::parse(&text);
    let support: Option<Support> = parsed.as_ref().map(version::support);
    OmpProbe {
        bin: bin.into(),
        found: true,
        version: parsed.map(|version| version.to_string()),
        supported: support.as_ref().is_some_and(|support| support.supported),
        tested: support.as_ref().is_some_and(|support| support.tested),
        message: support.map_or_else(
            || format!("could not parse a version from `{bin} --version`: {text:?}"),
            |support| support.message,
        ),
        checked_at: now_ms(),
    }
}

pub fn canonical(path: &std::path::Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}
