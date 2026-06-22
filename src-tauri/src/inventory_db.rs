//! Local-first controller inventory + BACnet discovery cache, backed by an
//! embedded SQLite database.
//!
//! This is the durable replacement for the JSON-blob persistence that used to
//! live inside the `microtools.user_state.v2` user-state file. The schema is
//! row-per-entity (entity body stored as JSON to preserve the flexible Haystack
//! tag model) and carries sync metadata (`content_hash`, `updated_at`,
//! `deleted` tombstones, `rev`) so a later Supabase Cloud sync layer can mirror
//! the same rows without changing the frontend contract.
//!
//! Rows are scoped by `org_id` / `user_id` (resolved from the active auth
//! session, exactly like the legacy per-org/user state files) so switching
//! organizations swaps the visible inventory.

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde_json::{Map, Value};

use crate::auth;

#[cfg(windows)]
fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))
}

#[cfg(windows)]
fn auth_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("auth").join("auth.json"))
}

#[cfg(windows)]
fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = config_dir(app)?.join("inventory");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create inventory dir: {e}"))?;
    Ok(dir.join("inventory.db"))
}

/// Resolve the active (user_id, org_id) scope. Explicit ids win; otherwise the
/// active auth session is used. Errors when there is no session so callers can
/// fall back to the legacy user-state storage.
#[cfg(windows)]
fn resolve_scope(
    app: &tauri::AppHandle,
    user_id: Option<String>,
    org_id: Option<String>,
) -> Result<(String, String), String> {
    match (user_id, org_id) {
        (Some(u), Some(o)) if !u.trim().is_empty() && !o.trim().is_empty() => {
            Ok((u.trim().into(), o.trim().into()))
        }
        _ => {
            let state = auth::load_auth(&auth_file(app)?);
            if let Some(session) = state.session {
                Ok((session.user_id, session.org_id))
            } else {
                Err("no active auth session".into())
            }
        }
    }
}

/// FNV-1a 64-bit over the canonical entity JSON. Deterministic across runs so it
/// doubles as a change detector (skip rev bumps when content is unchanged) and a
/// future sync content fingerprint.
pub fn content_hash(data: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in data.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    epoch_to_iso(secs)
}

/// Format epoch seconds as `YYYY-MM-DDTHH:MM:SSZ` (UTC). Uses Howard Hinnant's
/// days-to-civil algorithm so we don't pull in a date crate just for tombstone
/// timestamps. ISO 8601 keeps it lexicographically comparable for sync LWW.
fn epoch_to_iso(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

#[cfg(windows)]
fn open_db(app: &tauri::AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(db_path(app)?).map_err(|e| format!("open inventory db: {e}"))?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS inventory_entities (
           org_id TEXT NOT NULL,
           user_id TEXT NOT NULL,
           id TEXT NOT NULL,
           type TEXT NOT NULL,
           name TEXT,
           data TEXT NOT NULL,
           content_hash TEXT NOT NULL,
           created_at TEXT,
           updated_at TEXT,
           deleted INTEGER NOT NULL DEFAULT 0,
           rev INTEGER NOT NULL DEFAULT 1,
           PRIMARY KEY (org_id, user_id, id)
         );
         CREATE INDEX IF NOT EXISTS idx_inventory_scope_type
           ON inventory_entities (org_id, user_id, type, deleted);
         CREATE TABLE IF NOT EXISTS bacnet_discovery_cache (
           org_id TEXT NOT NULL,
           user_id TEXT NOT NULL,
           key TEXT NOT NULL,
           data TEXT NOT NULL,
           content_hash TEXT NOT NULL,
           seen_at TEXT,
           updated_at TEXT,
           deleted INTEGER NOT NULL DEFAULT 0,
           rev INTEGER NOT NULL DEFAULT 1,
           PRIMARY KEY (org_id, user_id, key)
         );
         CREATE TABLE IF NOT EXISTS sync_meta (
           org_id TEXT NOT NULL,
           user_id TEXT NOT NULL,
           table_name TEXT NOT NULL,
           last_pull_at TEXT,
           last_push_at TEXT,
           PRIMARY KEY (org_id, user_id, table_name)
         );",
    )
    .map_err(|e| format!("migrate inventory db: {e}"))
}

