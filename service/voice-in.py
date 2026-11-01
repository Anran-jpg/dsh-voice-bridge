# -*- coding: utf-8 -*-
"""按住热键说话 -> 本地识别 -> 投给工作区会话（或粘贴到当前窗口）。

用法:
  python voice-in.py                  # 常驻，按住 hotkey 说话（说完静音会自动结束）
  python voice-in.py --once 3         # 录 3 秒直接识别（测试）
  python voice-in.py --list           # 列出输入设备
  python voice-in.py --selftest       # 自检：设备 / 前台窗口 / 标点模型
  python voice-in.py --punc "文本"    # 只跑标点

结构（一个职责一个对象）:
  Recorder    —— 只管录音，含静音自动结束
  Transcriber —— 只管「音频 -> 文字」（识别模型、标点模型、纠错词）
  Delivery    —— 只管「文字 -> 落地」（投给语音桥 / 粘贴 / 剪贴板，以及要不要在这儿念）
  VoiceInput  —— 只管热键与配置热更新，把上面三个串起来
公共件（读配置 / 打日志 / HTTP / 找端口）都在 common/ 里，四个脚本共用。
"""
import argparse
import base64
import os
import re
import sys
import threading
import time
import traceback

import numpy as np
import sounddevice as sd

from common import audio as vaudio
from common import desktop as desk
from common import http as web
from common import settings as vsettings
from common.config import Config
from common.log import log, now
from common.ports import find_bridge_port
from hotkeys import HotkeyBinder
from wake import WakeListener

HERE = os.path.dirname(os.path.abspath(__file__))
CFG_PATH = vsettings.CONFIG
IN_DIR = vsettings.IN_DIR

DEFAULTS = {
    "samplerate": 16000,
    "min_seconds": 0.35,
    "min_record_seconds": 0.6,
    "silence_sec": 1.15,
    "max_record_seconds": 60,
    "auto_stop": True,
    "beep": True,
    "punctuate": True,
    "punc_model": "ct-punc",
    "only_paste_in": ["DeepSeek Harness"],
    "fix_words": {},
    # bridge = 直接把话投进工作区会话（不碰窗口）；paste = 老办法粘贴到输入框
    "delivery": "bridge",
    "bridge_port": 0,
    # 桥那头已经把回复念了（交给桌宠念，或自己用所选引擎念），
    # 这里再念一遍就是「两个声音」——默认关掉，要念就由语音桥决定。
    "speak_reply": False,
    "tts_port": vsettings.TTS_PORT,
    "speak_max_chars": 100,
    "hotkey": "f8",
    "mode": "hold",
    # 面板上的「语音输入」总开关：关着就不听热键、也不听唤醒词
    "input_enabled": True,
    # hotkey = 按住键说话；wakeword = 常开听着，听到唤醒词就开始收话
    "trigger_mode": "hotkey",
    # 唤醒词，多个用逗号隔开（中英文标点都认）
    "wake_words": "大肥鱼",
    # 被叫醒时先应一声（走本地 TTS，不进对话），留空就不应
    "wake_reply": "在",
    # 应答时让桌宠摆的姿势（桌宠动画池里的动作名）；留空不摆
    "wake_pose": "打瞌睡被惊醒",
    # 唤醒模式下：说完这句「停顿」多久就自动收工（秒）
    "wake_silence_sec": 3.0,
    # 唤醒模式下录音最多多久（秒）
    "wake_max_sec": 30,
    # 唤醒窗口/步长/静音门限（调试用，一般不用动）
    "wake_window_sec": 2.0,
    "wake_hop_sec": 0.5,
    "wake_peak": 0.02,
    "wake_cooldown_sec": 3.0,
    "device": "",
    "asr_model": "paraformer-zh",
    "hotwords": "",
    "paste_to_window": True,
    "press_enter": False,
    "log": "",
}


