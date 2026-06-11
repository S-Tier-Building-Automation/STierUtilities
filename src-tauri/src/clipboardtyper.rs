//! Native ClipboardTyper: middle-click anywhere to type the clipboard contents.
//!
//! Architecture
//! ============
//! Installing a `WH_MOUSE_LL` hook requires a thread with a Win32 message
//! loop, so we spawn a dedicated thread that owns the hook for the lifetime
//! of an "enabled" session. When the user middle-clicks while ARMED, the
//! hook callback returns `1` (suppressing the click in apps like browsers
//! that would otherwise auto-scroll) and kicks the actual typing off on a
//! detached thread so the hook callback returns quickly.
//!
//! Typing goes through `SendInput`, using scan-code events for ordinary mapped
//! keys because remote-desktop clients are more likely to forward those than
//! virtual-key-only events. We hold `VK_SHIFT` explicitly with a configurable
//! delay around each shifted keystroke -- remote-desktop tools can drop the
//! modifier when shift+key fire back-to-back.

#![cfg(windows)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use windows::Win32::Foundation::{HINSTANCE, HMODULE, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, SendInput, VkKeyScanW, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
    KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE,
    KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC, VIRTUAL_KEY, VK_BACK, VK_DELETE, VK_DOWN, VK_END,
    VK_ESCAPE, VK_HOME, VK_LEFT, VK_NEXT, VK_PRIOR, VK_RETURN, VK_RIGHT, VK_SHIFT, VK_SPACE,
    VK_TAB, VK_UP,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx, MSG,
    WH_MOUSE_LL, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_QUIT,
};

// ---------- Global state ----------

static RUNNING: AtomicBool = AtomicBool::new(false);
static STARTING: AtomicBool = AtomicBool::new(false);
static ARMED: AtomicBool = AtomicBool::new(false);
static TYPING: AtomicBool = AtomicBool::new(false);
static HOOK_THREAD_ID: AtomicU32 = AtomicU32::new(0);

static TYPE_DELAY_MS: AtomicU64 = AtomicU64::new(60);
static MODIFIER_HOLD_MS: AtomicU64 = AtomicU64::new(40);
static START_DELAY_MS: AtomicU64 = AtomicU64::new(40);
static TRAILING_TAB: AtomicBool = AtomicBool::new(false);
static NEWLINE_AS_TAB: AtomicBool = AtomicBool::new(false);
static COLUMN_MAJOR: AtomicBool = AtomicBool::new(false);

static RULES: Lazy<Mutex<Vec<Rule>>> = Lazy::new(|| Mutex::new(Vec::new()));
static LOADED: AtomicBool = AtomicBool::new(false);

static APP_HANDLE: Lazy<Mutex<Option<AppHandle>>> = Lazy::new(|| Mutex::new(None));

// ---------- Public types (shared with the frontend) ----------

