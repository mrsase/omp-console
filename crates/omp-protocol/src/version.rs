//! `omp --version` parsing and the supported range.

use std::fmt;

pub const SUPPORTED_MAJOR: u32 = 18;
pub const TESTED_VERSION: &str = "18.18.8";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// Parse `omp/18.18.8`, `omp v18.18.8`, `18.18.8`, or a line containing one.
pub fn parse(output: &str) -> Option<Version> {
    output.split_whitespace().find_map(|token| {
        let token = token
            .trim()
            .trim_start_matches("omp/")
            .trim_start_matches("omp")
            .trim_start_matches('v');
        let mut parts = token.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
        let patch = parts
            .next()
            .map(|part| {
                part.chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>()
            })
            .and_then(|digits| digits.parse().ok())
            .unwrap_or(0);
        Some(Version {
            major,
            minor,
            patch,
        })
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Support {
    pub supported: bool,
    pub tested: bool,
    pub message: String,
}

pub fn support(version: &Version) -> Support {
    let tested = *version
        == Version {
            major: 18,
            minor: 18,
            patch: 8,
        };
    if version.major == SUPPORTED_MAJOR {
        Support {
            supported: true,
            tested,
            message: format!(
                "omp {version} is supported (contract recorded from {TESTED_VERSION})"
            ),
        }
    } else {
        Support {
            supported: false,
            tested: false,
            message: format!(
                "omp {version} is outside the supported {SUPPORTED_MAJOR}.x range \
                 (tested {TESTED_VERSION}). Point OMP_BIN at an {SUPPORTED_MAJOR}.x binary, \
                 or set OMP_CONSOLE_SKIP_VERSION_CHECK=1 to run unverified."
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_shapes_omp_prints() {
        assert_eq!(
            parse("omp/18.18.8"),
            Some(Version {
                major: 18,
                minor: 18,
                patch: 8
            })
        );
        assert_eq!(
            parse("omp v18.18.8\n"),
            Some(Version {
                major: 18,
                minor: 18,
                patch: 8
            })
        );
        assert_eq!(
            parse("18.18.8"),
            Some(Version {
                major: 18,
                minor: 18,
                patch: 8
            })
        );
        assert_eq!(
            parse("omp/18"),
            Some(Version {
                major: 18,
                minor: 0,
                patch: 0
            })
        );
        assert_eq!(parse("no version"), None);
    }

    #[test]
    fn accepts_18_and_refuses_others() {
        let current = parse("omp/18.18.8").unwrap();
        let result = support(&current);
        assert!(result.supported);
        assert!(result.tested);

        let next = parse("omp/19.0.0").unwrap();
        let result = support(&next);
        assert!(!result.supported);
        assert!(result.message.contains("18.x"));
        assert!(result.message.contains("OMP_CONSOLE_SKIP_VERSION_CHECK"));
    }
}