# ---------- 录音 ----------
class Recorder:
    """一次录音会话：hold 模式松手结束，或静音/超时自动结束。"""

    @staticmethod
    def pick_device(name):
        """配置里的设备名 -> sounddevice 索引；没配或没找到就返回 None（用系统默认）"""
        if not name:
            return None
        for i, d in enumerate(sd.query_devices()):
            if d["max_input_channels"] > 0 and name.lower() in d["name"].lower():
                return i
        return None

    def __init__(self, device, cfg, on_auto_stop):
        self.device = device
        self.cfg = cfg
        self.sr = int(cfg.get("samplerate", 16000))
        self.on_auto_stop = on_auto_stop
        self.chunks = []
        self.stream = None
        self.lock = threading.Lock()
        self.active = False
        self.t_start = 0.0
        self.last_voice = 0.0
        self.silence_override = None
        self.max_override = None

    def _cb(self, indata, frames, t, status):
        with self.lock:
            if not self.active:
                return
            self.chunks.append(indata.copy())
            peak = float(np.max(np.abs(indata))) if indata.size else 0.0
            if peak > 0.02:
                self.last_voice = time.time()

    def start(self, silence_sec=None, max_sec=None):
        with self.lock:
            self.chunks = []
            self.active = True
            self.t_start = time.time()
            self.last_voice = self.t_start
            # 唤醒模式要求「停顿 N 秒」才收工，和按住说话的 1.15 秒不是一回事
            self.silence_override = silence_sec
            self.max_override = max_sec
        self.stream = sd.InputStream(
            samplerate=self.sr, channels=1, dtype="float32",
            device=self.device, callback=self._cb, blocksize=int(self.sr * 0.05))
        self.stream.start()
        if self.cfg.get("auto_stop", True):
            threading.Thread(target=self._watch, daemon=True).start()

    def _watch(self):
        silence = float(
            self.silence_override if self.silence_override is not None else self.cfg.get("silence_sec", 1.15)
        )
        max_sec = float(
            self.max_override if self.max_override is not None else self.cfg.get("max_record_seconds", 60)
        )
        min_sec = float(self.cfg.get("min_record_seconds", 0.6))
        while True:
            time.sleep(0.1)
            with self.lock:
                if not self.active:
                    return
                now_t = time.time()
                spoken = self.last_voice - self.t_start
                idle = now_t - self.last_voice
                hard = now_t - self.t_start
            if hard >= max_sec:
                self.on_auto_stop("max")
                return
            if spoken >= min_sec and idle >= silence:
                self.on_auto_stop("silence")
                return

    def stop(self):
        with self.lock:
            self.active = False
        s, self.stream = self.stream, None
        if s is not None:
            try:
                s.stop()
                s.close()
            except Exception:
                pass
        with self.lock:
            if not self.chunks:
                return None
            return np.concatenate(self.chunks, axis=0).reshape(-1)