/// A value-based substitution: when a cell equals `match_value` (trimmed,
/// case-insensitive), send `output` instead of typing the literal cell.
/// `output` may contain key tokens like `{space}`, `{tab}`, `{enter}`, `{down}`.
#[derive(Serialize, Deserialize, Clone)]
pub struct Rule {
    #[serde(rename = "match")]
    pub match_value: String,
    #[serde(default)]
    pub output: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Settings {
    pub type_delay_ms: u64,
    pub modifier_hold_ms: u64,
    pub start_delay_ms: u64,
    /// Press Tab once more after the last cell, so a copied Excel row can be
    /// typed back-to-back without manually advancing to the next field.
    #[serde(default)]
    pub trailing_tab: bool,
    /// Emit Tab instead of Enter for line breaks. A column copied from Excel is
    /// new-line separated (no tabs), so this lets it advance field-to-field.
    #[serde(default)]
    pub newline_as_tab: bool,
    /// Type a copied block column-by-column (top-to-bottom) instead of Excel's
    /// row-major (left-to-right) order. Cells are reordered and Tab-separated.
    #[serde(default)]
    pub column_major: bool,
    /// Cell substitution rules, applied in order (first match wins).
    #[serde(default)]
    pub rules: Vec<Rule>,
}

#[derive(Serialize, Clone)]
pub struct State {
    pub running: bool,
    pub armed: bool,
    pub settings: Settings,
}

#[derive(Serialize, Clone)]
struct TypedEvent {
    chars: usize,
    error: Option<String>,
}

// ---------- Helpers ----------

fn current_settings() -> Settings {
    Settings {
        type_delay_ms: TYPE_DELAY_MS.load(Ordering::Relaxed),
        modifier_hold_ms: MODIFIER_HOLD_MS.load(Ordering::Relaxed),
        start_delay_ms: START_DELAY_MS.load(Ordering::Relaxed),
        trailing_tab: TRAILING_TAB.load(Ordering::Relaxed),
        newline_as_tab: NEWLINE_AS_TAB.load(Ordering::Relaxed),
        column_major: COLUMN_MAJOR.load(Ordering::Relaxed),
        rules: RULES.lock().map(|g| g.clone()).unwrap_or_default(),
    }
}

/// Apply a settings snapshot to the in-memory stores (timing is clamped).
fn apply_settings(s: &Settings) {
    TYPE_DELAY_MS.store(s.type_delay_ms.min(2000), Ordering::Relaxed);
    MODIFIER_HOLD_MS.store(s.modifier_hold_ms.min(2000), Ordering::Relaxed);
    START_DELAY_MS.store(s.start_delay_ms.min(2000), Ordering::Relaxed);
    TRAILING_TAB.store(s.trailing_tab, Ordering::Relaxed);
    NEWLINE_AS_TAB.store(s.newline_as_tab, Ordering::Relaxed);
    COLUMN_MAJOR.store(s.column_major, Ordering::Relaxed);
    if let Ok(mut g) = RULES.lock() {
        *g = s.rules.clone();
    }
}

// ---------- Persistence ----------

fn settings_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("clipboardtyper.json"))
}

fn save_settings(app: &AppHandle, settings: &Settings) {
    if let Some(path) = settings_file(app) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(settings) {
            let _ = std::fs::write(&path, json);
        }
    }
}

fn load_settings(app: &AppHandle) {
    if let Some(path) = settings_file(app) {
        if let Ok(data) = std::fs::read_to_string(&path) {
            if let Ok(settings) = serde_json::from_str::<Settings>(&data) {
                apply_settings(&settings);
            }
        }
    }
}

fn current_state() -> State {
    State {
        running: RUNNING.load(Ordering::Relaxed),
        armed: ARMED.load(Ordering::Relaxed),
        settings: current_settings(),
    }
}

fn emit_state() {
    if let Some(app) = APP_HANDLE.lock().ok().and_then(|g| g.clone()) {
        let _ = app.emit("clipboardtyper:state", current_state());
    }
}

fn emit_typed(chars: usize, error: Option<String>) {
    if let Some(app) = APP_HANDLE.lock().ok().and_then(|g| g.clone()) {
        let _ = app.emit("clipboardtyper:typed", TypedEvent { chars, error });
    }
}

// ---------- Tauri commands ----------

#[tauri::command]
pub fn clipboardtyper_start(app: AppHandle) -> Result<State, String> {
    if RUNNING.load(Ordering::Relaxed) {
        return Ok(current_state());
    }
    if STARTING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("ClipboardTyper is already starting.".into());
    }

    struct StartGuard;
    impl Drop for StartGuard {
        fn drop(&mut self) {
            STARTING.store(false, Ordering::Release);
        }
    }
    let _guard = StartGuard;

    *APP_HANDLE.lock().unwrap() = Some(app);

    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

    thread::Builder::new()
        .name("clipboardtyper-hook".into())
        .spawn(move || hook_thread_main(tx))
        .map_err(|e| format!("failed to spawn hook thread: {e}"))?;

    // Wait for the hook thread to confirm installation (or fail).
    match rx.recv_timeout(Duration::from_secs(2)) {
        Ok(Ok(())) => {
            RUNNING.store(true, Ordering::Relaxed);
            ARMED.store(true, Ordering::Relaxed);
            emit_state();
            Ok(current_state())
        }
        Ok(Err(e)) => Err(e),
        Err(_) => {
            request_hook_thread_quit();
            Err("hook thread did not respond in time".into())
        }
    }
}

