//! Supabase Cloud sync engine for the controller inventory (Phase 2 scaffold).
//!
//! Architecture: local SQLite (see `inventory_db`) is the source of truth. This
//! module orchestrates a push/pull round-trip over a transport-agnostic
//! [`SyncTransport`]:
//!
//! 1. PUSH local rows changed since `last_push_at` (including tombstones).
//! 2. Advance the push cursor.
//! 3. PULL remote rows changed since `last_pull_at`.
//! 4. APPLY them with last-write-wins by `updatedAt` (+ tombstones).
//! 5. Advance the pull cursor.
//!
//! The transport is abstracted so the conflict/cursor logic is fully unit-tested
//! offline (see [`MemoryTransport`]). The concrete Supabase REST transport (auth
//! via the keyring-stored session token in [`store_session_token`], `org_id`
//! scoping enforced by RLS — see `supabase/migrations/0001_inventory.sql`) is the
//! remaining integration step and slots in behind this same trait.
//!
//! Phase 2 scaffold: the orchestrator and transport are exercised by the unit
//! tests but not yet wired to Tauri commands (that lands with the concrete
//! Supabase REST transport), so dead_code is allowed module-wide until then.
#![allow(dead_code)]

use std::collections::HashMap;

use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::inventory_db;

pub const ENTITIES_TABLE: &str = "inventory_entities";

const KEYRING_SERVICE: &str = "com.stierbuildings.utilities";
const SUPABASE_SESSION_ACCOUNT: &str = "supabase-session";

/// Exchanges sync records with a remote. Implementors must treat `since` as an
/// exclusive lower bound on `updatedAt` and return records ordered by `updatedAt`.
pub trait SyncTransport {
    fn push(&mut self, table: &str, records: Vec<Value>) -> Result<(), String>;
    fn pull(&mut self, table: &str, since: Option<String>) -> Result<Vec<Value>, String>;
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub pushed: usize,
    pub pulled: usize,
    pub applied: usize,
}

fn max_updated_at(records: &[Value]) -> Option<String> {
    records
        .iter()
        .filter_map(|r| r.get("updatedAt").and_then(|v| v.as_str()))
        .max()
        .map(|s| s.to_string())
}

/// Run one inventory sync round-trip against `transport`, advancing the cursors.
pub fn sync_entities(
    conn: &mut rusqlite::Connection,
    org_id: &str,
    user_id: &str,
    transport: &mut dyn SyncTransport,
) -> Result<SyncReport, String> {
    let (last_pull, last_push) = inventory_db::get_sync_cursor(conn, org_id, user_id, ENTITIES_TABLE);

    let dirty = inventory_db::collect_entities_changed_since(
        conn,
        org_id,
        user_id,
        last_push.as_deref(),
    )?;
    let pushed = dirty.len();
    let push_high = max_updated_at(&dirty);
    transport.push(ENTITIES_TABLE, dirty)?;
    if let Some(ts) = push_high.as_deref() {
        inventory_db::set_sync_cursor(conn, org_id, user_id, ENTITIES_TABLE, None, Some(ts))?;
    }

    let remote = transport.pull(ENTITIES_TABLE, last_pull)?;
    let pulled = remote.len();
    let pull_high = max_updated_at(&remote);
    let applied = inventory_db::apply_entity_records(conn, org_id, user_id, &remote)?;
    if let Some(ts) = pull_high.as_deref() {
        inventory_db::set_sync_cursor(conn, org_id, user_id, ENTITIES_TABLE, Some(ts), None)?;
    }

    Ok(SyncReport { pushed, pulled, applied })
}

// ---- Supabase session token (OS keyring) ----

fn session_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, SUPABASE_SESSION_ACCOUNT).map_err(|e| e.to_string())
}

/// Persist the Supabase session JWT in the OS credential store (same store the
/// InfluxDB token uses). The concrete Supabase transport reads it to authenticate.
pub fn store_session_token(token: &str) -> Result<(), String> {
    session_entry()?.set_password(token).map_err(|e| e.to_string())
}