# ---------- 识别 ----------
class Transcriber:
    """音频 -> 文字。模型加载慢，所以懒加载并常驻（一个进程一份）。"""

    def __init__(self, cfg, bridge_port=None):
        self.cfg = cfg
        self._asr = None
        self._punc = None
        self._punc_failed = False
        # 桥的端口（可调用对象，返回 int）。给了就先问桥那边的官方识别服务，
        # 桥不通或者它说「用本地模型」才回落到 FunASR。
        self._bridge_port = bridge_port
        # 这一句最后是谁识别的：'official' 还是 'funasr'（标点要不要补看它）
        self.last_engine = "funasr"

    def _log(self, msg):
        log(msg, self.cfg.get("log"))

    def load_asr(self):
        if self._asr is None:
            from funasr import AutoModel
            self._log("加载识别模型 %s ..." % self.cfg.get("asr_model"))
            t0 = time.time()
            self._asr = AutoModel(
                model=self.cfg.get("asr_model"), device="cuda:0",
                disable_update=True, disable_pbar=True, disable_log=True)
            self._log("模型就绪 %.1fs" % (time.time() - t0))
        return self._asr

    @property
    def ready(self):
        """本地识别模型是不是已经在内存里了（面板切到 funasr 时用得上）。"""
        return self._asr is not None

    def load_punc(self):
        if not self.cfg.get("punctuate", True) or self._punc_failed:
            return None
        if self._punc is None:
            try:
                from funasr import AutoModel
                self._log("加载标点模型 %s ..." % self.cfg.get("punc_model", "ct-punc"))
                t0 = time.time()
                self._punc = AutoModel(
                    model=self.cfg.get("punc_model", "ct-punc"), device="cuda:0",
                    disable_update=True, disable_pbar=True, disable_log=True)
                self._log("标点模型就绪 %.1fs" % (time.time() - t0))
            except Exception:
                self._punc_failed = True
                self._log("标点模型不可用，跳过标点: " + traceback.format_exc(limit=1))
                return None
        return self._punc

    def punctuate(self, text):
        if not text:
            return text
        p = self.load_punc()
        if p is None:
            return text
        try:
            res = p.generate(input=text)
            out = "".join(r.get("text", "") for r in res).strip()
            return out or text
        except Exception:
            self._log("标点失败，用原文: " + traceback.format_exc(limit=1))
            return text

    def fix_words(self, text):
        for wrong, right in (self.cfg.get("fix_words") or {}).items():
            if wrong and wrong in text:
                text = text.replace(wrong, right)
        return text

    def save_wav(self, audio):
        wav_path = os.path.join(IN_DIR, "in-%d.wav" % int(time.time() * 1000))
        sr = int(self.cfg.get("samplerate", 16000))
        return vaudio.write_wav(wav_path, audio, sr)

    def needs_punctuation(self):
        """官方 SenseVoice 自带标点，不用再跑一遍 ct-punc（那还得占一份模型内存）。"""
        if self.last_engine == "official":
            return False
        return bool(self.cfg.get("punctuate", True))

    def via_bridge(self, wav_path):
        """让桥那边的官方识别服务转文字。

        返回 (text, info)：
          text 是 str（可能是空串 = 确实没听出字）→ 就用它；
          text 是 None → 这条路没走通，调用方回落到本地 FunASR。
        """
        if not self._bridge_port:
            return None, ""
        try:
            port = self._bridge_port()
        except Exception as e:
            self._log("  桥不可用，识别走本地模型（%s）" % e)
            return None, ""
        try:
            res = web.post_json("http://127.0.0.1:%d/dsh-voice-bridge/transcribe" % port,
                                {"file": wav_path}, timeout=120)
        except Exception as e:
            self._log("  官方识别不通（%s），走本地模型" % e)
            return None, ""
        if res.get("ok"):
            sec = res.get("inferenceSeconds")
            self.last_engine = "official"
            return (res.get("text") or ""), "官方 %s / 推理 %.2fs" % (res.get("providerId") or "?", float(sec or 0))
        self._log("  官方识别没用上（%s），走本地模型" % (res.get("error") or "未知原因"))
        return None, ""

    def transcribe_bytes(self, wav_bytes):
        """给唤醒词监听用：wav 字节直接送桥（桥支持 base64），不落盘。

        唤醒监听每 0.5 秒就要识别一次，写文件再删是纯浪费；
        桥不通就抛异常，由监听那边记一条日志、下一秒再试。
        """
        if not self._bridge_port:
            raise RuntimeError("桥不可用")
        port = self._bridge_port()
        res = web.post_json(
            "http://127.0.0.1:%d/dsh-voice-bridge/transcribe" % port,
            {"audio": base64.b64encode(wav_bytes).decode("ascii")},
            timeout=30,
        )
        if not res.get("ok"):
            raise RuntimeError(res.get("error") or "官方识别没返回结果")
        return res.get("text") or ""

    def transcribe(self, audio):
        """返回 (text, wav_path 或原因串, peak)"""
        sr = int(self.cfg.get("samplerate", 16000))
        peak = float(np.max(np.abs(audio))) if audio.size else 0.0
        if audio.size < sr * float(self.cfg.get("min_seconds", 0.35)):
            return None, "too-short", peak
        if peak < 0.004:
            return None, "silence", peak
        wav_path = self.save_wav(audio)
        t0 = time.time()
        text, info = self.via_bridge(wav_path)
        if text is None:
            asr = self.load_asr()
            res = asr.generate(input=wav_path, batch_size_s=60, hotword=self.cfg.get("hotwords", ""))
            text = "".join(r.get("text", "") for r in res).strip()
            # FunASR 的中文结果按字带空格，含英文词时保留
            if text and not re.search(r"[A-Za-z]{2,}", text):
                text = text.replace(" ", "")
            self.last_engine = "funasr"
            info = "本地"
        self._log("识别 %.2fs（%s）: %s" % (time.time() - t0, info, text))
        return text, wav_path, peak


