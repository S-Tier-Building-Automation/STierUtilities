# S-Tier Utilities

A small Tauri-based desktop hub that hosts little Windows utilities I (and friends) actually use.

Each tool is implemented as a native Rust module inside the Tauri binary — no extra runtimes for end users. One installer, one window, knobs in the UI, done.

The hub ships with a compact **sidebar** for favorites, a **Library** view that lists the normal workflows, a centralized **Activity** page, and an account/app menu for settings, services, updates, and local data. The Library is a compact catalog of tools; each tool has its own dedicated page with controls and operational context. Star a tool to pin it to the sidebar; hidden and advanced tools can be restored from the Library when needed.

The app **auto-updates** through the Tauri updater plugin — release a new tag on this repo and installed copies notify the user and apply the update on next launch.

## What's hosted

| Tool | What it does |
| --- | --- |
| **ClipboardTyper** | Middle-click anywhere to send clipboard text through Windows `SendInput` scan codes. Useful for local password fields, some RDP/VM screens, and places where Ctrl+V is blocked. Some remote tools, including DeskIn in certain modes, may ignore injected input before timing settings can help. |
| **HEIC & MOV** | Preview and convert iPhone photos/videos on Windows (FFmpeg sidecar). |
| **Network Manager** | Save IPv4/DNS adapter profiles, see drift, scan the subnet. |
| **Building Workspace** | Model sites/buildings/floors/devices/points, discover BACnet devices, historize, dashboard, commission, and export reports. |
| **Advanced BACnet Inspector** | Hidden-by-default field-debug view for raw BACnet object browsing, writes, trends, and COV. |
| **Observability** | Shared time-series service; optional Telegraf + InfluxDB + Grafana pack. |
| **BACnet Historian** | Continuously log BACnet points to InfluxDB and chart them in Grafana. |

## Platform (tools as capabilities)

Tools are no longer a hardcoded list — each declares a **manifest** ([src/tools/manifests.js](src/tools/manifests.js)) saying what capabilities it **provides** and **requires**. A small **kernel** ([src/platform/](src/platform/)) validates the manifests, resolves the dependency graph, and lets tools reuse each other (`host.use("netscan.v1")`) instead of re-solving the same problem. Shared services — `timeseries` (metrics), `scheduler`, `network.adapters`, `bacnet.read`, and `inventory` — live here too, and third-party tools can plug in as MCP servers (`kind: "mcp"`). See [docs/platform-observability-and-ecosystem.md](docs/platform-observability-and-ecosystem.md). UI changes should follow the scoped rendering standard in [docs/rendering-standards.md](docs/rendering-standards.md).

```bash
npm test                                              # JS kernel + services + tool wiring
cargo test --manifest-path src-tauri/Cargo.toml       # Rust encoders, supervisor, secrets
```

## Run it (dev)

Requires:
- **Rust** 1.70+ (`rustup`)
- **Node** 20+ and **pnpm**
- **WebView2** runtime (default on Windows 11)

```bash
git clone https://github.com/S-Tier-Building-Automation/STierUtilities.git
cd STierUtilities
pnpm install
pnpm tauri dev
```

The frontend is built with **Vite + Svelte 5**. `pnpm tauri dev` runs `pnpm dev` (the Vite dev server on `http://localhost:1420`, with HMR) automatically via `beforeDevCommand`, so editing files under `src/` hot-reloads in the window — there is no longer a "just edit and refresh the static files" path. To work on the frontend alone (in a browser, without the Tauri shell), run `pnpm dev`. `pnpm build` produces the bundled `dist/` that `pnpm tauri build` ships.

The hub window opens. **Enable** ClipboardTyper from its card; middle-click anywhere to send your clipboard text to the focused local window. **Disable** restores native middle-click. Sliders inside the card live-tune timing, which can help if a remote-desktop client forwards injected input but drops Shift on shifted characters. If a tool like DeskIn receives nothing at all, it is likely blocking injected input rather than needing a slower delay.

## Build a Windows installer

```bash
pnpm tauri build
```

The MSI / EXE lands in `src-tauri/target/release/bundle/`. End users do not need Rust, Node, or Python — only the WebView2 runtime, which ships with Windows 11.

## Cutting a release (auto-update)

Tag a commit on `main`:

```bash
git tag v0.5.1
git push origin v0.5.1
```

`.github/workflows/release.yml` builds the Windows bundle, signs it with the `TAURI_SIGNING_PRIVATE_KEY` secret, and attaches the artifacts plus a `latest.json` manifest to a GitHub Release. Installed copies of S-Tier Utilities poll that manifest on launch and prompt the user to update.

## Adding a new micro-tool

1. Add a manifest entry to `src/tools/manifests.js` (id, version, `provides`/`requires`, permissions, UI text). The kernel and the Library catalog both read from it.
2. If it has native logic, add a Rust module under `src-tauri/src/<tool>.rs`, `mod` it from `lib.rs`, and register its `#[tauri::command]`s in `invoke_handler![]`.
3. Register a capability implementation (wrapping `invoke`) in `src/tools/capabilities.js`, and the page renderer in the `TOOL_RENDERERS` map in `src/main.js`.
4. Reuse other tools by declaring them in `requires` and calling `host.use("<cap>.vN")` — don't reimplement discovery, scanning, storage, or scheduling.

Third-party tools can instead ship a `kind: "mcp"` manifest pointing at an MCP server; the kernel proxies each capability method to the server's tools.

The Win32 plumbing in `clipboardtyper.rs` (low-level hook on a dedicated thread, `SendInput` with explicit modifier timing) is a reasonable template for keyboard/mouse-driven tools.

### HEIC & MOV (FFmpeg sidecar)

Release builds download FFmpeg automatically in CI (`scripts/fetch-ffmpeg.ps1`). For local dev on Windows, run that script once before `pnpm tauri dev` so `src-tauri/binaries/ffmpeg-<target>.exe` and `ffprobe-<target>.exe` exist.

The bundled FFmpeg build is GPL-licensed (see [FFmpeg license](https://ffmpeg.org/legal.html)). Source for the prebuilt binaries is [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds).

## License

MIT
