//! Local-first account, organization, session, and app-state persistence.
//!
//! This is the native foundation for future sync. The first implementation
//! deliberately keeps identity local to the workstation, while storing state in
//! an account/org scoped shape so a later remote sync provider can mirror the
//! same files without changing the frontend contract.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub id: String,
    pub name: String,
    pub email: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthOrg {
    pub id: String,
    pub name: String,
    pub owner_user_id: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub user_id: String,
    pub org_id: String,
    pub device_id: String,
    pub signed_in_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthSyncStatus {
    pub mode: String,
    pub message: String,
}

impl Default for AuthSyncStatus {
    fn default() -> Self {
        Self {
            mode: "local".into(),
            message: "Local-first profile. Choose a sync folder to share state across devices."
                .into(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthState {
    pub device_id: String,
    #[serde(default)]
    pub sync_folder: String,
    #[serde(default)]
    pub last_synced_at: Option<u64>,
    #[serde(default)]
    pub active_user_id: String,
    #[serde(default)]
    pub active_org_id: String,
    #[serde(default)]
    pub users: Vec<AuthUser>,
    #[serde(default)]
    pub orgs: Vec<AuthOrg>,
    #[serde(default)]
    pub session: Option<AuthSession>,
    // Defaulted so loading an older auth.json that predates this field doesn't
    // fail deserialization (which would silently reset the whole profile).
    #[serde(default)]
    pub sync_status: AuthSyncStatus,
}

pub fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Generate a compact local id (`prefix_<32 hex>`). Not a security token, but it
/// IS used as a filesystem path segment and as a sync-merge join key, so it must
/// be unguessable and effectively collision-free — hence the OS CSPRNG (was a
/// time/heap-address seeded xorshift, which could collide or be predicted).
pub fn generate_id(prefix: &str) -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("OS CSPRNG (getrandom) failed");
    let mut out = String::with_capacity(prefix.len() + 1 + 32);
    out.push_str(prefix);
    out.push('_');
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

pub fn load_auth(path: &Path) -> AuthState {
    let mut state: AuthState = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if state.device_id.is_empty() {
        state.device_id = generate_id("dev");
    }
    if state.sync_status.mode.is_empty() {
        state.sync_status = AuthState::default().sync_status;
    }
    if !state.sync_folder.is_empty() {
        state.sync_status.mode = "folder".into();
        state.sync_status.message = format!("Sync folder connected: {}", state.sync_folder);
    }
    state
}

pub fn save_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    // Unique temp name per process + call so concurrent saves (e.g. debounced
    // user-state writes) can't clobber each other's temp file mid-rename.
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

pub fn save_auth(path: &Path, state: &AuthState) -> Result<(), String> {
    save_json(path, state)
}

fn normalize_email(email: &str, device_id: &str) -> String {
    let trimmed = email.trim().to_ascii_lowercase();
    if trimmed.is_empty() {
        format!("local+{}@stier.local", sanitize_key(device_id))
    } else {
        trimmed
    }
}

fn normalize_name(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.into()
    } else {
        trimmed.into()
    }
}

pub fn ensure_local_session(
    auth_path: &Path,
    name: &str,
    email: &str,
    org_name: &str,
) -> Result<AuthState, String> {
    let mut state = load_auth(auth_path);
    let now = now_epoch();
    let email = normalize_email(email, &state.device_id);
    let name = normalize_name(name, "Local User");
    let org_name = normalize_name(org_name, "Personal");

    let user_id = if let Some(existing) = state.users.iter_mut().find(|u| u.email == email) {
        existing.name = name.clone();
        existing.id.clone()
    } else {
        let id = generate_id("usr");
        state.users.push(AuthUser {
            id: id.clone(),
            name: name.clone(),
            email,
            created_at: now,
        });
        id
    };

    let org_id = if let Some(existing) = state
        .orgs
        .iter_mut()
        .find(|o| o.owner_user_id == user_id && o.name.eq_ignore_ascii_case(&org_name))
    {
        existing.name = org_name.clone();
        existing.id.clone()
    } else {
        let id = generate_id("org");
        state.orgs.push(AuthOrg {
            id: id.clone(),
            name: org_name,
            owner_user_id: user_id.clone(),
            created_at: now,
        });
        id
    };

    state.active_user_id = user_id.clone();
    state.active_org_id = org_id.clone();
    state.session = Some(AuthSession {
        user_id,
        org_id,
        device_id: state.device_id.clone(),
        signed_in_at: now,
    });
    save_auth(auth_path, &state)?;
    Ok(state)
}

pub fn sign_out(auth_path: &Path) -> Result<AuthState, String> {
    let mut state = load_auth(auth_path);
    state.session = None;
    state.active_user_id.clear();
    state.active_org_id.clear();
    save_auth(auth_path, &state)?;
    Ok(state)
}

pub fn switch_org(auth_path: &Path, org_id: &str) -> Result<AuthState, String> {
    let mut state = load_auth(auth_path);
    let session = state
        .session
        .clone()
        .ok_or_else(|| "no active session".to_string())?;
    let org = state
        .orgs
        .iter()
        .find(|o| o.id == org_id && o.owner_user_id == session.user_id)
        .ok_or_else(|| "organization is not available for the active user".to_string())?;
    let now = now_epoch();
    state.active_user_id = session.user_id.clone();
    state.active_org_id = org.id.clone();
    state.session = Some(AuthSession {
        user_id: session.user_id,
        org_id: org.id.clone(),
        device_id: state.device_id.clone(),
        signed_in_at: now,
    });
    save_auth(auth_path, &state)?;
    Ok(state)
}

pub fn create_org(auth_path: &Path, org_name: &str) -> Result<AuthState, String> {
    let mut state = load_auth(auth_path);
    let session = state
        .session
        .clone()
        .ok_or_else(|| "no active session".to_string())?;
    let org_name = normalize_name(org_name, "New Organization");
    if let Some(org) = state
        .orgs
        .iter()
        .find(|o| o.owner_user_id == session.user_id && o.name.eq_ignore_ascii_case(&org_name))
    {
        return switch_org(auth_path, &org.id);
    }
    let now = now_epoch();
    let org_id = generate_id("org");
    state.orgs.push(AuthOrg {
        id: org_id.clone(),
        name: org_name,
        owner_user_id: session.user_id.clone(),
        created_at: now,
    });
    state.active_user_id = session.user_id.clone();
    state.active_org_id = org_id.clone();
    state.session = Some(AuthSession {
        user_id: session.user_id,
        org_id,
        device_id: state.device_id.clone(),
        signed_in_at: now,
    });
    save_auth(auth_path, &state)?;
    Ok(state)
}

pub fn sanitize_key(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        "_".into()
    } else {
        out
    }
}

pub fn state_path(root: &Path, user_id: &str, org_id: &str) -> PathBuf {
    root.join("state")
        .join(sanitize_key(org_id))
        .join(format!("{}.json", sanitize_key(user_id)))
}

fn resolve_scope(
    auth_path: &Path,
    user_id: Option<String>,
    org_id: Option<String>,
) -> Result<(String, String), String> {
    match (user_id, org_id) {
        (Some(u), Some(o)) if !u.trim().is_empty() && !o.trim().is_empty() => {
            Ok((u.trim().into(), o.trim().into()))
        }
        _ => {
            let state = load_auth(auth_path);
            if let Some(session) = state.session {
                Ok((session.user_id, session.org_id))
            } else {
                Err("no active auth session".into())
            }
        }
    }
}

pub fn load_user_state(
    auth_path: &Path,
    root: &Path,
    user_id: Option<String>,
    org_id: Option<String>,
) -> Result<Value, String> {
    let (user_id, org_id) = resolve_scope(auth_path, user_id, org_id)?;
    let path = state_path(root, &user_id, &org_id);
    Ok(std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| Value::Object(serde_json::Map::new())))
}

pub fn save_user_state(
    auth_path: &Path,
    root: &Path,
    user_id: Option<String>,
    org_id: Option<String>,
    state: Value,
) -> Result<(), String> {
    let (user_id, org_id) = resolve_scope(auth_path, user_id, org_id)?;
    let path = state_path(root, &user_id, &org_id);
    save_json(&path, &state)
}

/// Schema tag stamped on exported sync snapshots and required on import. The
/// sync file lives in a user-chosen folder other processes can write, so imports
/// are validated against this before any data is trusted.
pub const SNAPSHOT_SCHEMA: &str = "stier.auth.snapshot.v1";

pub fn export_snapshot(auth_path: &Path, root: &Path) -> Result<Value, String> {
    let state = load_auth(auth_path);
    let mut scoped_states = BTreeMap::new();
    for org in &state.orgs {
        for user in state.users.iter().filter(|u| u.id == org.owner_user_id) {
            let path = state_path(root, &user.id, &org.id);
            if let Ok(raw) = std::fs::read_to_string(path) {
                if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                    scoped_states.insert(format!("{}/{}", org.id, user.id), value);
                }
            }
        }
    }
    serde_json::to_value(serde_json::json!({
        "schema": SNAPSHOT_SCHEMA,
        "exportedAt": now_epoch(),
        "auth": state,
        "states": scoped_states,
    }))
    .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthSyncResult {
    pub state: AuthState,
    pub imported: bool,
    pub exported: bool,
    pub path: String,
    pub message: String,
}

fn snapshot_file(sync_folder: &Path) -> PathBuf {
    sync_folder.join("STierUtilities").join("auth-sync.json")
}

fn set_sync_status(state: &mut AuthState) {
    if state.sync_folder.is_empty() {
        state.sync_status = AuthState::default().sync_status;
    } else {
        state.sync_status.mode = "folder".into();
        state.sync_status.message = format!("Sync folder connected: {}", state.sync_folder);
    }
}

pub fn set_sync_folder(auth_path: &Path, folder: &Path) -> Result<AuthState, String> {
    std::fs::create_dir_all(folder).map_err(|e| format!("could not create sync folder: {e}"))?;
    let mut state = load_auth(auth_path);
    state.sync_folder = folder.to_string_lossy().into_owned();
    set_sync_status(&mut state);
    save_auth(auth_path, &state)?;
    Ok(state)
}

pub fn clear_sync_folder(auth_path: &Path) -> Result<AuthState, String> {
    let mut state = load_auth(auth_path);
    state.sync_folder.clear();
    state.last_synced_at = None;
    set_sync_status(&mut state);
    save_auth(auth_path, &state)?;
    Ok(state)
}

fn merge_json(local: Value, incoming: Value) -> Value {
    match (local, incoming) {
        (Value::Object(mut local), Value::Object(incoming)) => {
            for (key, incoming_value) in incoming {
                let next = if let Some(local_value) = local.remove(&key) {
                    merge_json(local_value, incoming_value)
                } else {
                    incoming_value
                };
                local.insert(key, next);
            }
            Value::Object(local)
        }
        (_, incoming) => incoming,
    }
}

pub fn merge_snapshot(auth_path: &Path, root: &Path, snapshot: Value) -> Result<AuthState, String> {
    // Validate the snapshot shape before importing anything: the file comes from
    // a user-chosen sync folder that other processes (or a shared drive) can write.
    let schema = snapshot.get("schema").and_then(|v| v.as_str()).unwrap_or("");
    if schema != SNAPSHOT_SCHEMA {
        return Err(format!(
            "unrecognized sync snapshot schema {schema:?} (expected {SNAPSHOT_SCHEMA:?})"
        ));
    }
    let remote_auth_value = snapshot
        .get("auth")
        .ok_or_else(|| "sync snapshot is missing auth data".to_string())?
        .clone();
    let remote_auth: AuthState =
        serde_json::from_value(remote_auth_value).map_err(|e| format!("invalid auth data: {e}"))?;
    let remote_session = remote_auth.session.clone();
    let states = snapshot
        .get("states")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let mut local = load_auth(auth_path);
    let local_device_id = local.device_id.clone();
    let mut user_map = BTreeMap::new();
    let mut org_map = BTreeMap::new();

    for remote_user in remote_auth.users {
        if let Some(existing) = local.users.iter_mut().find(|u| u.id == remote_user.id) {
            existing.name = remote_user.name.clone();
            existing.email = remote_user.email.clone();
            user_map.insert(remote_user.id, existing.id.clone());
        } else if let Some(existing) = local
            .users
            .iter_mut()
            .find(|u| !remote_user.email.is_empty() && u.email == remote_user.email)
        {
            existing.name = remote_user.name.clone();
            user_map.insert(remote_user.id, existing.id.clone());
        } else {
            let id = remote_user.id.clone();
            user_map.insert(id.clone(), id);
            local.users.push(remote_user);
        }
    }

    for mut remote_org in remote_auth.orgs {
        let mapped_owner = user_map
            .get(&remote_org.owner_user_id)
            .cloned()
            .unwrap_or_else(|| remote_org.owner_user_id.clone());
        remote_org.owner_user_id = mapped_owner.clone();
        if let Some(existing) = local.orgs.iter_mut().find(|o| o.id == remote_org.id) {
            existing.name = remote_org.name.clone();
            existing.owner_user_id = mapped_owner;
            org_map.insert(remote_org.id, existing.id.clone());
        } else if let Some(existing) = local.orgs.iter_mut().find(|o| {
            o.owner_user_id == mapped_owner && o.name.eq_ignore_ascii_case(&remote_org.name)
        }) {
            existing.name = remote_org.name.clone();
            org_map.insert(remote_org.id, existing.id.clone());
        } else {
            let id = remote_org.id.clone();
            org_map.insert(id.clone(), id);
            local.orgs.push(remote_org);
        }
    }

    for (scope, incoming_state) in states {
        let mut parts = scope.splitn(2, '/');
        let remote_org_id = parts.next().unwrap_or_default();
        let remote_user_id = parts.next().unwrap_or_default();
        if remote_org_id.is_empty() || remote_user_id.is_empty() {
            continue;
        }
        // Only write scoped state for ids that resolved to a known local
        // user/org. Falling back to the raw remote id would let a crafted
        // snapshot steer writes to attacker-chosen state-file paths.
        let (Some(user_id), Some(org_id)) = (
            user_map.get(remote_user_id).cloned(),
            org_map.get(remote_org_id).cloned(),
        ) else {
            continue;
        };
        let path = state_path(root, &user_id, &org_id);
        let existing = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
        let merged = merge_json(existing, incoming_state);
        save_json(&path, &merged)?;
    }

    local.device_id = local_device_id;
    if local.session.is_none() {
        if let Some(remote_session) = remote_session {
            // Only adopt a synced session if it points at accounts this snapshot
            // actually defined (resolved through the id maps). A snapshot can't
            // activate a session for an unknown/unmapped identity, so a crafted
            // file can't silently sign the user into an account it didn't bring.
            if let (Some(user_id), Some(org_id)) = (
                user_map.get(&remote_session.user_id).cloned(),
                org_map.get(&remote_session.org_id).cloned(),
            ) {
                local.active_user_id = user_id.clone();
                local.active_org_id = org_id.clone();
                local.session = Some(AuthSession {
                    user_id,
                    org_id,
                    device_id: local.device_id.clone(),
                    signed_in_at: now_epoch(),
                });
            }
        }
    }
    set_sync_status(&mut local);
    save_auth(auth_path, &local)?;
    Ok(local)
}

pub fn sync_now(auth_path: &Path, root: &Path) -> Result<AuthSyncResult, String> {
    let state = load_auth(auth_path);
    if state.sync_folder.is_empty() {
        return Err("no sync folder configured".into());
    }
    let sync_path = snapshot_file(Path::new(&state.sync_folder));
    let mut imported = false;
    let mut current = state;
    if sync_path.exists() {
        let raw = std::fs::read_to_string(&sync_path)
            .map_err(|e| format!("could not read sync snapshot: {e}"))?;
        let snapshot = serde_json::from_str::<Value>(&raw)
            .map_err(|e| format!("invalid sync snapshot: {e}"))?;
        current = merge_snapshot(auth_path, root, snapshot)?;
        imported = true;
    }

    current.last_synced_at = Some(now_epoch());
    set_sync_status(&mut current);
    save_auth(auth_path, &current)?;
    let snapshot = export_snapshot(auth_path, root)?;
    save_json(&sync_path, &snapshot)?;
    Ok(AuthSyncResult {
        state: current,
        imported,
        exported: true,
        path: sync_path.to_string_lossy().into_owned(),
        message: if imported {
            "Pulled shared profile state and pushed local updates.".into()
        } else {
            "Pushed local profile state to the sync folder.".into()
        },
    })
}

#[cfg(windows)]
fn auth_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?
        .join("auth");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create auth dir: {e}"))?;
    Ok(dir)
}

#[cfg(windows)]
fn auth_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(auth_root(app)?.join("auth.json"))
}