# ---------- 投递 ----------
class Delivery:
    """文字 -> 落地。默认投给语音桥；桥不通才退回粘贴/剪贴板。"""

    def __init__(self, cfg):
        self.cfg = cfg
        self._port = 0

    def _log(self, msg):
        log(msg, self.cfg.get("log"))

    def bridge_port(self):
        want = int(self.cfg.get("bridge_port") or 0)
        for port in (want, self._port):
            if not port:
                continue
            try:
                if web.get_json("http://127.0.0.1:%d/dsh-voice-bridge/config" % port, timeout=3).get("ok"):
                    self._port = port
                    return port
            except Exception:
                continue
        port = find_bridge_port()
        if not port:
            raise RuntimeError("找不到 voice-bridge 路由（DSH 没重启或插件没加载？）")
        self._port = port
        return port

    def uses_local_asr(self):
        """识别要不要用本地模型：只有桥里明确设成 funasr 才预热 FunASR。

        官方 SenseVoice 走桥，本地这边根本不用 import funasr —— 那是几百 MB 的常驻。
        桥还没起来（DSH 刚启动）也按官方算：真要用本地模型，第一次说话时再加载。
        """
        try:
            port = self.bridge_port()
            data = web.get_json("http://127.0.0.1:%d/dsh-voice-bridge/config" % port, timeout=5)
        except Exception as e:
            self._log("  问不到桥用什么识别引擎（%s），按官方算" % e)
            return False
        # /config 回的是 { ok, config: {...}, file }，别拿顶层去找
        eng = ((data.get("config") or {}).get("sttEngine")) or data.get("sttEngine") or "official"
        return str(eng).lower() == "funasr"

    def short_for_speech(self, text, limit):
        """念出来的只留前几句，别把长表格念成流水账。"""
        text = re.sub(r"```.*?```", "（代码块）", text, flags=re.S)
        parts = re.split(r"(?<=[。！？!?])", text)
        out = ""
        for p in parts:
            if len(out) + len(p) > limit:
                break
            out += p
        return (out or text)[:limit].strip()

    def speak(self, text):
        try:
            port = int(self.cfg.get("tts_port") or vsettings.TTS_PORT)
            web.post_json("http://127.0.0.1:%d/speak" % port,
                          {"text": text, "play": True, "pet": False}, timeout=300)
            return True
        except Exception as e:
            self._log("  语音播放失败: %s" % e)
            return False

    def pose(self, name):
        """让桌宠摆个姿势（动画名来自桌宠自己的动画池）；失败只记一行，不影响说话。"""
        name = str(name or "").strip()
        if not name:
            return False
        try:
            port = self.bridge_port()
            res = web.post_json("http://127.0.0.1:%d/dsh-voice-bridge/pet-anim" % port,
                                {"name": name}, timeout=10)
            if not res.get("ok"):
                self._log("  姿势没摆成（%s）：%s" % (name, res.get("error") or "桌宠没认这个动作"))
                return False
            return True
        except Exception as e:
            self._log("  姿势没摆成（%s）：%s" % (name, e))
            return False

    def say(self, text):
        port = self.bridge_port()
        self._log("  → 投给会话（端口 %d）…" % port)
        res = web.post_json("http://127.0.0.1:%d/dsh-voice-bridge/say" % port,
                            {"text": text}, timeout=3600)
        if not res.get("ok"):
            raise RuntimeError(res.get("error") or "会话返回失败")
        return res.get("reply") or ""

    def deliver(self, text):
        """delivery=bridge：话进工作区会话，不碰窗口；桥不通才退回粘贴。"""
        if self.cfg.get("delivery", "bridge") == "bridge":
            try:
                reply = self.say(text)
                self._log("  ← " + (reply[:200].replace("\n", " ") or "（空回复）"))
                # 默认不在这儿念：桥那边已经念了（桌宠或它自己），这里再念就是两个声音
                if self.cfg.get("speak_reply", False) and reply.strip():
                    limit = int(self.cfg.get("speak_max_chars") or 100)
                    self.speak(self.short_for_speech(reply, limit))
                return "bridge"
            except Exception as e:
                self._log("  桥接失败(%s)，退回粘贴" % e)
                desk.beep("error", bool(self.cfg.get("beep", True)))

        title = desk.foreground_title()
        if self.should_paste(title):
            desk.paste(text, bool(self.cfg.get("press_enter", False)))
            self._log("  已粘贴到 [%s]" % title)
            return "pasted"
        if self.cfg.get("paste_to_window", True):
            self._log("  前台是 [%s]，不是聊天窗口 → 只放进剪贴板" % title)
        desk.set_clipboard(text)
        self._log("  已放进剪贴板")
        return "clipboard"

    def should_paste(self, title):
        """前台窗口在不在 only_paste_in 白名单里（不配白名单 = 哪儿都行）"""
        if not self.cfg.get("paste_to_window", True):
            return False
        return desk.title_matches(title, self.cfg.get("only_paste_in") or [])


