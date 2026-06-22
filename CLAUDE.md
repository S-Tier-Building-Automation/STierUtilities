# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Tauri 2 desktop app (Windows-first) that hosts small utilities as a single binary — no extra runtimes for end users beyond the WebView2 runtime that ships with Windows 11. The frontend is **Svelte 5 on Vite** (`src/`, bundled to `dist/` which `frontendDist` points at). The migration from the original no-framework manual-DOM shell is **incremental**: shell chrome + the simpler tool pages are Svelte components reading `svelte/store`s; large/critical tools (BACnet Manager, Building Workspace, Network Manager, BACnet Historian, Observability, Device Graphics, Graphics Builder) remain imperative `el()`-built pages kept alive across navigation by a **keep-alive bridge** (`src/ui/components/ContentRoot.svelte` + `src/platform/render-bridge.js`). Native logic is Rust under `src-tauri/`. Tools are not a hardcoded list; they are declared as **manifests** and wired together by a small **platform kernel** (see Architecture). Full UI model: [docs/rendering-standards.md](docs/rendering-standards.md).

## Commands

```bash
# Run the app in dev (opens the hub window). `tauri dev` runs `pnpm dev` (Vite on
# 127.0.0.1:1420, HMR) automatically via beforeDevCommand, then loads it.
pnpm install
pnpm tauri dev

# Frontend only (browser, no Tauri shell): pnpm dev. Build the bundled dist/: pnpm build.
# (tauri build runs `pnpm build` automatically via beforeBuildCommand.)

# Before the FIRST dev run on Windows: fetch the FFmpeg/ffprobe sidecars
# (HEIC & MOV tool needs src-tauri/binaries/ffmpeg-<target>.exe to exist)
powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1

# Build a Windows installer (MSI/EXE -> src-tauri/target/release/bundle/)
pnpm tauri build

# JS tests (kernel + services + tool wiring) — node's built-in runner
npm test                                  # runs node --test "src/**/*.test.js"
node --test src/platform/semver.test.js   # a single test file

# Rust tests (BACnet/Modbus encoders, observability supervisor, secrets, cache)
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml

# Live Observability Pack smoke test (install -> start -> write/query InfluxDB)
npm run smoke:observability

# Regenerate the per-tool docs
npm run docs:gen
```

There is no JS linter configured; correctness is enforced by `npm test`. One test (`src/ui/plugin-chrome.test.js`) is a **regression guard** that statically scans `src/tools/ui/*.js` for forbidden shell-class tokens — run `npm test` after adding or editing any tool page.

## Architecture

The core idea (full design in [docs/platform-observability-and-ecosystem.md](docs/platform-observability-and-ecosystem.md)): **the app is a platform, not a bag of tools.** Each tool declares a manifest of the capabilities it `provides` and `requires`; a thin kernel validates the graph, boots providers before consumers, and hands each tool a scoped `host` so it can reuse other tools instead of re-solving discovery/scanning/storage/scheduling.

### The kernel and capability registry (JS, `src/platform/`)

- **`manifests.js`** (`src/tools/`) is the single source of truth for what tools exist. Each entry has `id`, `version`, `apiVersion`, `kind` (`native` | `mcp` | `webview`), `provides`, `requires` (with `optional: true` for degrade-if-absent deps like `timeseries`), `permissions`, and `ui` text. Capability versions are **contract** versions independent of the app version — bump a provided capability's major only on a breaking interface change. Keep this file free of Tauri/DOM imports so it stays unit-testable.
- **`host.js`** — `createKernel({ manifests, factories, grant })`. Resolves the dependency graph (topological init order via `registry.js` + `semver.js`), then boots each tool's factory with a **scoped host**: `host.use("netscan.v1")` throws unless declared in `requires`; `host.tryUse(...)` returns null for optional deps; `host.can(perm)` / `host.requirePermission(perm)` enforce least-privilege grants. First-party UI pages that need a capability their *own* tool provides use `platform.capability(ref)` (bypasses the scoped `requires` check).
- **`capabilities.js`** (`src/tools/`) — `buildFactories(invoke, ...)` returns the native-tool factory map. Each factory wraps raw Tauri `invoke` commands behind a stable capability interface and calls `host.provide(...)`. `invoke` is injected so this is testable with a mock under `node --test`.
- **`mcp-loader.js`** + `services/mcp-client.js` — third-party tools ship as `kind: "mcp"` manifests; the loader proxies each capability method to the MCP server's tools, gated by install-time permission grants.

Shared services live in `src/platform/services/`: `timeseries` (ring-buffer fallback → InfluxDB), `scheduler`, `pack-controller` (Observability Pack lifecycle), `influx-transport`, `inventory-sql-storage`.

