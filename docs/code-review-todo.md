# Code Review To-Do — Frontend & Backend

Review date: 2026-06-16. Branch: `platform-observability-ecosystem`.
Baseline at review time: all 154 JS tests pass, `cargo check` clean, clippy reported 13 idiom-only warnings.

**Status (2026-06-16): all items resolved.** Verification after the fixes:
154/154 JS tests pass, 159/159 Rust tests pass (incl. 4 new security regression tests),
`cargo check` clean, **`cargo clippy --all-targets` clean (0 warnings)**.
Two items were handled with deliberate nuance — see the inline notes on the scroll-restore
(Low) and the secret/state-file permissions (Medium) entries.

Severity legend: **Critical** = security/RCE or guaranteed crash on real input · **High** = security gap or user-visible breakage · **Medium** = correctness/robustness bug · **Low** = polish, latent, or hygiene.

---

## Critical

- [x] **Backend / security** — `src-tauri/src/secrets.rs:41-61` — InfluxDB token uses a non-CSPRNG.
  `generate_token()` seeds an xorshift64* PRNG from `SystemTime` nanos XOR a heap address — both low-entropy and partly guessable, so the 128-hex token is far weaker than its length implies (the module's own comment admits this). **Fix:** generate from an OS CSPRNG (`getrandom` crate or `BCryptGenRandom`).

- [x] **Backend / security** — `src-tauri/src/observability.rs:1206-1208,1469-1472` — pack binaries run without integrity verification.
  `pinned_sha256()` always returns `None`, so `verify_sha256` never runs; the ~400 MB influxd/telegraf/grafana downloads are extracted and executed with no hash/signature check (a `TODO(release)` confirms it's unfinished). A compromised mirror = local code execution. **Fix:** pin real SHA-256 per component/version and hard-fail on missing/mismatched hash before extraction.

- [x] **Backend / crash** — `src-tauri/src/bacnet_codec.rs:1517` — `decode_one_log_record` slice panic on malformed trend-log read.
  `i` is advanced by a length validated against the full buffer, not the inner `end`, so a crafted ReadRange-ACK makes `i > inner.len()` and `&inner[i..]` panics. Reachable from attacker/garbled device data. **Fix:** use `inner.get(i..)` and bail if `i > inner.len()` before the second `decode_application_value`.

## High

- [x] **Backend / security** — `src-tauri/src/auth.rs:99-118` — `generate_id` produces predictable, collision-prone IDs.
  Same weak time+heap xorshift, only two 64-bit words. IDs are used as filesystem path segments and sync-merge join keys, so collisions can merge two distinct users/orgs in `merge_snapshot`. **Fix:** derive IDs from an OS CSPRNG or UUIDv4.

- [x] **Backend / security** — `src-tauri/src/auth.rs:441-549` — `merge_snapshot` trusts arbitrary sync-folder file contents.
  `sync_now`/`merge_snapshot` import users, orgs, scoped state, and even an active session (`local.session = Some(...)`) from `auth-sync.json` with no schema/version/signature check. Any writable file there can inject accounts or silently switch the active session. **Fix:** validate the snapshot `schema`/version and never auto-activate a session from a remote snapshot without explicit user action.

- [x] **Backend / security** — `src-tauri/src/auth.rs:501-516` — sync scopes fall back to raw remote IDs.
  When a remote org/user id isn't in `org_map`/`user_map`, the code uses the raw remote string (`unwrap_or_else(|| remote_*_id.to_string())`) as a `state_path` key; combined with the trust gap above, a crafted snapshot can create/overwrite scoped-state files. **Fix:** skip scopes whose ids don't resolve to a known local user/org.

- [x] **Frontend** — `src/main.js:4103` — historian "Poll now" has an unhandled promise rejection.
  `onclick: async () => { const r = await hist.pollOnce(); ... }` has no try/catch; a read failure / offline device becomes an unhandled rejection with zero user feedback (every other historian action logs). **Fix:** wrap in try/catch and `logTo("bacnet-historian", ...)` on failure.

- [x] **Frontend** — `src/platform/services/influx-transport.js:30-31` — `grafanaPort` never validated.
  The constructor validates `influxPort` but `buildGrafanaPanelUrl` builds `http://127.0.0.1:${config.grafanaPort}`; a missing/non-numeric `grafanaPort` silently yields `127.0.0.1:undefined` embed URLs. **Fix:** validate `grafanaPort` is finite in `createInfluxTransport` (or return `null` from the URL builder).

## Medium

- [x] **Frontend** — `src/main.js:1293-1300` — `<select value=...>` doesn't select the option (state/UI desync).
  `el("select", { value: hm.imageFormat })` sets an attribute that has no effect on `<select>`; options carry no `selected`, so after any re-render the dropdown snaps back to the first option while state stays changed. **Fix:** mark the matching `<option selected>` or set `.value` on the element after creation.

- [x] **Frontend** — `src/main.js:2615-2655`, `1986-2010` — `listen()` handles discarded and unguarded.
  Each `listen("bacnet:*"/"netscan:*", …)` returns an unstored `Promise<UnlistenFn>` with no `.catch()`; listeners can't be torn down and a bus rejection is unhandled. **Fix:** store the unlisten handles (or at least add `.catch()` to each).

- [x] **Frontend** — `src/main.js:7273-7281` — `pagehide` COV cleanup can target the wrong object.
  Parses `bac.cov.objectKey || "0:0"`; if `objectKey` is null mid-toggle it unsubscribes object `0:0`. **Fix:** only unsubscribe when `bac.cov.objectKey` is truthy.

- [x] **Frontend** — `src/tools/historian.js:32-35,50-52` — dedup key collides for devices lacking instance/id.
  `deviceTag` falls back to `"?"`, so two distinct devices missing those fields produce the same key and one `Object.assign`-overwrites the other. **Fix:** require a resolvable device id in `addPoint` (or fold address/network/mac into `keyOf`).

- [x] **Frontend** — `src/tools/historian.js:55-64` — re-`addPoint` clobbers accumulated read state.
  On an existing key, `Object.assign(existing, point)` leaves stale `lastValue`/`lastError`/`reads` (or overwrites them with caller values). **Fix:** merge only config fields; explicitly preserve or reset the read counters.

- [x] **Frontend / security** — `src/platform/mcp-loader.js:26-37` — proxy issues a real MCP call for `__proto__`/unknown reads.
  `RESERVED_PROXY_KEYS` omits `__proto__`, so reading `proxy.__proto__` returns a callable that fires `client.callTool("<prefix>.__proto__", …)`. **Fix:** add `"__proto__"` to reserved keys and return `undefined` for any method name that isn't an advertised tool.

- [x] **Backend / security** — `src-tauri/src/secrets.rs`, `src-tauri/src/auth.rs` — secret/state files, fixed temp name.
  **Fixed:** both `secrets::save` and `auth::save_json` now use a per-process + per-call unique temp filename (`json.tmp.<pid>.<seq>`), eliminating the concurrent-save clobber race. **On permissions:** these files live under the per-user app config dir, whose Windows profile ACL already blocks *other* users (the "world-readable" premise is Unix-centric and doesn't hold for `%APPDATA%`). The only remaining threat — a *same-user* co-resident process — can't be solved by ACLs (same-user processes have access regardless) and is the job of the OS keychain (Credential Manager), which the module note still tracks as the planned next step. The token generator was also moved off the predictable PRNG to the OS CSPRNG (see the Critical item).

- [x] **Backend / crash** — `src-tauri/src/observability.rs:915` — `observability_onboard` byte-slices the token.
  `&config.token[..len.min(32)]` panics if a frontend-supplied token has a multi-byte UTF-8 boundary at byte 32. **Fix:** `config.token.chars().take(32).collect::<String>()`.

- [x] **Backend** — `src-tauri/src/observability.rs:481-484` — query/write responses buffered unbounded.
  `read_to_string` pulls an entire Flux CSV into RAM with only a timeout. **Fix:** cap with `Read::take(max_bytes)` or scan incrementally.

- [x] **Backend** — `src-tauri/src/observability.rs:469-487` — `http_send` ignores `Content-Length`/chunked framing.
  Reads to EOF, relying on `Connection: close`; keep-alive or a proxy makes it block until the 5s timeout on every probe. **Fix:** parse framing and stop at body end.

- [x] **Backend / security** — `src-tauri/src/mcp.rs:261-274` — MCP server command spawned verbatim from the renderer.
  `mcp_start` runs arbitrary `command`/`args`/`env` with no allowlist. **Fix:** validate `command` against an allowlist or resolve from a known plugin directory.

- [x] **Backend** — `src-tauri/src/observability.rs:59-73` — `find_free_ports` can return fewer than `n`.
  On bind failure it skips silently; `observability_pick_ports` then keeps hardcoded defaults (8086/3000/8186) that may be in use. **Fix:** return a `Result`/`Option` and propagate a clear error.

- [x] **Backend** — `src-tauri/src/bacnet.rs:1836` — unbounded COV subscriptions/threads across webview reloads.
  Each `bacnet_subscribe_cov` spawns a detached keep-alive thread; a webview reload without `bacnet_unsubscribe_cov` leaves the `CovEntry` and thread resubscribing forever, with no cap. **Fix:** cap concurrent COV entries (evict oldest) and/or tie keep-alive lifetime to a generation token.

- [x] **Backend** — `src-tauri/src/bacnet.rs:591` — fixed 2048-byte receive buffer truncates large datagrams.
  Oversized Forwarded-NPDU / segmented ComplexAck datagrams are silently truncated, failing length checks and surfacing as spurious timeouts. **Fix:** size the buffer to ≥4096 to match the 4 MB `SO_RCVBUF` intent.

- [x] **Backend / hardening** — `src-tauri/src/netscan.rs:141-160` — ICMP reply read without confirming bytes written.
  `IcmpSendEcho`'s reply is cast to `ICMP_ECHO_REPLY` and `RoundTripTime`/`Status` trusted without checking `replies >= 1` plus `DataSize`/`Status` first (buffer is zero-init so not memory-unsafe, but values are trusted blindly). **Fix:** validate the reply count and status before reading RTT.

## Low

- [x] **Frontend** — `src/main.js:2164` — RTT cell renders literal `"undefined ms"` when `rttMs` is missing. **Fix:** `h.rttMs != null ? \`${h.rttMs} ms\` : "—"`.
- [~] **Frontend** — `src/main.js:7094-7101` — scroll restore keys nodes by positional index. **Assessed, deliberately not changed:** the capture side records only `selector`+`index`, and the restored targets are stable scroll *containers* (`#view-root`, `.activity-log`, `.bac-table-wrap`), not dynamic rows — so positional-index restore is correct in practice. A "fix" would require reworking the capture side to emit stable keys and risks a regression for a cosmetic, non-reproducing issue. Left as-is intentionally.
- [x] **Frontend** — `src/main.js:6509-6514` — `clearActivityFiltered` predicate is a maintenance trap (correct today but reads like a bug). **Fix:** early-return the `kindFilter === "all"` case explicitly.
- [x] **Frontend** — `src/main.js:7367` — app-lifetime `pack.flush()` interval never cleared; keeps firing across webview reloads. **Fix:** store the handle, clear on `pagehide`.
- [x] **Frontend** — `src/platform/semver.js:74-75` — exact/plain ranges ignore `hasMinor`/`hasPatch`, so a plain `"1.0"` requires exactly `1.0.0` (latent; all current manifests use `^`/`~`). **Fix:** honor the captured granularity.
- [x] **Frontend** — `src/platform/services/influx-transport.js:14-20` — dashboard slug interpolated into the path unencoded. **Fix:** `encodeURIComponent(dash)`.
- [x] **Frontend** — `src/tools/building-workspace.js:262-274` — generated dashboard exposes a `point` template var no panel query uses (dead UI). **Fix:** wire it into the panel filters or drop the templating entry.
- [x] **Frontend** — `src/platform/services/pack-controller.js:30-33,48-54` — `connect()`/`bringUp()` re-attach a fresh transport even when already connected. **Fix:** short-circuit when connected/unchanged or make `attachTransport` idempotent.
- [x] **Backend** — `src-tauri/src/clipboardtyper.rs:344` — `TYPING` reentrancy flag isn't reset if `type_clipboard` panics, wedging the feature until restart. **Fix:** reset via a `Drop` guard.
- [x] **Backend** — `src-tauri/src/heicmov.rs:89-97` — `prune_cache` is `#[cfg(test)]`-only, so the preview cache grows unbounded in production despite the doc comment. **Fix:** ungate it and call it (with a byte budget) after each successful preview write.
- [x] **Backend** — `src-tauri/src/startup.rs:162-167` — `warm_observability` blocks a tokio worker with a 10×500ms `std::thread::sleep` loop. **Fix:** use `tokio::time::sleep` or `spawn_blocking`.
- [x] **Backend** — `src-tauri/src/observability.rs:649-671` — `timeseries_write` returns the input count, overstating writes when the encoder skips points or InfluxDB partially rejects. **Fix:** return `count - skipped` and surface partial-write info.
- [x] **Backend** — `src-tauri/src/netscan.rs:204,230`, `src-tauri/src/bacnet.rs:230` — `lock().unwrap()` on hot-path mutexes cascades a poison panic across the worker pool. **Fix:** `lock().unwrap_or_else(|e| e.into_inner())` (or `parking_lot`).
- [x] **Backend** — `src-tauri/src/bacnet_codec.rs:660` — `bvlc_decode` doesn't enforce `length >= payload_offset`, so a bogus-short frame is parsed using trailing bytes. **Fix:** validate `payload_offset <= length <= buf.len()` and slice `frame[payload_offset..length]`.
- [x] **Backend / cleanup** — 13 clippy idiom warnings (derivable `impl`s in `startup.rs`/`networkmanager.rs`/`heicmov.rs`, `is_multiple_of`, simplifiable boolean in `bacnet_codec.rs:1398`, `extend`→`append` in `bacnet.rs:1719`, etc.). **Fix:** `cargo clippy --fix` for the 9 auto-fixable ones, hand-review the rest.

## Verified safe (checked, not bugs)

- No XSS in `main.js` — the only dynamic `el()` `html` path is unused; the one `innerHTML` write is a static SVG.
- Prototype pollution via manifest/tag/template merging is not exploitable (V8 special-cases `__proto__` in spread/bracket-assign; manifest `id` is kebab-constrained).
- BACnet lock ordering is consistent (no reverse paths; no lock held across socket send or `.await`); decoders are bounds-checked and cannot infinite-loop.
- `host_range` prefix is clamped /16–/30 (no under/overflow); networkmanager elevated-apply path re-validates argv across the privilege boundary.
