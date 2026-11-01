# -*- coding: utf-8 -*-
"""热键绑定：hold（按住说、松手结束）与 toggle（按一下开始、再按一下结束）。

为什么单独成类：键盘钩子的生命周期、当前绑的是哪个键、重复绑要先解绑 —— 这些状态
只属于「热键」这一件事。VoiceInput 只需要三个回调（按下 / 松开 / 切换），
不该自己拿着 keyboard 模块、hooks 列表和 mtime 轮询。
"""
import os
import time
import traceback


class HotkeyBinder(object):
    """管住「按键 → 回调」这一条线：绑定、换绑、监听配置变化。"""

    def __init__(self, on_start, on_stop, on_toggle=None, log=None):
        self.on_start = on_start          # 按下热键
        self.on_stop = on_stop            # 松开热键（hold 模式用，带原因字符串）
        self.on_toggle = on_toggle        # toggle 模式下按一下
        self._log = log or (lambda msg: None)
        self.hotkey = ""
        self.mode = "hold"
        self.hooks = []
        # 总开关（面板上的「语音输入」）：关着的时候 bind() 只会解绑，不挂键
        self.enabled = True

    @property
    def desc(self):
        if not self.hotkey:
            return "（没绑）"
        return "%s（%s 模式）" % (self.hotkey.upper(), self.mode)

    def unbind(self):
        import keyboard

        for h in self.hooks:
            try:
                keyboard.remove_hotkey(h)
            except Exception:
                try:
                    keyboard.unhook(h)
                except Exception:
                    pass
        self.hooks = []

    def bind(self, hotkey, mode):
        import keyboard

        hotkey = str(hotkey or "").strip().lower()
        if not hotkey:
            raise ValueError("热键不能为空")
        mode = "toggle" if mode == "toggle" else "hold"
        self.unbind()
        # 总开关关着：记住要绑哪个键，但先不挂钩子。打开时会重新 bind 一次。
        self.hotkey, self.mode = hotkey, mode
        if not self.enabled:
            return self
        hooks = []
        if mode == "hold":
            hooks.append(keyboard.on_press_key(hotkey, lambda e: self.on_start(), suppress=False))
            hooks.append(keyboard.on_release_key(hotkey, lambda e: self.on_stop("松手"), suppress=False))
        else:
            hooks.append(keyboard.add_hotkey(hotkey, self.on_toggle, suppress=False))
        self.hooks = hooks
        return self

    def set_enabled(self, on):
        """总开关切换：关掉立即解绑，打开按记住的键重新挂上。"""
        on = bool(on)
        if on == self.enabled:
            return False
        self.enabled = on
        if not on:
            self.unbind()
        elif self.hotkey:
            self.bind(self.hotkey, self.mode)
        return True

    def wait(self):
        import keyboard

        keyboard.wait()

    def watch(self, cfg, path, interval=1.5):
        """配置文件一改（比如面板里换了热键）就换绑，不用重启进程。"""
        stamp = 0.0
        while True:
            time.sleep(interval)
            try:
                new_stamp = os.path.getmtime(path)
            except OSError:
                continue
            if new_stamp == stamp:
                continue
            stamp = new_stamp
            try:
                cfg.reload()
            except Exception:
                continue
            # 总开关先处理：关掉时不挂键、打开时按记住的键接回去
            want_on = cfg.get("input_enabled", True) is not False
            if want_on != self.enabled:
                try:
                    self.set_enabled(want_on)
                    self._log("语音输入总开关 -> %s（%s）"
                              % ("开" if want_on else "关",
                                 ("热键 " + self.hotkey.upper()) if want_on else "热键已解绑"))
                except Exception:
                    self._log("语音输入总开关切换失败：" + traceback.format_exc(limit=2))
                if not want_on:
                    continue
            if not self.enabled:
                continue
            hk = str(cfg.get("hotkey") or "").strip().lower()
            md = cfg.get("mode") or "hold"
            if not hk or (hk == self.hotkey and md == self.mode):
                continue
            try:
                self.bind(hk, md)
                self._log("热键已切换：%s" % self.desc)
            except Exception:
                self._log("热键切换失败：" + traceback.format_exc(limit=2))