#[cfg(windows)]
#[tauri::command]
pub fn auth_get_state(app: tauri::AppHandle) -> Result<AuthState, String> {
    let path = auth_file(&app)?;
    let state = load_auth(&path);
    if !path.exists() {
        save_auth(&path, &state)?;
    }
    Ok(state)
}

#[cfg(windows)]
#[tauri::command]
pub fn auth_create_local_session(
    app: tauri::AppHandle,
    name: String,
    email: String,
    org_name: String,
) -> Result<AuthState, String> {
    ensure_local_session(&auth_file(&app)?, &name, &email, &org_name)
}

#[cfg(windows)]
#[tauri::command]
pub fn auth_sign_out(app: tauri::AppHandle) -> Result<AuthState, String> {
    sign_out(&auth_file(&app)?)
}

#[cfg(windows)]
#[tauri::command]
pub fn auth_switch_org(app: tauri::AppHandle, org_id: String) -> Result<AuthState, String> {
    switch_org(&auth_file(&app)?, &org_id)
}

#[cfg(windows)]
#[tauri::command]
pub fn auth_create_org(app: tauri::AppHandle, org_name: String) -> Result<AuthState, String> {
    create_org(&auth_file(&app)?, &org_name)
}

#[cfg(windows)]
#[tauri::command]
pub fn auth_load_user_state(
    app: tauri::AppHandle,
    user_id: Option<String>,
    org_id: Option<String>,
) -> Result<Value, String> {
    let root = auth_root(&app)?;
    load_user_state(&auth_file(&app)?, &root, user_id, org_id)
}