#[tauri::command]
pub fn clipboardtyper_stop() -> Result<State, String> {
    if !RUNNING.load(Ordering::Relaxed) {
        return Ok(current_state());
    }
    request_hook_thread_quit();
    // Give the hook thread a moment to exit cleanly.
    let deadline = std::time::Instant::now() + Duration::from_millis(800);
    while RUNNING.load(Ordering::Relaxed) && std::time::Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    ARMED.store(false, Ordering::Relaxed);
    emit_state();
    Ok(current_state())
}

#[tauri::command]
pub fn clipboardtyper_set_armed(armed: bool) -> State {
    ARMED.store(armed, Ordering::Relaxed);
    emit_state();
    current_state()
}

#[tauri::command]
pub fn clipboardtyper_set_settings(app: AppHandle, settings: Settings) -> State {
    apply_settings(&settings);
    // Keep a handle around so settings changes can emit even before the hook
    // is started, and persist the canonical state to disk.
    if let Ok(mut g) = APP_HANDLE.lock() {
        if g.is_none() {
            *g = Some(app.clone());
        }
    }
    save_settings(&app, &current_settings());
    emit_state();
    current_state()
}

#[tauri::command]
pub fn clipboardtyper_get_state(app: AppHandle) -> State {
    // Load persisted settings once, on the first state read at startup.
    if !LOADED.swap(true, Ordering::AcqRel) {
        load_settings(&app);
    }
    current_state()
}

fn request_hook_thread_quit() {
    let tid = HOOK_THREAD_ID.load(Ordering::Relaxed);
    if tid != 0 {
        unsafe {
            let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
}

// ---------- Hook thread ----------

fn hook_thread_main(install_result: std::sync::mpsc::Sender<Result<(), String>>) {
    HOOK_THREAD_ID.store(unsafe { GetCurrentThreadId() }, Ordering::Relaxed);

    let h_mod: HMODULE = match unsafe { GetModuleHandleW(None) } {
        Ok(m) => m,
        Err(e) => {
            let _ = install_result.send(Err(format!("GetModuleHandleW failed: {e}")));
            HOOK_THREAD_ID.store(0, Ordering::Relaxed);
            return;
        }
    };
    let h_instance: HINSTANCE = HINSTANCE(h_mod.0);

    let hook_id =
        match unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), Some(h_instance), 0) }
        {
            Ok(h) => h,
            Err(e) => {
                let _ = install_result.send(Err(format!("SetWindowsHookExW failed: {e}")));
                HOOK_THREAD_ID.store(0, Ordering::Relaxed);
                return;
            }
        };
    let _ = install_result.send(Ok(()));

    // Standard Win32 message pump. WM_QUIT (posted by `stop`) ends the loop.
    let mut msg = MSG::default();
    unsafe {
        loop {
            let ret = GetMessageW(&mut msg, None, 0, 0).0;
            if ret == 0 || ret == -1 {
                break;
            }
        }
        let _ = UnhookWindowsHookEx(hook_id);
    }
    HOOK_THREAD_ID.store(0, Ordering::Relaxed);
    RUNNING.store(false, Ordering::Relaxed);
    ARMED.store(false, Ordering::Relaxed);
}

unsafe extern "system" fn mouse_hook_proc(
    n_code: i32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    if n_code == 0 && ARMED.load(Ordering::Relaxed) {
        let msg = w_param.0 as u32;
        if msg == WM_MBUTTONDOWN {
            thread::spawn(type_clipboard);
            return LRESULT(1);
        }
        if msg == WM_MBUTTONUP {
            return LRESULT(1);
        }
    }
    unsafe { CallNextHookEx(None, n_code, w_param, l_param) }
}

