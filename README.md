# MicroTools

A small Tauri-based desktop hub that hosts little Windows utilities I (and friends) actually use.

Each tool is implemented as a native Rust module inside the Tauri binary — no extra runtimes for end users. One installer, one window, knobs in the UI, done.

The hub itself ships with a left **sidebar** (favorites + nav), a **Library** view that lists everything in the binary, and a **Settings** view. Star a tool to pin it to the sidebar; hide tools you don't use to keep the library clean ("Show hidden" brings them back).

## What's hosted

| Tool | What it does |
| --- | --- |
| **ClipboardTyper** | Middle-click anywhere to auto-type whatever's on your clipboard. Useful for RDP/DeskIn login screens, password fields, VMs. Live tunables for type delay, modifier hold (matters for remote desktop), and start delay. |
| _more soon_ | |

## Run it (dev)

Requires:
- **Rust** 1.70+ (`rustup`)
- **Node** 20+ and **pnpm**
- **WebView2** runtime (default on Windows 11)

```bash
git clone https://github.com/stier1ba/MicroTools.git
cd MicroTools
pnpm install
pnpm tauri dev
```

The hub window opens. **Enable** ClipboardTyper from its card; middle-click anywhere to auto-type your clipboard. **Disable** restores native middle-click. Sliders inside the card live-tune timing — useful if a remote-desktop client drops Shift on shifted characters (raise *Modifier hold*).

## Build a Windows installer

```bash
pnpm tauri build
```

The MSI / EXE lands in `src-tauri/target/release/bundle/`. End users do not need Rust, Node, or Python — only the WebView2 runtime, which ships with Windows 11.

## Adding a new micro-tool

1. Add a Rust module under `src-tauri/src/<tool>.rs` and `mod` it from `lib.rs`.
2. Expose its surface as `#[tauri::command]`s and register them in `invoke_handler![]`.
3. Render a card and wire the buttons/sliders in `src/main.js`.

The Win32 plumbing in `clipboardtyper.rs` (low-level hook on a dedicated thread, `SendInput` with explicit modifier timing) is a reasonable template for keyboard/mouse-driven tools.

## License

MIT
