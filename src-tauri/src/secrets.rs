//! Local secrets store for the platform — currently the InfluxDB write token used
//! by the Observability Pack. Stored in the OS credential store (Windows Credential
//! Manager) via the `keyring` crate. A legacy `secrets.json` under the app config
//! dir is migrated on first read, then cleared.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use keyring::Entry;
use serde::{Deserialize, Serialize};

/// Tauri bundle identifier — stable service name in Credential Manager.
const KEYRING_SERVICE: &str = "com.stierbuildings.utilities";
const INFLUX_TOKEN_ACCOUNT: &str = "influx-token";

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
    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = path.with_extension(format!(
        "json.tmp.{}.{}",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    let res = std::fs::rename(&tmp, path).map_err(|e| e.to_string());
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

fn keyring_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, INFLUX_TOKEN_ACCOUNT).map_err(|e| e.to_string())
}

fn read_keyring_token() -> Result<Option<String>, String> {
    match keyring_entry()?.get_password() {
        Ok(token) if !token.is_empty() => Ok(Some(token)),
        Ok(_) => Ok(None),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn write_keyring_token(token: &str) -> Result<(), String> {
    keyring_entry()?
        .set_password(token)
        .map_err(|e| e.to_string())
}

/// Move a token from legacy JSON into the keyring and clear the file field.
fn migrate_legacy_json(path: &Path) -> Result<Option<String>, String> {
    let secrets = load(path);
    if secrets.influx_token.is_empty() {
        return Ok(None);
    }
    write_keyring_token(&secrets.influx_token)?;
    save(path, &Secrets::default())?;
    Ok(Some(secrets.influx_token))
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

/// Return the stored InfluxDB token, migrating legacy JSON if needed, generating
/// and persisting one on first use.
pub fn get_or_create_token(legacy_path: &Path) -> Result<String, String> {
    if let Some(token) = read_keyring_token()? {
        return Ok(token);
    }
    if let Some(token) = migrate_legacy_json(legacy_path)? {
        return Ok(token);
    }
    let token = generate_token();
    write_keyring_token(&token)?;
    Ok(token)
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

    fn test_account(tag: &str) -> String {
        format!("influx-token-test-{}-{}", std::process::id(), tag)
    }

    fn write_test_token(account: &str, token: &str) -> Result<(), String> {
        Entry::new(KEYRING_SERVICE, account)
            .map_err(|e| e.to_string())?
            .set_password(token)
            .map_err(|e| e.to_string())
    }

    fn read_test_token(account: &str) -> Result<Option<String>, String> {
        match Entry::new(KEYRING_SERVICE, account)
            .map_err(|e| e.to_string())?
            .get_password()
        {
            Ok(token) if !token.is_empty() => Ok(Some(token)),
            Ok(_) => Ok(None),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn delete_test_token(account: &str) {
        let _ = Entry::new(KEYRING_SERVICE, account)
            .ok()
            .and_then(|e| e.delete_credential().ok());
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
    fn keyring_roundtrip_and_stable_reads() {
        let account = test_account("stable");
        delete_test_token(&account);
        write_test_token(&account, "abc").unwrap();
        assert_eq!(read_test_token(&account).unwrap().as_deref(), Some("abc"));
        assert_eq!(read_test_token(&account).unwrap().as_deref(), Some("abc"));
        delete_test_token(&account);
    }

    #[test]
    fn migrate_legacy_json_moves_token_to_keyring() {
        let path = temp_path("migrate");
        let _ = std::fs::remove_file(&path);
        let _ = keyring_entry().and_then(|e| e.delete_credential().map_err(|err| err.to_string()));

        save(&path, &Secrets { influx_token: "legacy-token".into() }).unwrap();
        let token = migrate_legacy_json(&path).unwrap();
        assert_eq!(token.as_deref(), Some("legacy-token"));
        assert!(load(&path).influx_token.is_empty());
        assert_eq!(read_keyring_token().unwrap().as_deref(), Some("legacy-token"));

        let _ = keyring_entry().and_then(|e| e.delete_credential().map_err(|err| err.to_string()));
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