// ---------- Clipboard + typing ----------

/// The keystroke that advances after a cell.
#[derive(Clone, Copy)]
enum Sep {
    Tab,
    Enter,
    None,
}

fn type_clipboard() {
    if TYPING.swap(true, Ordering::AcqRel) {
        return;
    }

    let result = (|| -> Result<usize, String> {
        let raw = read_clipboard()?;
        let text: String = raw
            .trim_end_matches(|c: char| matches!(c, '\r' | '\n' | '\t' | ' '))
            .to_string();
        if text.is_empty() {
            return Err("clipboard is empty (or contains non-text)".into());
        }

        let start_delay = Duration::from_millis(START_DELAY_MS.load(Ordering::Relaxed));
        let type_delay = Duration::from_millis(TYPE_DELAY_MS.load(Ordering::Relaxed));
        let modifier_hold = Duration::from_millis(MODIFIER_HOLD_MS.load(Ordering::Relaxed));
        let column_major = COLUMN_MAJOR.load(Ordering::Relaxed);
        let newline_as_tab = NEWLINE_AS_TAB.load(Ordering::Relaxed);
        let trailing_tab = TRAILING_TAB.load(Ordering::Relaxed);

        // Parse the clipboard into a grid: rows split by '\n', cells by '\t'.
        let grid: Vec<Vec<&str>> = text
            .split('\n')
            .map(|line| line.trim_end_matches('\r').split('\t').collect())
            .collect();

        // Flatten into an ordered list of (cell, separator-that-follows). Within a
        // row cells are Tab-separated; between rows it's Enter (or Tab). In
        // column-major mode we walk top-to-bottom down each column, all Tabs.
        let mut tokens: Vec<(&str, Sep)> = Vec::new();
        if column_major {
            let cols = grid.iter().map(|r| r.len()).max().unwrap_or(0);
            for c in 0..cols {
                for row in &grid {
                    if let Some(cell) = row.get(c) {
                        tokens.push((*cell, Sep::Tab));
                    }
                }
            }
        } else {
            for row in &grid {
                for cell in row {
                    tokens.push((*cell, Sep::Tab));
                }
                if let Some(last) = tokens.last_mut() {
                    last.1 = if newline_as_tab { Sep::Tab } else { Sep::Enter };
                }
            }
        }
        // The final cell advances only if "trailing tab" is on (handled below).
        if let Some(last) = tokens.last_mut() {
            last.1 = Sep::None;
        }

        thread::sleep(start_delay);

        let mut typed = 0usize;
        for &(cell, sep) in &tokens {
            // A matching rule replaces the literal cell with its output template.
            match rule_output(cell) {
                Some(out) => typed += type_template(&out, modifier_hold, type_delay)?,
                None => typed += type_text(cell, modifier_hold, type_delay)?,
            }
            match sep {
                Sep::Tab => {
                    send_vk_press(VK_TAB)?;
                    typed += 1;
                    if type_delay > Duration::ZERO {
                        thread::sleep(type_delay);
                    }
                }
                Sep::Enter => {
                    send_vk_press(VK_RETURN)?;
                    typed += 1;
                    if type_delay > Duration::ZERO {
                        thread::sleep(type_delay);
                    }
                }
                Sep::None => {}
            }
        }

        // Optional trailing Tab: advance out of the last cell so the next row
        // can be typed without manually pressing Tab first.
        if trailing_tab {
            send_vk_press(VK_TAB)?;
            typed += 1;
        }

        Ok(typed)
    })();

    let (chars, err) = match result {
        Ok(n) => (n, None),
        Err(e) => (0, Some(e)),
    };
    emit_typed(chars, err);
    TYPING.store(false, Ordering::Release);
}

fn read_clipboard() -> Result<String, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.get_text().map_err(|e| e.to_string())
}