fn str_field<'a>(entity: &'a Value, key: &str) -> Option<&'a str> {
    entity.get(key).and_then(|v| v.as_str())
}

/// Resolve the active (user_id, org_id) scope for callers outside this module
/// (e.g. the sync engine). Errors when there's no session.
#[cfg(windows)]
pub fn active_scope(app: &tauri::AppHandle) -> Result<(String, String), String> {
    resolve_scope(app, None, None)
}

/// Open the scoped inventory DB for callers outside this module.
#[cfg(windows)]
pub fn open_db_for(app: &tauri::AppHandle) -> Result<Connection, String> {
    open_db(app)
}

/// Load the full inventory snapshot for a scope as `{ version, entities: [...] }`.
/// Tombstoned rows are excluded; the frontend inventory service re-seeds bundled
/// templates on load so an empty result is fine.
pub fn load_snapshot_inner(conn: &Connection, org_id: &str, user_id: &str) -> Result<Value, String> {
    let mut stmt = conn
        .prepare(
            "SELECT data FROM inventory_entities
             WHERE org_id = ?1 AND user_id = ?2 AND deleted = 0
             ORDER BY type, id",
        )
        .map_err(|e| format!("prepare load: {e}"))?;
    let rows = stmt
        .query_map(params![org_id, user_id], |row| row.get::<_, String>(0))
        .map_err(|e| format!("query load: {e}"))?;
    let mut entities: Vec<Value> = Vec::new();
    for row in rows {
        let raw = row.map_err(|e| format!("read row: {e}"))?;
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            entities.push(value);
        }
    }
    let mut out = Map::new();
    out.insert("version".into(), Value::from(1));
    out.insert("entities".into(), Value::Array(entities));
    Ok(Value::Object(out))
}

/// Apply a whole-snapshot save: upsert every present entity (bumping rev/updated
/// only when the content hash actually changed) and tombstone rows that are no
/// longer present, all in a single transaction.
pub fn save_snapshot_inner(
    conn: &mut Connection,
    org_id: &str,
    user_id: &str,
    snapshot: &Value,
) -> Result<(), String> {
    let empty: Vec<Value> = Vec::new();
    let entities = snapshot
        .get("entities")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);

    let tx = conn
        .transaction()
        .map_err(|e| format!("begin txn: {e}"))?;
    let mut incoming: HashSet<String> = HashSet::with_capacity(entities.len());

    for entity in entities {
        let id = match str_field(entity, "id") {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => continue,
        };
        incoming.insert(id.clone());
        let etype = str_field(entity, "type").unwrap_or("").to_string();
        let name = str_field(entity, "name").map(|s| s.to_string());
        let data = serde_json::to_string(entity).map_err(|e| format!("serialize entity: {e}"))?;
        let hash = content_hash(&data);
        let updated_at = str_field(entity, "updatedAt")
            .map(|s| s.to_string())
            .unwrap_or_else(now_iso);
        let created_at = str_field(entity, "createdAt")
            .map(|s| s.to_string())
            .unwrap_or_else(|| updated_at.clone());

        let existing: Option<(String, i64, i64)> = tx
            .query_row(
                "SELECT content_hash, rev, deleted FROM inventory_entities
                 WHERE org_id = ?1 AND user_id = ?2 AND id = ?3",
                params![org_id, user_id, id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .ok();

        match existing {
            // Unchanged and live: skip so we don't churn rev/updated_at (keeps
            // sync quiet for no-op saves).
            Some((prev_hash, _, deleted)) if prev_hash == hash && deleted == 0 => continue,
            Some((_, rev, _)) => {
                tx.execute(
                    "UPDATE inventory_entities
                     SET type = ?4, name = ?5, data = ?6, content_hash = ?7,
                         created_at = ?8, updated_at = ?9, deleted = 0, rev = ?10
                     WHERE org_id = ?1 AND user_id = ?2 AND id = ?3",
                    params![
                        org_id, user_id, id, etype, name, data, hash, created_at, updated_at,
                        rev + 1
                    ],
                )
                .map_err(|e| format!("update entity: {e}"))?;
            }
            None => {
                tx.execute(
                    "INSERT INTO inventory_entities
                       (org_id, user_id, id, type, name, data, content_hash,
                        created_at, updated_at, deleted, rev)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 1)",
                    params![
                        org_id, user_id, id, etype, name, data, hash, created_at, updated_at
                    ],
                )
                .map_err(|e| format!("insert entity: {e}"))?;
            }
        }
    }

    // Tombstone rows that vanished from the snapshot.
    let stale: Vec<String> = {
        let mut stmt = tx
            .prepare(
                "SELECT id FROM inventory_entities
                 WHERE org_id = ?1 AND user_id = ?2 AND deleted = 0",
            )
            .map_err(|e| format!("prepare stale scan: {e}"))?;
        let ids = stmt
            .query_map(params![org_id, user_id], |row| row.get::<_, String>(0))
            .map_err(|e| format!("scan stale: {e}"))?;
        let mut out = Vec::new();
        for id in ids {
            let id = id.map_err(|e| format!("read stale id: {e}"))?;
            if !incoming.contains(&id) {
                out.push(id);
            }
        }
        out
    };
    let ts = now_iso();
    for id in stale {
        tx.execute(
            "UPDATE inventory_entities
             SET deleted = 1, rev = rev + 1, updated_at = ?4
             WHERE org_id = ?1 AND user_id = ?2 AND id = ?3",
            params![org_id, user_id, id, ts],
        )
        .map_err(|e| format!("tombstone entity: {e}"))?;
    }

    tx.commit().map_err(|e| format!("commit txn: {e}"))
}

