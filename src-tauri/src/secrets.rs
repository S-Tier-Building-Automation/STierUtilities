//! Local secrets store for the platform — currently the InfluxDB write token used
//! by the Observability Pack. Stored as JSON under the app config dir.
//!
//! NOTE: this is a localhost-only store. The token authenticates writes to an
//! InfluxDB bound to 127.0.0.1, so the threat model is a co-resident local
//! process. The file lives under the per-user app config dir, whose profile ACL
//! already blocks *other* users; isolating it from a *same-user* process is the
//! job of the OS keychain (Credential Manager), which remains the planned next
//! step — see the design doc. The token itself is now generated from the OS
//! CSPRNG (was a time/heap-address seeded xorshift, which was predictable).

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Secrets {
    #[serde(default)]
    pub influx_token: String,
}

pub fn load(path: &Path) -> Secrets {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, secrets: &Secrets) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(secrets).map_err(|e| e.to_string())?;
    // Atomic-ish write via a temp file + rename. The temp name is unique per
    // process + call so two concurrent saves can't clobber each other's temp.
    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = path.with_extension(format!(
        "json.tmp.{}.{}",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    let res = std::fs::rename(&tmp, path).map_err(|e| e.to_string());
    if res.is_err() {
        // Don't leak the temp file in the config dir if the rename failed.
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

/// Generate a 128-hex-char token from the OS CSPRNG (getrandom: BCryptGenRandom
/// on Windows). A failing CSPRNG is unrecoverable for a security token, so we
/// panic rather than emit a weak one.
pub fn generate_token() -> String {
    let mut bytes = [0u8; 64];
    getrandom::getrandom(&mut bytes).expect("OS CSPRNG (getrandom) failed");
    let mut out = String::with_capacity(128);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Return the stored InfluxDB token, generating and persisting one on first use.
pub fn get_or_create_token(path: &Path) -> Result<String, String> {
    let mut secrets = load(path);
    if secrets.influx_token.is_empty() {
        secrets.influx_token = generate_token();
        save(path, &secrets)?;
    }
    Ok(secrets.influx_token)
}

/// Resolve the InfluxDB token from the app config dir, creating it if needed.
#[cfg(windows)]
#[tauri::command]
pub fn secrets_influx_token(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    get_or_create_token(&dir.join("secrets.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("stier_secrets_{}_{}.json", std::process::id(), tag))
    }

    #[test]
    fn token_is_long_hex_and_varies() {
        let a = generate_token();
        assert_eq!(a.len(), 128);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        let b = generate_token();
        assert_ne!(a, b, "two tokens should differ");
    }

    #[test]
    fn get_or_create_is_stable_across_calls() {
        let path = temp_path("stable");
        let _ = std::fs::remove_file(&path);
        let first = get_or_create_token(&path).unwrap();
        assert!(!first.is_empty());
        let second = get_or_create_token(&path).unwrap();
        assert_eq!(first, second, "token must persist between calls");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_missing_returns_default() {
        let path = temp_path("missing");
        let _ = std::fs::remove_file(&path);
        assert!(load(&path).influx_token.is_empty());
    }

    #[test]
    fn save_then_load_roundtrips() {
        let path = temp_path("roundtrip");
        let s = Secrets { influx_token: "abc123".into() };
        save(&path, &s).unwrap();
        assert_eq!(load(&path).influx_token, "abc123");
        let _ = std::fs::remove_file(&path);
    }
}