fn type_char(ch: char, modifier_hold: Duration) -> Result<(), String> {
    match ch {
        '\r' => Ok(()),
        '\n' => {
            if NEWLINE_AS_TAB.load(Ordering::Relaxed) {
                send_vk_press(VK_TAB)
            } else {
                send_vk_press(VK_RETURN)
            }
        }
        '\t' => send_vk_press(VK_TAB),
        _ => {
            let mut buf = [0u16; 2];
            let units = ch.encode_utf16(&mut buf);
            if units.len() == 1 {
                let unit = units[0];
                let scan = unsafe { VkKeyScanW(unit) };
                if scan == -1 {
                    send_unicode(unit)
                } else {
                    let vk = VIRTUAL_KEY((scan & 0xFF) as u16);
                    let shift_state = ((scan >> 8) & 0xFF) as u8;
                    let needs_shift = (shift_state & 0x01) != 0;
                    let needs_ctrl = (shift_state & 0x02) != 0;
                    let needs_alt = (shift_state & 0x04) != 0;
                    // We don't support AltGr / Ctrl-printables; fall back to Unicode.
                    if needs_ctrl || needs_alt {
                        return send_unicode(unit);
                    }
                    if needs_shift {
                        with_vk_held(VK_SHIFT, modifier_hold, || send_vk_press(vk))?;
                    } else {
                        send_vk_press(vk)?;
                    }
                    Ok(())
                }
            } else {
                // Surrogate pair (e.g., some emoji) -- send both code units as Unicode.
                for unit in units {
                    send_unicode(*unit)?;
                }
                Ok(())
            }
        }
    }
}

// ---------- Cell rules ----------

/// Look up a cell's substitution rule (trimmed, case-insensitive). Rules with an
/// empty match string are ignored so a half-filled row can't swallow every cell.
fn rule_output(cell: &str) -> Option<String> {
    let key = cell.trim().to_lowercase();
    let rules = RULES.lock().ok()?;
    rules
        .iter()
        .find(|r| {
            let m = r.match_value.trim();
            !m.is_empty() && m.to_lowercase() == key
        })
        .map(|r| r.output.clone())
}

/// Type a literal cell value, character by character.
fn type_text(s: &str, modifier_hold: Duration, type_delay: Duration) -> Result<usize, String> {
    let mut typed = 0usize;
    for ch in s.chars() {
        type_char(ch, modifier_hold)?;
        typed += 1;
        if type_delay > Duration::ZERO {
            thread::sleep(type_delay);
        }
    }
    Ok(typed)
}

/// Type a rule output: literal text, with `{token}` sequences sent as keys.
/// Unknown tokens (or a stray `{`) are typed literally.
fn type_template(s: &str, modifier_hold: Duration, type_delay: Duration) -> Result<usize, String> {
    let chars: Vec<char> = s.chars().collect();
    let mut typed = 0usize;
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '{' {
            if let Some(rel) = chars[i + 1..].iter().position(|&c| c == '}') {
                let name: String = chars[i + 1..i + 1 + rel].iter().collect();
                if let Some((vk, extended)) = named_key(&name) {
                    send_key_ex(vk, extended)?;
                    typed += 1;
                    if type_delay > Duration::ZERO {
                        thread::sleep(type_delay);
                    }
                    i += rel + 2;
                    continue;
                }
            }
        }
        type_char(chars[i], modifier_hold)?;
        typed += 1;
        if type_delay > Duration::ZERO {
            thread::sleep(type_delay);
        }
        i += 1;
    }
    Ok(typed)
}

/// Map a `{token}` name to a virtual key and whether it is an extended key.
fn named_key(name: &str) -> Option<(VIRTUAL_KEY, bool)> {
    match name.trim().to_lowercase().as_str() {
        "space" | "spc" => Some((VK_SPACE, false)),
        "tab" => Some((VK_TAB, false)),
        "enter" | "return" => Some((VK_RETURN, false)),
        "esc" | "escape" => Some((VK_ESCAPE, false)),
        "bksp" | "backspace" | "back" => Some((VK_BACK, false)),
        "del" | "delete" => Some((VK_DELETE, true)),
        "up" => Some((VK_UP, true)),
        "down" => Some((VK_DOWN, true)),
        "left" => Some((VK_LEFT, true)),
        "right" => Some((VK_RIGHT, true)),
        "home" => Some((VK_HOME, true)),
        "end" => Some((VK_END, true)),
        "pgup" | "pageup" => Some((VK_PRIOR, true)),
        "pgdn" | "pagedown" => Some((VK_NEXT, true)),
        _ => None,
    }
}

