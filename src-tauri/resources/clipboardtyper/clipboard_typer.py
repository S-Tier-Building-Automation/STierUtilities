"""
ClipboardTyper - middle-click types your clipboard.

Workflow:
  1. Copy text anywhere (Ctrl+C).
  2. Click into the destination field (left-click to focus it).
  3. Middle-click. The clipboard text is auto-typed.

Hotkeys:
  F8        - toggle armed / disarmed
  F9        - re-print status
  Ctrl+C    - quit (in the console window)

While ARMED, middle-clicks are suppressed (they do not pass to apps).
While DISARMED, middle-clicks behave normally.
"""

import ctypes
import sys
import threading
import time
from ctypes import wintypes

import pyperclip
from pynput import keyboard
from pynput.keyboard import Controller as KbController
from pynput.keyboard import Key

# ---------- Tunables ----------
TYPE_DELAY_SEC = 0.06    # delay between characters (raise if chars drop)
START_DELAY_SEC = 0.04   # tiny pause after middle-click before typing
MODIFIER_HOLD_SEC = 0.04 # how long to hold Shift around a shifted keypress
                         # (needed for remote-desktop tools like DeskIn / RDP
                         # so the Shift modifier propagates with the keystroke)
ARM_TOGGLE = Key.f8
STATUS_KEY = Key.f9

# Shifted symbols -> base key on a US keyboard layout.
SHIFTED_TO_BASE = {
    "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5",
    "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
    "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\",
    ":": ";", '"': "'", "<": ",", ">": ".", "?": "/",
}

# ---------- State ----------
_armed = True
_typing_lock = threading.Lock()
_kb = KbController()

# ---------- Win32 plumbing ----------
user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

WH_MOUSE_LL = 14
WM_MBUTTONDOWN = 0x0207
WM_MBUTTONUP = 0x0208
WM_QUIT = 0x0012
HC_ACTION = 0

LRESULT = ctypes.c_ssize_t
ULONG_PTR = ctypes.c_size_t


class MSLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [
        ("pt", wintypes.POINT),
        ("mouseData", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


LowLevelMouseProc = ctypes.WINFUNCTYPE(
    LRESULT, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM
)
HandlerRoutine = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.DWORD)

user32.SetWindowsHookExW.argtypes = [
    ctypes.c_int, LowLevelMouseProc, wintypes.HINSTANCE, wintypes.DWORD,
]
user32.SetWindowsHookExW.restype = wintypes.HHOOK
user32.UnhookWindowsHookEx.argtypes = [wintypes.HHOOK]
user32.UnhookWindowsHookEx.restype = wintypes.BOOL
user32.CallNextHookEx.argtypes = [
    wintypes.HHOOK, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM,
]
user32.CallNextHookEx.restype = LRESULT
user32.GetMessageW.argtypes = [
    ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT,
]
user32.GetMessageW.restype = wintypes.BOOL
user32.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
user32.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
user32.PostThreadMessageW.argtypes = [
    wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
]
user32.PostThreadMessageW.restype = wintypes.BOOL
kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
kernel32.GetModuleHandleW.restype = wintypes.HMODULE
kernel32.GetCurrentThreadId.restype = wintypes.DWORD
kernel32.SetConsoleCtrlHandler.argtypes = [HandlerRoutine, wintypes.BOOL]
kernel32.SetConsoleCtrlHandler.restype = wintypes.BOOL


# ---------- Behavior ----------
def print_status():
    state = "\033[92mARMED  \033[0m" if _armed else "\033[93mDISARMED\033[0m"
    sys.stdout.write(f"[ClipboardTyper] {state}  (F8 toggle | F9 status | Ctrl+C quit)\n")
    sys.stdout.flush()


def _type_one(ch):
    """Type a single character, holding Shift explicitly for shifted chars
    so remote-desktop tools propagate the modifier reliably."""
    if ch == "\r":
        return
    if ch == "\n":
        _kb.press(Key.enter); _kb.release(Key.enter); return
    if ch == "\t":
        _kb.press(Key.tab); _kb.release(Key.tab); return

    base = None
    if ch.isupper():
        base = ch.lower()
    elif ch in SHIFTED_TO_BASE:
        base = SHIFTED_TO_BASE[ch]

    if base is not None:
        _kb.press(Key.shift)
        time.sleep(MODIFIER_HOLD_SEC)
        _kb.press(base)
        time.sleep(0.01)
        _kb.release(base)
        time.sleep(MODIFIER_HOLD_SEC)
        _kb.release(Key.shift)
    else:
        _kb.type(ch)


def type_clipboard():
    if not _typing_lock.acquire(blocking=False):
        # already typing; ignore re-entrancy
        return
    try:
        try:
            text = pyperclip.paste()
        except Exception as exc:
            print(f"  [err] clipboard read failed: {exc}")
            return
        if not text:
            print("  [warn] clipboard is empty or non-text; nothing to type.")
            return
        stripped = text.rstrip("\r\n\t ")
        if stripped != text:
            print(f"  [info] stripped {len(text) - len(stripped)} trailing whitespace char(s)")
            text = stripped
        n = len(text)
        print(f"  -> typing {n} char{'s' if n != 1 else ''}...")
        time.sleep(START_DELAY_SEC)
        for ch in text:
            _type_one(ch)
            if TYPE_DELAY_SEC > 0:
                time.sleep(TYPE_DELAY_SEC)
        print("  done.")
    finally:
        _typing_lock.release()


def _mouse_hook(n_code, w_param, l_param):
    if n_code == HC_ACTION and _armed:
        if w_param == WM_MBUTTONDOWN:
            threading.Thread(target=type_clipboard, daemon=True).start()
            return 1   # suppress: do not deliver to the focused window
        if w_param == WM_MBUTTONUP:
            return 1   # suppress matching up event
    return user32.CallNextHookEx(None, n_code, w_param, l_param)


_hook_proc_ref = LowLevelMouseProc(_mouse_hook)


def _on_key_press(key):
    global _armed
    if key == ARM_TOGGLE:
        _armed = not _armed
        print_status()
    elif key == STATUS_KEY:
        print_status()


def _install_ctrl_handler(main_thread_id):
    def _handler(ctrl_type):
        # 0=CTRL_C, 1=CTRL_BREAK, 2=CTRL_CLOSE, 5=CTRL_LOGOFF, 6=CTRL_SHUTDOWN
        if ctrl_type in (0, 1, 2, 5, 6):
            user32.PostThreadMessageW(main_thread_id, WM_QUIT, 0, 0)
            return True
        return False
    handler_ref = HandlerRoutine(_handler)
    kernel32.SetConsoleCtrlHandler(handler_ref, True)
    # keep a global ref so it isn't garbage collected
    globals()["_ctrl_handler_ref"] = handler_ref


def main():
    print("=" * 60)
    print("  ClipboardTyper")
    print("  Middle-click anywhere to type your clipboard contents.")
    print("=" * 60)
    print_status()

    kb_listener = keyboard.Listener(on_press=_on_key_press)
    kb_listener.start()

    main_thread_id = kernel32.GetCurrentThreadId()
    _install_ctrl_handler(main_thread_id)

    h_mod = kernel32.GetModuleHandleW(None)
    hook_id = user32.SetWindowsHookExW(WH_MOUSE_LL, _hook_proc_ref, h_mod, 0)
    if not hook_id:
        err = ctypes.get_last_error()
        print(f"FATAL: SetWindowsHookExW failed (Win32 error {err}).", file=sys.stderr)
        sys.exit(1)

    msg = wintypes.MSG()
    try:
        while True:
            ret = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
            if ret == 0 or ret == -1:
                break
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))
    finally:
        user32.UnhookWindowsHookEx(hook_id)
        kb_listener.stop()
        print("\nClipboardTyper stopped. Bye.")


if __name__ == "__main__":
    main()
