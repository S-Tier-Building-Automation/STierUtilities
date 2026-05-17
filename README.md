# MicroTools

A small Tauri-based desktop hub that hosts little Windows utilities I (and friends) actually use.

The first hosted tool is [ClipboardTyper](https://github.com/stier1ba/ClipboardTyper) — middle-click to auto-type your clipboard, built for remote-desktop login fields.

## What's hosted

| Tool | What it does |
| --- | --- |
| **ClipboardTyper** | Middle-click anywhere to auto-type whatever's on your clipboard. Useful for RDP/DeskIn login screens, password fields, VMs. |
| _more soon_ | |

## Run it (dev)

Requires:
- **Rust** 1.70+ (`rustup`)
- **Node** 20+ and **pnpm**
- **Python 3.10+** on PATH (the hosted tools need it)
- **WebView2** runtime (default on Windows 11)

```bash
git clone https://github.com/stier1ba/MicroTools.git
cd MicroTools
pnpm install
pnpm tauri dev
```

The hub window opens. Click **Launch** on ClipboardTyper to start it — a small Python console window pops up showing its status. The hub's **Stop** button kills it.

If a tool errors out with `No module named …`, the hub will offer to `pip install --user -r requirements.txt` automatically.

## Build a Windows installer

```bash
pnpm tauri build
```

The MSI / EXE lands in `src-tauri/target/release/bundle/`.

## Adding a new micro-tool

1. Drop the tool's files into `src-tauri/resources/<tool-id>/`.
2. Add a `#[tauri::command]` in `src-tauri/src/lib.rs` that resolves the script via `app.path().resolve(..., BaseDirectory::Resource)` and spawns it. Register it in `invoke_handler![]`.
3. Append an entry to the `TOOLS` array at the top of `src/main.js`.

That's it — the UI is data-driven.

## License

MIT