// ---------- SendInput helpers ----------

fn send_vk_down(vk: VIRTUAL_KEY) -> Result<(), String> {
    send_scan(vk, false)
}

fn send_vk_up(vk: VIRTUAL_KEY) -> Result<(), String> {
    send_scan(vk, true)
}

fn with_vk_held<F>(vk: VIRTUAL_KEY, hold: Duration, f: F) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String>,
{
    send_vk_down(vk)?;
    thread::sleep(hold);
    let body_result = f();
    thread::sleep(hold);
    let release_result = send_vk_up(vk);

    match (body_result, release_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(e), Ok(())) | (Ok(()), Err(e)) => Err(e),
        (Err(body), Err(release)) => Err(format!(
            "{body}; additionally failed to release modifier key: {release}"
        )),
    }
}

fn send_vk_press(vk: VIRTUAL_KEY) -> Result<(), String> {
    send_input(&mut [scan_input(vk, false)?, scan_input(vk, true)?])
}

/// Press and release a key, optionally flagged extended (arrows, nav, Delete) so
/// it is not mistaken for its numpad equivalent.
fn send_key_ex(vk: VIRTUAL_KEY, extended: bool) -> Result<(), String> {
    send_input(&mut [
        scan_input_ex(vk, false, extended)?,
        scan_input_ex(vk, true, extended)?,
    ])
}

fn scan_input_ex(vk: VIRTUAL_KEY, key_up: bool, extended: bool) -> Result<INPUT, String> {
    let scan = unsafe { MapVirtualKeyW(vk.0 as u32, MAPVK_VK_TO_VSC) };
    if scan == 0 {
        return Err(format!("could not map virtual key {} to scan code", vk.0));
    }
    let mut flags = KEYEVENTF_SCANCODE;
    if key_up {
        flags = KEYBD_EVENT_FLAGS(flags.0 | KEYEVENTF_KEYUP.0);
    }
    if extended {
        flags = KEYBD_EVENT_FLAGS(flags.0 | KEYEVENTF_EXTENDEDKEY.0);
    }
    Ok(keyboard_input(VIRTUAL_KEY(0), scan as u16, flags))
}

fn send_scan(vk: VIRTUAL_KEY, key_up: bool) -> Result<(), String> {
    send_input(&mut [scan_input(vk, key_up)?])
}

fn scan_input(vk: VIRTUAL_KEY, key_up: bool) -> Result<INPUT, String> {
    let scan = unsafe { MapVirtualKeyW(vk.0 as u32, MAPVK_VK_TO_VSC) };
    if scan == 0 {
        return Err(format!("could not map virtual key {} to scan code", vk.0));
    }

    let mut flags = KEYEVENTF_SCANCODE;
    if key_up {
        flags = KEYBD_EVENT_FLAGS(flags.0 | KEYEVENTF_KEYUP.0);
    }
    Ok(keyboard_input(VIRTUAL_KEY(0), scan as u16, flags))
}

fn send_unicode(unit: u16) -> Result<(), String> {
    send_input(&mut [
        keyboard_input(VIRTUAL_KEY(0), unit, KEYEVENTF_UNICODE),
        keyboard_input(
            VIRTUAL_KEY(0),
            unit,
            KEYBD_EVENT_FLAGS(KEYEVENTF_UNICODE.0 | KEYEVENTF_KEYUP.0),
        ),
    ])
}

fn keyboard_input(vk: VIRTUAL_KEY, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn send_input(inputs: &mut [INPUT]) -> Result<(), String> {
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        Err(format!("SendInput sent {sent} of {} events", inputs.len()))
    } else {
        Ok(())
    }
}