#[cfg(windows)]
#[tauri::command]
pub fn auth_save_user_state(
    app: tauri::AppHandle,
    user_id: Option<String>,
    org_id: Option<String>,
    state: Value,
) -> Result<(), String> {
    let root = auth_root(&app)?;
    save_user_state(&auth_file(&app)?, &root, user_id, org_id, state)
}

#[cfg(windows)]
#[tauri::command]
pub fn auth_export_snapshot(app: tauri::AppHandle) -> Result<Value, String> {
    let root = auth_root(&app)?;
    export_snapshot(&auth_file(&app)?, &root)
}

#[cfg(windows)]
#[tauri::command]
pub fn auth_pick_sync_folder(app: tauri::AppHandle) -> Result<Option<AuthState>, String> {
    let Some(folder) = rfd::FileDialog::new().pick_folder() else {
        return Ok(None);
    };
    set_sync_folder(&auth_file(&app)?, &folder).map(Some)
}

#[cfg(windows)]
#[tauri::command]
pub fn auth_clear_sync_folder(app: tauri::AppHandle) -> Result<AuthState, String> {
    clear_sync_folder(&auth_file(&app)?)
}

#[cfg(windows)]
#[tauri::command]
pub fn auth_sync_now(app: tauri::AppHandle) -> Result<AuthSyncResult, String> {
    let root = auth_root(&app)?;
    sync_now(&auth_file(&app)?, &root)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "stier_auth_{}_{}_{}",
            std::process::id(),
            now_epoch(),
            tag
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn ids_are_prefixed_and_hex_like() {
        let id = generate_id("usr");
        assert!(id.starts_with("usr_"));
        assert_eq!(id.len(), 36);
        assert!(id[4..].chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn local_session_creates_user_org_and_persists() {
        let dir = temp_dir("session");
        let path = dir.join("auth.json");
        let state = ensure_local_session(&path, "Tim", "tim@example.com", "BKK").unwrap();
        assert_eq!(state.users.len(), 1);
        assert_eq!(state.orgs.len(), 1);
        assert!(state.session.is_some());
        let reloaded = load_auth(&path);
        assert_eq!(reloaded.users[0].email, "tim@example.com");
        assert_eq!(reloaded.orgs[0].name, "BKK");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn repeated_local_session_reuses_matching_user_and_org() {
        let dir = temp_dir("reuse");
        let path = dir.join("auth.json");
        let first = ensure_local_session(&path, "Tim", "tim@example.com", "BKK").unwrap();
        let second = ensure_local_session(&path, "Tim F", "TIM@example.com", "bkk").unwrap();
        assert_eq!(second.users.len(), 1);
        assert_eq!(second.orgs.len(), 1);
        assert_eq!(first.users[0].id, second.users[0].id);
        assert_eq!(first.orgs[0].id, second.orgs[0].id);
        assert_eq!(second.users[0].name, "Tim F");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn scoped_state_roundtrips_under_safe_path() {
        let dir = temp_dir("state");
        let auth_path = dir.join("auth.json");
        let root = dir.join("auth");
        let auth = ensure_local_session(&auth_path, "Tim", "tim@example.com", "BKK").unwrap();
        let mut value = serde_json::Map::new();
        value.insert("view".into(), Value::String("settings".into()));
        save_user_state(&auth_path, &root, None, None, Value::Object(value)).unwrap();
        let loaded = load_user_state(&auth_path, &root, None, None).unwrap();
        assert_eq!(loaded["view"], "settings");
        let path = state_path(&root, &auth.users[0].id, &auth.orgs[0].id);
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sign_out_removes_active_session_without_deleting_accounts() {
        let dir = temp_dir("signout");
        let path = dir.join("auth.json");
        ensure_local_session(&path, "Tim", "tim@example.com", "BKK").unwrap();
        let state = sign_out(&path).unwrap();
        assert!(state.session.is_none());
        assert_eq!(state.users.len(), 1);
        assert_eq!(state.orgs.len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn create_org_adds_and_switches_active_org() {
        let dir = temp_dir("org");
        let path = dir.join("auth.json");
        let first = ensure_local_session(&path, "Tim", "tim@example.com", "BKK").unwrap();
        let second = create_org(&path, "Remote Ops").unwrap();
        assert_eq!(second.users.len(), 1);
        assert_eq!(second.orgs.len(), 2);
        assert_ne!(first.active_org_id, second.active_org_id);
        assert_eq!(
            second
                .orgs
                .iter()
                .find(|o| o.id == second.active_org_id)
                .unwrap()
                .name,
            "Remote Ops"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sync_folder_exports_and_imports_scoped_state() {
        let sync_dir = temp_dir("shared");

        let device_a = temp_dir("device_a");
        let auth_a = device_a.join("auth.json");
        let root_a = device_a.join("auth");
        ensure_local_session(&auth_a, "Tim", "tim@example.com", "BKK").unwrap();
        set_sync_folder(&auth_a, &sync_dir).unwrap();
        let mut value = serde_json::Map::new();
        value.insert(
            "view".into(),
            Value::String("plugin:building-workspace".into()),
        );
        value.insert("sidebarCollapsed".into(), Value::Bool(true));
        save_user_state(&auth_a, &root_a, None, None, Value::Object(value)).unwrap();
        let pushed = sync_now(&auth_a, &root_a).unwrap();
        assert!(pushed.exported);
        assert!(!pushed.imported);
        assert!(PathBuf::from(&pushed.path).exists());

        let device_b = temp_dir("device_b");
        let auth_b = device_b.join("auth.json");
        let root_b = device_b.join("auth");
        let before = load_auth(&auth_b);
        assert!(before.users.is_empty());
        set_sync_folder(&auth_b, &sync_dir).unwrap();
        let pulled = sync_now(&auth_b, &root_b).unwrap();
        assert!(pulled.imported);
        assert!(pulled.state.session.is_some());
        assert_eq!(pulled.state.users.len(), 1);
        assert_eq!(pulled.state.orgs.len(), 1);
        let loaded = load_user_state(&auth_b, &root_b, None, None).unwrap();
        assert_eq!(loaded["view"], "plugin:building-workspace");
        assert_eq!(loaded["sidebarCollapsed"], true);

        let _ = std::fs::remove_dir_all(sync_dir);
        let _ = std::fs::remove_dir_all(device_a);
        let _ = std::fs::remove_dir_all(device_b);
    }

    #[test]
    fn sanitize_key_blocks_path_segments() {
        assert_eq!(sanitize_key("../org/id"), "___org_id");
        assert_eq!(sanitize_key("org_123-ABC"), "org_123-ABC");
    }

    #[test]
    fn merge_snapshot_rejects_unknown_schema() {
        let dir = temp_dir("badschema");
        let auth_path = dir.join("auth.json");
        let root = dir.join("auth");
        // A file dropped in the sync folder with the wrong/absent schema must be
        // refused before any of its accounts/state are trusted.
        let snap = serde_json::json!({ "schema": "evil.v9", "auth": {}, "states": {} });
        let err = merge_snapshot(&auth_path, &root, snap).unwrap_err();
        assert!(err.contains("schema"), "expected a schema error, got: {err}");
        let missing = serde_json::json!({ "auth": {}, "states": {} });
        assert!(merge_snapshot(&auth_path, &root, missing).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn ids_are_unique_across_calls() {
        // CSPRNG-backed ids must not collide (they are used as path segments and
        // sync join keys).
        let mut seen = std::collections::HashSet::new();
        for _ in 0..1000 {
            assert!(seen.insert(generate_id("usr")), "duplicate id generated");
        }
    }
}