# ---------- 主程序 ----------
class VoiceInput:
    def __init__(self, cfg):
        self.cfg = cfg
        self.recorder = None
        self.delivery = Delivery(cfg)
        # 识别优先问桥（官方 SenseVoice）；桥说用本地模型或不通，才回落到 FunASR
        self.transcriber = Transcriber(cfg, bridge_port=self.delivery.bridge_port)
        self.lock = threading.Lock()
        self.active = False
        # 热键全权交给 HotkeyBinder：它管绑定、换绑、监听配置变化
        self.binder = HotkeyBinder(
            on_start=self.start_rec,
            on_stop=self.finish,
            on_toggle=self.toggle,
            log=self._log,
        )
        self.waker = None

    def _log(self, msg):
        log(msg, self.cfg.get("log"))

    # ---- 一次「录音 -> 识别 -> 投递」----
    def process(self, audio):
        try:
            if audio is None:
                self._log("  没有录到声音")
                return
            text, info, peak = self.transcriber.transcribe(audio)
            if not text:
                self._log("  放弃(%s) 峰值=%.4f" % (info, peak))
                desk.beep("error", bool(self.cfg.get("beep", True)))
                return
            text = self.transcriber.fix_words(text)
            if self.transcriber.needs_punctuation():
                text = self.transcriber.punctuate(text)
            self._log("  > " + text)
            self.delivery.deliver(text)
        except Exception:
            self._log("  处理失败: " + traceback.format_exc(limit=3))

    def finish(self, reason):
        with self.lock:
            if not self.active:
                return
            self.active = False
        desk.beep("stop", bool(self.cfg.get("beep", True)))
        self._log("  ● 结束(%s)" % reason)
        audio = self.recorder.stop() if self.recorder else None
        threading.Thread(target=self.process, args=(audio,), daemon=True).start()

    def start_rec(self, label="● 录音中…", silence=None, max_sec=None):
        with self.lock:
            if self.active:
                return
            self.active = True
        try:
            self.recorder.start(silence_sec=silence, max_sec=max_sec)
            desk.beep("start", bool(self.cfg.get("beep", True)))
            self._log("  " + label)
        except Exception:
            with self.lock:
                self.active = False
            self._log("  录音启动失败: " + traceback.format_exc(limit=2))

    def toggle(self, e=None):
        if self.active:
            self.finish("再按一次")
        else:
            self.start_rec("● 录音中…（再按一次结束）")

    def _watch_engine(self):
        """面板里把识别切成「本地 FunASR」时，后台先把模型加载好。

        不这么做的话，切换后的第一句话要现等 20 秒模型加载，听起来像卡死了。
        """
        while True:
            time.sleep(20)
            try:
                if self.transcriber.ready:
                    continue
                if self.delivery.uses_local_asr():
                    self._log("识别切到本地 FunASR，后台加载模型…")
                    self.transcriber.load_asr()
                    self.transcriber.load_punc()
                    self._log("本地 FunASR 已就绪")
            except Exception:
                self._log("后台加载本地识别模型失败: " + traceback.format_exc(limit=1))

    # ---- 唤醒词模式 ----
    def wake_words(self):
        raw = str(self.cfg.get("wake_words") or "")
        return [w.strip() for w in re.split(r"[,，、;；\s]+", raw) if w.strip()]

    def on_wake(self, word):
        """被叫醒：先摆个姿势应一声（本地 TTS，不进对话），再开始收话，停顿 N 秒自动收工。"""
        with self.lock:
            if self.active:
                return
        reply = str(self.cfg.get("wake_reply") or "").strip()
        # 姿势先摆：动画是为「在」配的，等说完再摆会显得慢半拍
        pose = str(self.cfg.get("wake_pose") or "").strip()
        if pose:
            self.delivery.pose(pose)
        if reply:
            try:
                self.delivery.speak(reply)
            except Exception:
                self._log("  应答失败: %s" % traceback.format_exc(limit=1))
        try:
            silence = float(self.cfg.get("wake_silence_sec", 3.0))
            max_sec = float(self.cfg.get("wake_max_sec", 30))
            self.start_rec("● 听到「%s」，听你说…（停顿 %.1fs 自动收工）" % (word, silence),
                           silence=silence, max_sec=max_sec)
        except Exception:
            self._log("  唤醒后开录失败: %s" % traceback.format_exc(limit=1))

    def start_waker(self, device):
        if self.waker is not None:
            return
        self.waker = WakeListener(
            device, self.cfg,
            transcribe_bytes=self.transcriber.transcribe_bytes,
            on_wake=self.on_wake,
            log=self._log,
            is_busy=lambda: self.active,
        )
        self.waker.set_words(self.wake_words())
        self.waker.start()

    def _watch_wake_config(self):
        """唤醒词/应答/停顿改了不用重启进程：每 1.5 秒比一下配置文件。"""
        last = 0.0
        try:
            last = os.path.getmtime(CFG_PATH)
        except Exception:
            pass
        while True:
            time.sleep(1.5)
            try:
                cur = os.path.getmtime(CFG_PATH)
            except Exception:
                continue
            if cur == last:
                continue
            last = cur
            try:
                self.cfg.reload()
            except Exception:
                continue
            if self.waker is not None:
                self.waker.set_words(self.wake_words())
                # 总开关也在这里生效：关掉就不再比对唤醒词
                want_on = self.cfg.get("input_enabled", True) is not False
                if want_on != self.waker.enabled:
                    self.waker.set_enabled(want_on)
                    self._log("语音输入总开关 -> %s（唤醒%s）"
                              % ("开" if want_on else "关", "恢复监听" if want_on else "监听已停"))
            self._log("唤醒词设置已更新：%s（应答「%s」，停顿 %.1fs）"
                      % ("/".join(self.wake_words()) or "（空）",
                         str(self.cfg.get("wake_reply") or "") or "无",
                         float(self.cfg.get("wake_silence_sec", 3.0))))

    # ---- 常驻 ----
    def run(self, device):
        self.recorder = Recorder(device, self.cfg, on_auto_stop=self.finish)
        # 官方识别模式下不碰 FunASR：省掉 PyTorch 和那几百 MB 常驻，第一次说话也不用等模型
        if self.delivery.uses_local_asr():
            self.transcriber.load_asr()
            threading.Thread(target=self.transcriber.load_punc, daemon=True).start()
        else:
            self._log("识别走官方 SenseVoice（本地 FunASR 不加载）")
        # 面板随时会把识别引擎切来切去：切到 funasr 时后台先把模型备好
        threading.Thread(target=self._watch_engine, daemon=True).start()

        trigger = str(self.cfg.get("trigger_mode") or "hotkey").strip().lower()
        enabled = self.cfg.get("input_enabled", True) is not False
        if trigger == "wakeword":
            # 唤醒词模式：不开热键，常开麦听「唤醒词」
            self.start_waker(device)
            self.waker.set_enabled(enabled)
            self._log("就绪：唤醒词模式，唤醒词 %s，应答「%s」，停顿 %.1fs 自动收工%s"
                      % ("/".join(self.wake_words()) or "（空）",
                         str(self.cfg.get("wake_reply") or "") or "无",
                         float(self.cfg.get("wake_silence_sec", 3.0)),
                         "" if enabled else "（语音输入总开关关着，先不听）"))
            threading.Thread(target=self._watch_wake_config, daemon=True).start()
            self._log("等待唤醒…")
            while True:
                time.sleep(5)
        hotkey = str(self.cfg.get("hotkey") or "f8").strip().lower()
        mode = self.cfg.get("mode") or "hold"
        self.binder.enabled = enabled
        self.binder.bind(hotkey, mode)
        self._log("就绪：%s 模式，热键 %s，静音自动结束=%s%s"
                  % (mode, hotkey.upper(), self.cfg.get("auto_stop", True),
                     "" if enabled else "（语音输入总开关关着，热键不生效）"))
        threading.Thread(target=self.binder.watch, args=(self.cfg, CFG_PATH), daemon=True).start()
        self._log("等待按键…")
        self.binder.wait()


