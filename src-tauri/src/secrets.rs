//! Local secrets store for the platform — currently the InfluxDB write token used
//! by the Observability Pack. Stored as JSON under the app config dir.
//!
//! NOTE: this is a localhost-only store. The token authenticates writes to an
//! InfluxDB bound to 127.0.0.1, so the threat model is a co-resident local
//! process. A future hardening step moves this to the OS keychain (Credential
//! Manager / Keychain / Secret Service) — see the design doc. The token generator
//! below is intentionally simple (not a CSPRNG); it's adequate for a local token
//! but should be replaced alongside the keychain move.

use std::path::Path;

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
    // Atomic-ish write via a temp file + rename, matching networkmanager's pattern.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Generate a 128-hex-char token. NOT a CSPRNG — see the module note.
pub fn generate_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0) as u64;
    // Mix in a heap address for a little per-process/run entropy.
    let probe = Box::new(0u8);
    let addr = (&*probe as *const u8) as u64;
    let mut state = nanos ^ addr ^ 0x9E37_79B9_7F4A_7C15;
    let mut out = String::with_capacity(128);
    for _ in 0..8 {
        // xorshift64*
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        let v = state.wrapping_mul(0x2545_F491_4F6C_DD1D);
        out.push_str(&format!("{v:016x}"));
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