fn bacnet_key(device: &Value) -> Option<String> {
    if let Some(k) = str_field(device, "key") {
        if !k.is_empty() {
            return Some(k.to_string());
        }
    }
    // Fall back to the instance number so a device without a precomputed key
    // still gets a stable primary key.
    device
        .get("instance")
        .and_then(|v| v.as_u64())
        .map(|i| format!("instance:{i}"))
}

fn load_bacnet_cache_inner(
    conn: &Connection,
    org_id: &str,
    user_id: &str,
) -> Result<Value, String> {
    let mut stmt = conn
        .prepare(
            "SELECT data FROM bacnet_discovery_cache
             WHERE org_id = ?1 AND user_id = ?2 AND deleted = 0
             ORDER BY key",
        )
        .map_err(|e| format!("prepare bacnet load: {e}"))?;
    let rows = stmt
        .query_map(params![org_id, user_id], |row| row.get::<_, String>(0))
        .map_err(|e| format!("query bacnet load: {e}"))?;
    let mut devices: Vec<Value> = Vec::new();
    for row in rows {
        let raw = row.map_err(|e| format!("read bacnet row: {e}"))?;
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            devices.push(value);
        }
    }
    Ok(Value::Array(devices))
}

fn save_bacnet_cache_inner(
    conn: &mut Connection,
    org_id: &str,
    user_id: &str,
    devices: &Value,
) -> Result<(), String> {
    let empty: Vec<Value> = Vec::new();
    let list = devices.as_array().unwrap_or(&empty);

    let tx = conn
        .transaction()
        .map_err(|e| format!("begin bacnet txn: {e}"))?;
    let mut incoming: HashSet<String> = HashSet::with_capacity(list.len());
    let ts = now_iso();

    for device in list {
        let key = match bacnet_key(device) {
            Some(k) => k,
            None => continue,
        };
        incoming.insert(key.clone());
        let data = serde_json::to_string(device).map_err(|e| format!("serialize device: {e}"))?;
        let hash = content_hash(&data);

        let existing: Option<(String, i64, i64)> = tx
            .query_row(
                "SELECT content_hash, rev, deleted FROM bacnet_discovery_cache
                 WHERE org_id = ?1 AND user_id = ?2 AND key = ?3",
                params![org_id, user_id, key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .ok();

        match existing {
            Some((prev_hash, _, deleted)) if prev_hash == hash && deleted == 0 => continue,
            Some((_, rev, _)) => {
                tx.execute(
                    "UPDATE bacnet_discovery_cache
                     SET data = ?4, content_hash = ?5, seen_at = ?6, updated_at = ?6,
                         deleted = 0, rev = ?7
                     WHERE org_id = ?1 AND user_id = ?2 AND key = ?3",
                    params![org_id, user_id, key, data, hash, ts, rev + 1],
                )
                .map_err(|e| format!("update device: {e}"))?;
            }
            None => {
                tx.execute(
                    "INSERT INTO bacnet_discovery_cache
                       (org_id, user_id, key, data, content_hash, seen_at, updated_at, deleted, rev)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 0, 1)",
                    params![org_id, user_id, key, data, hash, ts],
                )
                .map_err(|e| format!("insert device: {e}"))?;
            }
        }
    }

    let stale: Vec<String> = {
        let mut stmt = tx
            .prepare(
                "SELECT key FROM bacnet_discovery_cache
                 WHERE org_id = ?1 AND user_id = ?2 AND deleted = 0",
            )
            .map_err(|e| format!("prepare bacnet stale: {e}"))?;
        let keys = stmt
            .query_map(params![org_id, user_id], |row| row.get::<_, String>(0))
            .map_err(|e| format!("scan bacnet stale: {e}"))?;
        let mut out = Vec::new();
        for key in keys {
            let key = key.map_err(|e| format!("read bacnet stale key: {e}"))?;
            if !incoming.contains(&key) {
                out.push(key);
            }
        }
        out
    };
    for key in stale {
        tx.execute(
            "UPDATE bacnet_discovery_cache
             SET deleted = 1, rev = rev + 1, updated_at = ?4
             WHERE org_id = ?1 AND user_id = ?2 AND key = ?3",
            params![org_id, user_id, key, ts],
        )
        .map_err(|e| format!("tombstone device: {e}"))?;
    }

    tx.commit().map_err(|e| format!("commit bacnet txn: {e}"))
}

// ---- Sync primitives (Phase 2 foundation) ----
//
// These are the local half of the Supabase sync engine: pure SQLite operations
// that (a) collect rows changed since a cursor to PUSH upstream, and (b) APPLY
// remote rows with last-write-wins by `updated_at` and tombstone reconciliation.
// They are transport-agnostic so they can be unit-tested without a network, and
// the orchestration over a `SyncTransport` lives in `inventory_sync.rs`.

// These primitives are consumed by `inventory_sync` (the Phase 2 engine), which
// is not yet wired to a live transport / Tauri command, so allow dead_code here
// until that integration lands.

/// A row shaped for the wire: the entity/device body plus the sync metadata the
/// remote needs to reconcile (`updatedAt`, `deleted`, `rev`).
#[allow(dead_code)]
fn row_to_record(id_key: &str, data: &str, updated_at: &str, deleted: i64, rev: i64) -> Value {
    let body = serde_json::from_str::<Value>(data).unwrap_or(Value::Null);
    serde_json::json!({
        "id": id_key,
        "data": body,
        "updatedAt": updated_at,
        "deleted": deleted != 0,
        "rev": rev,
    })
}

/// Collect inventory rows whose `updated_at` is strictly newer than `since`
/// (all rows when `since` is None), including tombstones, for an upstream push.
#[allow(dead_code)]
pub fn collect_entities_changed_since(
    conn: &Connection,
    org_id: &str,
    user_id: &str,
    since: Option<&str>,
) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, data, updated_at, deleted, rev FROM inventory_entities
             WHERE org_id = ?1 AND user_id = ?2 AND (?3 IS NULL OR updated_at > ?3)
             ORDER BY updated_at",
        )
        .map_err(|e| format!("prepare collect: {e}"))?;
    let rows = stmt
        .query_map(params![org_id, user_id, since], |row| {
            Ok(row_to_record(
                &row.get::<_, String>(0)?,
                &row.get::<_, String>(1)?,
                &row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(|e| format!("collect: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("read record: {e}"))?);
    }
    Ok(out)
}

/// Apply remote inventory records with last-write-wins: a record is written only
/// when its `updatedAt` is newer than the local row (or the row is absent). ISO
/// 8601 timestamps compare lexicographically. Returns the count actually applied.
#[allow(dead_code)]
pub fn apply_entity_records(
    conn: &mut Connection,
    org_id: &str,
    user_id: &str,
    records: &[Value],
) -> Result<usize, String> {
    let tx = conn.transaction().map_err(|e| format!("begin apply txn: {e}"))?;
    let mut applied = 0usize;
    for rec in records {
        let id = match rec.get("id").and_then(|v| v.as_str()) {
            Some(id) if !id.is_empty() => id,
            _ => continue,
        };
        let remote_updated = rec.get("updatedAt").and_then(|v| v.as_str()).unwrap_or("");
        let remote_deleted = rec.get("deleted").and_then(|v| v.as_bool()).unwrap_or(false);
        let body = rec.get("data").cloned().unwrap_or(Value::Null);
        let data = serde_json::to_string(&body).map_err(|e| format!("serialize remote: {e}"))?;
        let hash = content_hash(&data);
        let etype = body.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let name = body.get("name").and_then(|v| v.as_str()).map(|s| s.to_string());
        let created_at = body
            .get("createdAt")
            .and_then(|v| v.as_str())
            .unwrap_or(remote_updated)
            .to_string();

        let local: Option<(String, i64)> = tx
            .query_row(
                "SELECT updated_at, rev FROM inventory_entities
                 WHERE org_id = ?1 AND user_id = ?2 AND id = ?3",
                params![org_id, user_id, id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();

        match local {
            // Local is newer or equal -> keep local (last-write-wins).
            Some((local_updated, _)) if local_updated.as_str() >= remote_updated => continue,
            Some((_, rev)) => {
                tx.execute(
                    "UPDATE inventory_entities
                     SET type = ?4, name = ?5, data = ?6, content_hash = ?7,
                         created_at = ?8, updated_at = ?9, deleted = ?10, rev = ?11
                     WHERE org_id = ?1 AND user_id = ?2 AND id = ?3",
                    params![
                        org_id, user_id, id, etype, name, data, hash, created_at,
                        remote_updated, remote_deleted as i64, rev + 1
                    ],
                )
                .map_err(|e| format!("apply update: {e}"))?;
            }
            None => {
                tx.execute(
                    "INSERT INTO inventory_entities
                       (org_id, user_id, id, type, name, data, content_hash,
                        created_at, updated_at, deleted, rev)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1)",
                    params![
                        org_id, user_id, id, etype, name, data, hash, created_at,
                        remote_updated, remote_deleted as i64
                    ],
                )
                .map_err(|e| format!("apply insert: {e}"))?;
            }
        }
        applied += 1;
    }
    tx.commit().map_err(|e| format!("commit apply: {e}"))?;
    Ok(applied)
}

/// Read the (last_pull_at, last_push_at) sync cursor for a scope/table.
#[allow(dead_code)]
pub fn get_sync_cursor(
    conn: &Connection,
    org_id: &str,
    user_id: &str,
    table: &str,
) -> (Option<String>, Option<String>) {
    conn.query_row(
        "SELECT last_pull_at, last_push_at FROM sync_meta
         WHERE org_id = ?1 AND user_id = ?2 AND table_name = ?3",
        params![org_id, user_id, table],
        |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
    )
    .unwrap_or((None, None))
}

/// Persist the sync cursor for a scope/table (upsert).
#[allow(dead_code)]
pub fn set_sync_cursor(
    conn: &Connection,
    org_id: &str,
    user_id: &str,
    table: &str,
    last_pull_at: Option<&str>,
    last_push_at: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO sync_meta (org_id, user_id, table_name, last_pull_at, last_push_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(org_id, user_id, table_name) DO UPDATE SET
           last_pull_at = COALESCE(excluded.last_pull_at, last_pull_at),
           last_push_at = COALESCE(excluded.last_push_at, last_push_at)",
        params![org_id, user_id, table, last_pull_at, last_push_at],
    )
    .map_err(|e| format!("set sync cursor: {e}"))?;
    Ok(())
}

/// Open a database connection at an explicit path (used by the sync orchestrator
/// and tests, which don't have a Tauri `AppHandle`).
#[allow(dead_code)]
pub fn open_at(path: &std::path::Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("open inventory db: {e}"))?;
    migrate(&conn)?;
    Ok(conn)
}

// ---- Tauri commands ----

#[cfg(windows)]
#[tauri::command]
pub fn inventory_load_snapshot(
    app: tauri::AppHandle,
    user_id: Option<String>,
    org_id: Option<String>,
) -> Result<Value, String> {
    let (user_id, org_id) = resolve_scope(&app, user_id, org_id)?;
    let conn = open_db(&app)?;
    load_snapshot_inner(&conn, &org_id, &user_id)
}

#[cfg(windows)]
#[tauri::command]
pub fn inventory_save_snapshot(
    app: tauri::AppHandle,
    user_id: Option<String>,
    org_id: Option<String>,
    snapshot: Value,
) -> Result<(), String> {
    let (user_id, org_id) = resolve_scope(&app, user_id, org_id)?;
    let mut conn = open_db(&app)?;
    save_snapshot_inner(&mut conn, &org_id, &user_id, &snapshot)
}

#[cfg(windows)]
#[tauri::command]
pub fn bacnet_cache_load(
    app: tauri::AppHandle,
    user_id: Option<String>,
    org_id: Option<String>,
) -> Result<Value, String> {
    let (user_id, org_id) = resolve_scope(&app, user_id, org_id)?;
    let conn = open_db(&app)?;
    load_bacnet_cache_inner(&conn, &org_id, &user_id)
}

#[cfg(windows)]
#[tauri::command]
pub fn bacnet_cache_save(
    app: tauri::AppHandle,
    user_id: Option<String>,
    org_id: Option<String>,
    devices: Value,
) -> Result<(), String> {
    let (user_id, org_id) = resolve_scope(&app, user_id, org_id)?;
    let mut conn = open_db(&app)?;
    save_bacnet_cache_inner(&mut conn, &org_id, &user_id, &devices)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn epoch_to_iso_formats_known_instants() {
        assert_eq!(epoch_to_iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(epoch_to_iso(1_700_000_000), "2023-11-14T22:13:20Z");
    }

    #[test]
    fn content_hash_is_stable_and_sensitive() {
        assert_eq!(content_hash("abc"), content_hash("abc"));
        assert_ne!(content_hash("abc"), content_hash("abd"));
    }

    #[test]
    fn save_then_load_roundtrips_entities() {
        let mut conn = mem();
        let snap = json!({
            "version": 1,
            "entities": [
                { "id": "site:1", "type": "site", "name": "Main" },
                { "id": "equip:1", "type": "equip", "name": "Device 1001",
                  "tags": { "equip": true, "device": true }, "deviceInstance": 1001 }
            ]
        });
        save_snapshot_inner(&mut conn, "org1", "user1", &snap).unwrap();
        let loaded = load_snapshot_inner(&conn, "org1", "user1").unwrap();
        let entities = loaded["entities"].as_array().unwrap();
        assert_eq!(entities.len(), 2);
        // Scope isolation: a different org sees nothing.
        let other = load_snapshot_inner(&conn, "org2", "user1").unwrap();
        assert_eq!(other["entities"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn removed_entities_are_tombstoned_and_hidden() {
        let mut conn = mem();
        let first = json!({ "entities": [
            { "id": "equip:1", "type": "equip", "name": "A" },
            { "id": "equip:2", "type": "equip", "name": "B" }
        ]});
        save_snapshot_inner(&mut conn, "o", "u", &first).unwrap();
        let second = json!({ "entities": [ { "id": "equip:1", "type": "equip", "name": "A" } ]});
        save_snapshot_inner(&mut conn, "o", "u", &second).unwrap();
        let loaded = load_snapshot_inner(&conn, "o", "u").unwrap();
        let ids: Vec<&str> = loaded["entities"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["equip:1"]);
        // The tombstone bumped rev on equip:2.
        let rev: i64 = conn
            .query_row(
                "SELECT rev FROM inventory_entities WHERE id = 'equip:2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rev, 2);
    }

    #[test]
    fn unchanged_entity_does_not_bump_rev() {
        let mut conn = mem();
        let snap = json!({ "entities": [ { "id": "equip:1", "type": "equip", "name": "A" } ]});
        save_snapshot_inner(&mut conn, "o", "u", &snap).unwrap();
        save_snapshot_inner(&mut conn, "o", "u", &snap).unwrap();
        let rev: i64 = conn
            .query_row(
                "SELECT rev FROM inventory_entities WHERE id = 'equip:1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rev, 1);
    }

    #[test]
    fn collect_changed_since_filters_by_cursor() {
        let mut conn = mem();
        let snap = json!({ "entities": [
            { "id": "a:1", "type": "site", "name": "A", "updatedAt": "2024-01-01T00:00:00Z" },
            { "id": "a:2", "type": "site", "name": "B", "updatedAt": "2024-06-01T00:00:00Z" }
        ]});
        save_snapshot_inner(&mut conn, "o", "u", &snap).unwrap();
        let all = collect_entities_changed_since(&conn, "o", "u", None).unwrap();
        assert_eq!(all.len(), 2);
        let recent =
            collect_entities_changed_since(&conn, "o", "u", Some("2024-03-01T00:00:00Z")).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0]["id"], "a:2");
    }

    #[test]
    fn apply_records_is_last_write_wins() {
        let mut conn = mem();
        let snap = json!({ "entities": [
            { "id": "x:1", "type": "equip", "name": "Local", "updatedAt": "2024-01-01T00:00:00Z" }
        ]});
        save_snapshot_inner(&mut conn, "o", "u", &snap).unwrap();

        // Older remote record is ignored.
        let stale = vec![json!({
            "id": "x:1",
            "data": { "id": "x:1", "type": "equip", "name": "Stale" },
            "updatedAt": "2023-01-01T00:00:00Z",
            "deleted": false
        })];
        assert_eq!(apply_entity_records(&mut conn, "o", "u", &stale).unwrap(), 0);

        // Newer remote record wins, and a brand-new id is inserted.
        let fresh = vec![
            json!({
                "id": "x:1",
                "data": { "id": "x:1", "type": "equip", "name": "Remote" },
                "updatedAt": "2025-01-01T00:00:00Z",
                "deleted": false
            }),
            json!({
                "id": "x:2",
                "data": { "id": "x:2", "type": "equip", "name": "FromCloud" },
                "updatedAt": "2025-01-01T00:00:00Z",
                "deleted": false
            }),
        ];
        assert_eq!(apply_entity_records(&mut conn, "o", "u", &fresh).unwrap(), 2);
        let loaded = load_snapshot_inner(&conn, "o", "u").unwrap();
        let names: Vec<&str> = loaded["entities"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"Remote"));
        assert!(names.contains(&"FromCloud"));
    }

    #[test]
    fn sync_cursor_roundtrips() {
        let conn = mem();
        assert_eq!(get_sync_cursor(&conn, "o", "u", "inventory_entities"), (None, None));
        set_sync_cursor(&conn, "o", "u", "inventory_entities", Some("p1"), Some("q1")).unwrap();
        assert_eq!(
            get_sync_cursor(&conn, "o", "u", "inventory_entities"),
            (Some("p1".into()), Some("q1".into()))
        );
        // COALESCE keeps the existing push cursor when only the pull cursor moves.
        set_sync_cursor(&conn, "o", "u", "inventory_entities", Some("p2"), None).unwrap();
        assert_eq!(
            get_sync_cursor(&conn, "o", "u", "inventory_entities"),
            (Some("p2".into()), Some("q1".into()))
        );
    }

    #[test]
    fn bacnet_cache_roundtrips_and_tombstones() {
        let mut conn = mem();
        let devices = json!([
            { "key": "d1", "instance": 1001, "address": "192.168.1.10" },
            { "key": "d2", "instance": 1002, "address": "192.168.1.11" }
        ]);
        save_bacnet_cache_inner(&mut conn, "o", "u", &devices).unwrap();
        assert_eq!(
            load_bacnet_cache_inner(&conn, "o", "u").unwrap().as_array().unwrap().len(),
            2
        );
        let fewer = json!([ { "key": "d1", "instance": 1001, "address": "192.168.1.10" } ]);
        save_bacnet_cache_inner(&mut conn, "o", "u", &fewer).unwrap();
        assert_eq!(
            load_bacnet_cache_inner(&conn, "o", "u").unwrap().as_array().unwrap().len(),
            1
        );
    }
}
