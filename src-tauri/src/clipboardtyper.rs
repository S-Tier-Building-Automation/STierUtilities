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
//! Typing goes through `SendInput`. We hold `VK_SHIFT` explicitly with a
//! configurable delay around each shifted keystroke -- remote-desktop tools
//! like DeskIn drop the modifier when shift+key fire back-to-back, which
//! is why an earlier Python version lost uppercase letters.

#![cfg(windows)]

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use windows::Win32::Foundation::{HINSTANCE, HMODULE, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, VkKeyScanW, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, VIRTUAL_KEY, VK_RETURN, VK_SHIFT, VK_TAB,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx, MSG,
    WH_MOUSE_LL, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_QUIT,
};

// ---------- Global state ----------

static RUNNING: AtomicBool = AtomicBool::new(false);
static ARMED: AtomicBool = AtomicBool::new(false);
static TYPING: AtomicBool = AtomicBool::new(false);
static HOOK_THREAD_ID: AtomicU32 = AtomicU32::new(0);

static TYPE_DELAY_MS: AtomicU64 = AtomicU64::new(60);
static MODIFIER_HOLD_MS: AtomicU64 = AtomicU64::new(40);
static START_DELAY_MS: AtomicU64 = AtomicU64::new(40);

static APP_HANDLE: Lazy<Mutex<Option<AppHandle>>> = Lazy::new(|| Mutex::new(None));

// ---------- Public types (shared with the frontend) ----------

#[derive(Serialize, Deserialize, Clone, Copy)]
pub struct Settings {
    pub type_delay_ms: u64,
    pub modifier_hold_ms: u64,
    pub start_delay_ms: u64,
}

#[derive(Serialize, Clone, Copy)]
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
        Err(_) => Err("hook thread did not respond in time".into()),
    }
}

#[tauri::command]
pub fn clipboardtyper_stop() -> Result<State, String> {
    if !RUNNING.load(Ordering::Relaxed) {
        return Ok(current_state());
    }
    let tid = HOOK_THREAD_ID.load(Ordering::Relaxed);
    if tid != 0 {
        unsafe {
            let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
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
pub fn clipboardtyper_set_settings(settings: Settings) -> State {
    TYPE_DELAY_MS.store(settings.type_delay_ms.min(2000), Ordering::Relaxed);
    MODIFIER_HOLD_MS.store(settings.modifier_hold_ms.min(2000), Ordering::Relaxed);
    START_DELAY_MS.store(settings.start_delay_ms.min(2000), Ordering::Relaxed);
    emit_state();
    current_state()
}

#[tauri::command]
pub fn clipboardtyper_get_state() -> State {
    current_state()
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

    let hook_id = match unsafe {
        SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), Some(h_instance), 0)
    } {
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

        thread::sleep(start_delay);

        let mut typed = 0usize;
        for ch in text.chars() {
            type_char(ch, modifier_hold)?;
            typed += 1;
            if type_delay > Duration::ZERO {
                thread::sleep(type_delay);
            }
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
        '\n' => send_vk_press(VK_RETURN),
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
                        send_vk_down(VK_SHIFT)?;
                        thread::sleep(modifier_hold);
                        send_vk_press(vk)?;
                        thread::sleep(modifier_hold);
                        send_vk_up(VK_SHIFT)?;
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

// ---------- SendInput helpers ----------

fn send_vk_down(vk: VIRTUAL_KEY) -> Result<(), String> {
    send_input(&mut [keyboard_input(vk, 0, KEYBD_EVENT_FLAGS(0))])
}

fn send_vk_up(vk: VIRTUAL_KEY) -> Result<(), String> {
    send_input(&mut [keyboard_input(vk, 0, KEYEVENTF_KEYUP)])
}

fn send_vk_press(vk: VIRTUAL_KEY) -> Result<(), String> {
    send_input(&mut [
        keyboard_input(vk, 0, KEYBD_EVENT_FLAGS(0)),
        keyboard_input(vk, 0, KEYEVENTF_KEYUP),
    ])
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
        Err(format!(
            "SendInput sent {sent} of {} events",
            inputs.len()
        ))
    } else {
        Ok(())
    }
}
