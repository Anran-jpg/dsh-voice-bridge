# -*- coding: utf-8 -*-
"""Windows 桌面上的那几个小动作：响一声、看前台窗口、写剪贴板、粘贴。

单独拎出来是因为它们全是 ctypes / Win32 的类型声明（还很容易声明错），
跟「语音输入」这件事本身没关系；voice-in 只管把话说进去，不该顺带维护这些。
非 Windows 下调这些函数会抛异常或返回空，调用方自己兜。
"""
import ctypes
import time


def beep(kind="start", enabled=True):
    """提示音：start 高、stop 中、error 低。失败就算了，别为了响一声打断流程。"""
    if not enabled:
        return
    try:
        import winsound

        freq = {"start": 1046, "stop": 784, "error": 392}.get(kind, 880)
        winsound.Beep(freq, 70)
    except Exception:
        pass


def foreground_title():
    """当前前台窗口标题（用来判断「是不是在聊天窗口里」）"""
    try:
        user32 = ctypes.windll.user32
        hwnd = user32.GetForegroundWindow()
        n = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        return buf.value
    except Exception:
        return ""


def title_matches(title, needles):
    """窗口标题是否命中白名单（不配白名单 = 哪儿都行）"""
    if not needles:
        return True
    low = (title or "").lower()
    return any(str(n).lower() in low for n in needles)


def set_clipboard(text):
    """放进剪贴板。

    坑：GlobalAlloc / GlobalLock 的返回值必须声明成 64 位（HGLOBAL / void*），
    否则 64 位进程里句柄被截断成 32 位，SetClipboardData 直接失败甚至崩。
    """
    from ctypes import wintypes

    CF_UNICODETEXT = 13
    GMEM_MOVEABLE = 0x0002
    user32, kernel32 = ctypes.windll.user32, ctypes.windll.kernel32

    kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    user32.SetClipboardData.restype = wintypes.HANDLE

    buf = text.encode("utf-16-le") + b"\x00\x00"
    h = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(buf))
    if not h:
        raise OSError("GlobalAlloc 失败")
    ptr = kernel32.GlobalLock(h)
    if not ptr:
        raise OSError("GlobalLock 失败")
    ctypes.memmove(ptr, buf, len(buf))
    kernel32.GlobalUnlock(h)
    if not user32.OpenClipboard(None):
        raise OSError("OpenClipboard 失败")
    try:
        user32.EmptyClipboard()
        if not user32.SetClipboardData(CF_UNICODETEXT, h):
            raise OSError("SetClipboardData 失败")
    finally:
        user32.CloseClipboard()


def paste(text, press_enter=False):
    """把文本粘到当前焦点窗口（先写剪贴板再敲 ctrl+v）"""
    import keyboard

    set_clipboard(text)
    time.sleep(0.05)
    keyboard.press_and_release("ctrl+v")
    if press_enter:
        time.sleep(0.35)
        keyboard.press_and_release("enter")