pub fn load_session_token() -> Result<Option<String>, String> {
    match session_entry()?.get_password() {
        Ok(token) if !token.is_empty() => Ok(Some(token)),
        Ok(_) => Ok(None),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn clear_session_token() -> Result<(), String> {
    match session_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---- Supabase Cloud transport (PostgREST) ----
//
// The request/response mapping is pure and unit-tested; the wire calls use the
// blocking `ureq` client. RLS (see supabase/migrations/0001_inventory.sql) scopes
// every row to the caller's org via the session JWT, and we also filter by
// org_id explicitly for clarity.

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SupabaseConfig {
    pub base_url: String,
    pub anon_key: String,
}

/// `{base}/rest/v1/{table}` (PostgREST collection endpoint).
pub fn rest_url(base_url: &str, table: &str) -> String {
    format!("{}/rest/v1/{}", base_url.trim_end_matches('/'), table)
}

/// Build a PostgREST pull query: org-scoped, changed-since, ordered by updated_at.
pub fn pull_url(base_url: &str, table: &str, org_id: &str, since: Option<&str>) -> String {
    let mut u = format!("{}?org_id=eq.{}&order=updated_at.asc", rest_url(base_url, table), org_id);
    if let Some(s) = since {
        u.push_str(&format!("&updated_at=gt.{s}"));
    }
    u
}

/// Map a local sync record ({id,data,updatedAt,deleted,rev}) into a PostgREST row
/// (adds org_id + extracted columns + content hash).
pub fn push_row(org_id: &str, record: &Value) -> Value {
    let data = record.get("data").cloned().unwrap_or(Value::Null);
    let data_str = serde_json::to_string(&data).unwrap_or_else(|_| "null".into());
    serde_json::json!({
        "org_id": org_id,
        "id": record.get("id").and_then(|v| v.as_str()).unwrap_or(""),
        "type": data.get("type").and_then(|v| v.as_str()).unwrap_or(""),
        "name": data.get("name").and_then(|v| v.as_str()),
        "data": data,
        "content_hash": inventory_db::content_hash(&data_str),
        "updated_at": record.get("updatedAt").and_then(|v| v.as_str()).unwrap_or(""),
        "deleted": record.get("deleted").and_then(|v| v.as_bool()).unwrap_or(false),
        "rev": record.get("rev").and_then(|v| v.as_i64()).unwrap_or(1),
    })
}

/// Map a PostgREST row back into the local sync-record shape `apply_entity_records` expects.
pub fn pull_record(row: &Value) -> Value {
    serde_json::json!({
        "id": row.get("id").and_then(|v| v.as_str()).unwrap_or(""),
        "data": row.get("data").cloned().unwrap_or(Value::Null),
        "updatedAt": row.get("updated_at").and_then(|v| v.as_str()).unwrap_or(""),
        "deleted": row.get("deleted").and_then(|v| v.as_bool()).unwrap_or(false),
        "rev": row.get("rev").and_then(|v| v.as_i64()).unwrap_or(1),
    })
}

/// Live Supabase transport over PostgREST. Authenticates with the anon key +
/// the user's session JWT; scoped to one org.
pub struct SupabaseTransport {
    cfg: SupabaseConfig,
    token: String,
    org_id: String,
}

impl SupabaseTransport {
    pub fn new(cfg: SupabaseConfig, token: String, org_id: String) -> Self {
        Self { cfg, token, org_id }
    }
}

impl SyncTransport for SupabaseTransport {
    fn push(&mut self, table: &str, records: Vec<Value>) -> Result<(), String> {
        if records.is_empty() {
            return Ok(());
        }
        let rows: Vec<Value> = records.iter().map(|r| push_row(&self.org_id, r)).collect();
        let resp = ureq::post(&rest_url(&self.cfg.base_url, table))
            .set("apikey", &self.cfg.anon_key)
            .set("Authorization", &format!("Bearer {}", self.token))
            .set("Content-Type", "application/json")
            .set("Prefer", "resolution=merge-duplicates,return=minimal")
            .send_json(Value::Array(rows));
        match resp {
            Ok(_) => Ok(()),
            Err(ureq::Error::Status(code, r)) => Err(format!(
                "supabase push {code}: {}",
                r.into_string().unwrap_or_default()
            )),
            Err(e) => Err(format!("supabase push error: {e}")),
        }
    }

    fn pull(&mut self, table: &str, since: Option<String>) -> Result<Vec<Value>, String> {
        let url = pull_url(&self.cfg.base_url, table, &self.org_id, since.as_deref());
        let resp = ureq::get(&url)
            .set("apikey", &self.cfg.anon_key)
            .set("Authorization", &format!("Bearer {}", self.token))
            .call();
        let body = match resp {
            Ok(r) => r.into_json::<Value>().map_err(|e| format!("supabase pull decode: {e}"))?,
            Err(ureq::Error::Status(code, r)) => {
                return Err(format!("supabase pull {code}: {}", r.into_string().unwrap_or_default()))
            }
            Err(e) => return Err(format!("supabase pull error: {e}")),
        };
        Ok(body
            .as_array()
            .map(|rows| rows.iter().map(pull_record).collect())
            .unwrap_or_default())
    }
}

/// In-memory stand-in for the remote, used by tests (and as a reference for the
/// pull contract). Keyed by table -> id -> record, keeping the newest by
/// `updatedAt` on push.
#[derive(Default)]
pub struct MemoryTransport {
    store: HashMap<String, HashMap<String, Value>>,
}

impl MemoryTransport {
    pub fn new() -> Self {
        Self::default()
    }
}

impl SyncTransport for MemoryTransport {
    fn push(&mut self, table: &str, records: Vec<Value>) -> Result<(), String> {
        let bucket = self.store.entry(table.to_string()).or_default();
        for rec in records {
            let id = match rec.get("id").and_then(|v| v.as_str()) {
                Some(id) => id.to_string(),
                None => continue,
            };
            let incoming = rec.get("updatedAt").and_then(|v| v.as_str()).unwrap_or("");
            let keep = bucket
                .get(&id)
                .and_then(|existing| existing.get("updatedAt").and_then(|v| v.as_str()))
                .map(|cur| cur >= incoming)
                .unwrap_or(false);
            if !keep {
                bucket.insert(id, rec);
            }
        }
        Ok(())
    }

    fn pull(&mut self, table: &str, since: Option<String>) -> Result<Vec<Value>, String> {
        let mut out: Vec<Value> = self
            .store
            .get(table)
            .map(|bucket| {
                bucket
                    .values()
                    .filter(|rec| match &since {
                        Some(s) => {
                            rec.get("updatedAt").and_then(|v| v.as_str()).unwrap_or("") > s.as_str()
                        }
                        None => true,
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        out.sort_by(|a, b| {
            a.get("updatedAt")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .cmp(b.get("updatedAt").and_then(|v| v.as_str()).unwrap_or(""))
        });
        Ok(out)
    }
}

// ---- Tauri commands (Windows-gated, like the rest of the scoped persistence) ----

#[cfg(windows)]
fn config_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?
        .join("inventory");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("supabase.json"))
}

#[cfg(windows)]
fn load_config(app: &tauri::AppHandle) -> Result<Option<SupabaseConfig>, String> {
    let path = config_path(app)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str::<SupabaseConfig>(&s)
            .map(Some)
            .map_err(|e| format!("parse supabase config: {e}")),
        Err(_) => Ok(None),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub configured: bool,
    pub has_session: bool,
    pub base_url: String,
}

/// Configure the Supabase project (base URL + anon key) and store the user's
/// session JWT in the OS keyring.
#[cfg(windows)]
#[tauri::command]
pub fn inventory_sync_set_session(
    app: tauri::AppHandle,
    base_url: String,
    anon_key: String,
    token: String,
) -> Result<(), String> {
    let cfg = SupabaseConfig { base_url, anon_key };
    let json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(config_path(&app)?, json).map_err(|e| e.to_string())?;
    store_session_token(&token)
}

/// Clear the stored Supabase session (keeps the project config).
#[cfg(windows)]
#[tauri::command]
pub fn inventory_sync_clear_session() -> Result<(), String> {
    clear_session_token()
}

/// Report whether cloud sync is configured and signed in.
#[cfg(windows)]
#[tauri::command]
pub fn inventory_sync_status(app: tauri::AppHandle) -> Result<SyncStatus, String> {
    let cfg = load_config(&app)?;
    Ok(SyncStatus {
        configured: cfg.is_some(),
        has_session: load_session_token()?.is_some(),
        base_url: cfg.map(|c| c.base_url).unwrap_or_default(),
    })
}

/// Run one inventory sync round-trip against the configured Supabase project for
/// the active org/user scope.
#[cfg(windows)]
#[tauri::command]
pub fn inventory_sync_now(app: tauri::AppHandle) -> Result<SyncReport, String> {
    let token = load_session_token()?.ok_or("no Supabase session; sign in first")?;
    let cfg = load_config(&app)?.ok_or("Supabase is not configured")?;
    let (user_id, org_id) = inventory_db::active_scope(&app)?;
    let mut conn = inventory_db::open_db_for(&app)?;
    let mut transport = SupabaseTransport::new(cfg, token, org_id.clone());
    sync_entities(&mut conn, &org_id, &user_id, &mut transport)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_db(tag: &str) -> rusqlite::Connection {
        let path = std::env::temp_dir().join(format!(
            "stier_sync_{}_{}_{}.db",
            std::process::id(),
            tag,
            inventory_db_now()
        ));
        let _ = std::fs::remove_file(&path);
        inventory_db::open_at(&path).unwrap()
    }

    // Tiny nonce so parallel tests don't share a file.
    fn inventory_db_now() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    }

    fn seed(conn: &mut rusqlite::Connection, org: &str, user: &str, entities: Value) {
        let snap = json!({ "entities": entities });
        inventory_db::save_snapshot_inner(conn, org, user, &snap).unwrap();
    }

    #[test]
    fn two_clients_converge_through_the_transport() {
        let mut a = temp_db("a");
        let mut b = temp_db("b");
        let mut server = MemoryTransport::new();

        seed(
            &mut a,
            "org",
            "user",
            json!([{ "id": "equip:1", "type": "equip", "name": "FromA",
                     "updatedAt": "2025-01-01T00:00:00Z" }]),
        );

        // A pushes its row to the server.
        let ra = sync_entities(&mut a, "org", "user", &mut server).unwrap();
        assert_eq!(ra.pushed, 1);

        // B pulls and applies it.
        let rb = sync_entities(&mut b, "org", "user", &mut server).unwrap();
        assert_eq!(rb.applied, 1);
        let loaded = inventory_db::load_snapshot_inner(&b, "org", "user").unwrap();
        assert!(loaded["entities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["name"] == "FromA"));

        // A re-sync is a no-op for already-pushed rows (cursor advanced).
        let ra2 = sync_entities(&mut a, "org", "user", &mut server).unwrap();
        assert_eq!(ra2.pushed, 0);
    }

    #[test]
    fn supabase_url_and_row_mapping_is_correct() {
        assert_eq!(
            rest_url("https://x.supabase.co/", "inventory_entities"),
            "https://x.supabase.co/rest/v1/inventory_entities"
        );
        assert_eq!(
            pull_url("https://x.supabase.co", "inventory_entities", "org1", Some("2025-01-01T00:00:00Z")),
            "https://x.supabase.co/rest/v1/inventory_entities?org_id=eq.org1&order=updated_at.asc&updated_at=gt.2025-01-01T00:00:00Z"
        );
        let rec = json!({
            "id": "equip:1",
            "data": { "id": "equip:1", "type": "equip", "name": "AHU" },
            "updatedAt": "2025-01-01T00:00:00Z",
            "deleted": false,
            "rev": 3
        });
        let row = push_row("org1", &rec);
        assert_eq!(row["org_id"], "org1");
        assert_eq!(row["id"], "equip:1");
        assert_eq!(row["type"], "equip");
        assert_eq!(row["name"], "AHU");
        assert!(row["content_hash"].as_str().unwrap().len() > 0);
        // Round-trips back to the local record shape.
        let pg_row = json!({
            "id": "equip:1", "data": { "type": "equip" },
            "updated_at": "2025-01-01T00:00:00Z", "deleted": false, "rev": 3
        });
        let back = pull_record(&pg_row);
        assert_eq!(back["updatedAt"], "2025-01-01T00:00:00Z");
        assert_eq!(back["id"], "equip:1");
    }

    #[test]
    fn keyring_session_token_roundtrips() {
        // Best-effort: the CI keyring may be unavailable; only assert when writable.
        if store_session_token("jwt-abc").is_ok() {
            assert_eq!(load_session_token().unwrap().as_deref(), Some("jwt-abc"));
            clear_session_token().unwrap();
            assert_eq!(load_session_token().unwrap(), None);
        }
    }
}