def run_once(cfg, device, secs):
    """录固定秒数直接走一遍（测试用）"""
    app = VoiceInput(cfg)
    rec = Recorder(device, cfg, on_auto_stop=lambda why: None)
    rec.start()
    time.sleep(secs)
    app.process(rec.stop())


def selftest(cfg):
    title = desk.foreground_title()
    log("前台窗口: [%s] 允许粘贴=%s" % (title, desk.title_matches(title, cfg.get("only_paste_in") or [])), cfg.get("log"))
    Transcriber(cfg).load_asr()
    print("标点示例:", Transcriber(cfg).punctuate("今天天气不错我们去吃饭吧顺便看看大肥鱼"))


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="按住热键说话 -> 识别 -> 投给会话/粘贴")
    ap.add_argument("--list", action="store_true", help="列出输入设备")
    ap.add_argument("--once", type=float, metavar="秒", help="录固定秒数直接识别")
    ap.add_argument("--selftest", action="store_true", help="自检：设备/前台窗口/标点")
    ap.add_argument("--punc", metavar="文本", help="只跑标点")
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    cfg = Config(CFG_PATH, DEFAULTS)

    if args.list:
        for i, d in enumerate(sd.query_devices()):
            if d["max_input_channels"] > 0:
                print(i, d["name"])
        return

    if args.punc is not None:
        src = args.punc or "这是一段没有标点的测试文本我们看看能不能加上句号"
        print(Transcriber(cfg).punctuate(src))
        return

    os.makedirs(IN_DIR, exist_ok=True)
    device = Recorder.pick_device(cfg.get("device"))
    log("输入设备: %s (index=%s)" % (cfg.get("device"), device), cfg.get("log"))
    if cfg.get("device") and device is None:
        log("注意：配置里的设备没找到，改用系统默认输入", cfg.get("log"))

    if args.once:
        run_once(cfg, device, args.once)
        return

    if args.selftest:
        selftest(cfg)
        return

    VoiceInput(cfg).run(device)


if __name__ == "__main__":
    sys.exit(main())