### App assembly (JS)

- **`src/main.js`** is a thin entry: builds the app via `createApplication(...)`, then `installBootstrap(...)`. Real wiring is in `src/platform/app-tools.js` (`createApplication` — instantiates every tool UI factory, builds `TOOL_RENDERERS`, the app shell, and pages) and `src/platform/bootstrap.js` (`runBootstrap` — boots the kernel, creates services, hydrates the inventory store, starts startup-warmup polling).
- **Tool UI** is one module per tool under `src/tools/ui/*.js`. Shared shell/pages (library, home, settings, account, services, activity, plugin chrome) are in `src/ui/`. A tool becomes visible only when its renderer has a `renderPage` (see `manifestToTool`/`rebuildCatalog` in `app-tools.js`).
- **Auth / user state**: `user-state.js` + the Rust `auth` module scope all persisted state per org/user. Switching org re-hydrates the SQLite-backed inventory store (`applyScopedUserState`).

### Native layer (Rust, `src-tauri/src/`)

- **`lib.rs`** registers every `#[tauri::command]` in one `invoke_handler![]` and runs the app with an event loop so the Observability Pack child processes (influxd/grafana/telegraf) and MCP servers are stopped on `ExitRequested`.
- Most modules are `#[cfg(windows)]` (Win32-dependent: `clipboardtyper`, `netscan`, `networkmanager`, `auth`, `heicmov`, `secrets`, `inventory_db`). The protocol drivers — `bacnet`, `bacnet_codec`, `bacnet_mstp`, `modbus`, `timeseries` line-protocol, `observability` config/encoding — are **portable** (plain UDP/TCP, pure logic) and not Windows-gated, which is also where the Rust unit tests concentrate.
- **Self-elevation**: Network Manager's "apply" relaunches the exe with `--nm-apply-elevated` (UAC) and handles it before any window init. The `--observability-smoke` arg runs the headless smoke test and exits.
- Persistence: SQLite (`rusqlite`, bundled) for the inventory + BACnet discovery cache, scoped per org/user; optional Supabase Cloud sync (`inventory_sync`, last-write-wins over `ureq`); InfluxDB write token in the Windows keychain (`keyring`, via `secrets.rs`).

### Rendering discipline (important — enforced by review and a test)

This is a local-first operational app; avoid full app redraws. **New tool pages should be Svelte components** (`src/tools/ui/*.svelte`) reading `svelte/store`s — `Notes.svelte` is the reference; tools that read the building model must track the `inventoryVersion` store inside `$derived` (the inventory has no change event). Register them in `TOOL_RENDERERS` (`app-tools.js`) as `{ renderStatusPill, component, componentProps }`; `renderStatusPill` stays a **sync** function (export it from the component's `<script module>`). **Legacy/bridged tools** still use the imperative model: smallest render scope (`renderScoped("chrome" | "page" | "building-workspace" | ...)`), `renderAll()` only for navigation/catalog/boot — never from row clicks, menus, filters, or selection (Building Workspace is the reference). In **both** kinds, tool pages must **not** render their own `<h2>` title, status pill, or a second header — the shell (`src/ui/plugin-page.js`) owns those; context add-ons go through `headerAddonFor`. Full rules: [docs/rendering-standards.md](docs/rendering-standards.md).

## Adding a tool

1. Add a manifest entry to `src/tools/manifests.js` (declare `provides`/`requires`/`permissions`).
2. Native logic: add `src-tauri/src/<tool>.rs`, `mod` it in `lib.rs`, register its `#[tauri::command]`s in `invoke_handler![]`.
3. Register a capability implementation (wrapping `invoke`) in `src/tools/capabilities.js`, add the UI module under `src/tools/ui/`, and wire its renderer into `TOOL_RENDERERS` in `src/platform/app-tools.js`.
4. Reuse other tools via `requires` + `host.use("<cap>.vN")` — don't reimplement discovery, scanning, storage, or scheduling. Third-party tools instead ship a `kind: "mcp"` manifest.

`clipboardtyper.rs` (low-level hook on a dedicated thread + `SendInput`) is the template for keyboard/mouse tools; `heicmov.rs` (sidecar runner + batch + progress) is the template for sidecar-backed tools.

## Releases (auto-update)

Push a tag on `main` (`git tag v0.x.y && git push origin v0.x.y`). `.github/workflows/release.yml` builds the Windows bundle, signs it with the `TAURI_SIGNING_PRIVATE_KEY` secret, and publishes a GitHub Release with a `latest.json` manifest; installed copies poll it on launch (config in `src-tauri/tauri.conf.json` → `plugins.updater`). Keep `version` in sync across `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and `APP_VERSION` in `src/main.js`.
