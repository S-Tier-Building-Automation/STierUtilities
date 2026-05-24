# S-Tier Utilities

A small Tauri-based desktop hub that hosts little Windows utilities I (and friends) actually use.

Each tool is implemented as a native Rust module inside the Tauri binary — no extra runtimes for end users. One installer, one window, knobs in the UI, done.

The hub ships with a left **sidebar** (favorites + nav), a **Library** view that lists everything in the binary, and a **Settings** view (with built-in update checks). The Library is a compact catalog of tools; each tool has its own **dedicated page** with controls, settings, and a tool-scoped activity log. Star a tool to pin it to the sidebar; hide tools you don't use to keep the library clean.

The app **auto-updates** through the Tauri updater plugin — release a new tag on this repo and installed copies notify the user and apply the update on next launch.

## What's hosted

| Tool | What it does |
| --- | --- |
| **ClipboardTyper** | Middle-click anywhere to send clipboard text through Windows `SendInput` scan codes. Useful for local password fields, some RDP/VM screens, and places where Ctrl+V is blocked. Some remote tools, including DeskIn in certain modes, may ignore injected input before timing settings can help. |
| _more soon_ | |

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

1. Add a Rust module under `src-tauri/src/<tool>.rs` and `mod` it from `lib.rs`.
2. Expose its surface as `#[tauri::command]`s and register them in `invoke_handler![]`.
3. Render a card and wire the buttons/sliders in `src/main.js`.

The Win32 plumbing in `clipboardtyper.rs` (low-level hook on a dedicated thread, `SendInput` with explicit modifier timing) is a reasonable template for keyboard/mouse-driven tools.

### HEIC & MOV (FFmpeg sidecar)

Release builds download FFmpeg automatically in CI (`scripts/fetch-ffmpeg.ps1`). For local dev on Windows, run that script once before `pnpm tauri dev` so `src-tauri/binaries/ffmpeg-<target>.exe` and `ffprobe-<target>.exe` exist.

The bundled FFmpeg build is GPL-licensed (see [FFmpeg license](https://ffmpeg.org/legal.html)). Source for the prebuilt binaries is [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds).

## License

MIT
