# -*- coding: utf-8 -*-
"""唤醒词监听：滚动短窗 + 语音识别 + 文本近似匹配。

为什么用「短窗 ASR」而不是专用 KWS 模型（openWakeWord / Porcupine 那种）：
官方 SenseVoice 本来就在跑（int8 ONNX，2 秒窗一次推理 0.1~0.3 秒），
不用再下一个唤醒词模型、也不用申请授权码；代价是待机时每秒多花几百毫秒 CPU。
匹配用近似而不是精确：这类模型对口音/语速敏感，「大肥鱼」常被听成「大飞鱼」，
逐字精确比对基本等于没有唤醒词。
"""
import difflib
import io
import threading
import time
import wave
from collections import deque

import numpy as np
import sounddevice as sd

# 近似阈值：短词（2~4 字）宁松勿紧，误唤醒的代价只是多听一句，漏唤醒的代价是叫不应
NEAR = 0.62


def norm(text):
    """只留汉字和字母数字，去掉标点/空格 —— 识别结果里的标点对匹配是噪音"""
    out = []
    for ch in str(text or ""):
        if ch.isalnum():
            out.append(ch.lower())
    return "".join(out)


def match(text, words):
    """返回命中的唤醒词（没命中返回 None）。

    先看直接包含；不中再滑动窗口逐个比相似度，避免「大飞鱼 vs 大肥鱼」这种差一个字被漏掉。
    """
    t = norm(text)
    if not t:
        return None
    for w in words:
        key = norm(w)
        if not key:
            continue
        if key in t:
            return w
        n = len(key)
        if len(t) < n - 1:
            continue
        span = n + (1 if n <= 3 else 0)
        for i in range(0, max(1, len(t) - span + 1)):
            seg = t[i:i + span]
            if difflib.SequenceMatcher(None, seg, key).ratio() >= NEAR:
                return w
    return None


class WakeListener:
    """常开麦克风，攒够一个窗口就送去识别一次，听到唤醒词就回调。

    transcribe_bytes(wav_bytes) -> str 由调用方注入（走桥的官方识别，或本地 FunASR），
    这样这个类自己不认识 HTTP 也不认识模型。
    """

    def __init__(self, device, cfg, transcribe_bytes, on_wake, log, is_busy=None):
        self.device = device
        self.cfg = cfg
        self.transcribe = transcribe_bytes
        self.on_wake = on_wake
        self.log = log
        self.is_busy = is_busy or (lambda: False)
        self.sr = int(cfg.get("samplerate", 16000))
        self.window_sec = float(cfg.get("wake_window_sec", 2.0))
        self.hop = float(cfg.get("wake_hop_sec", 0.5))
        self.min_peak = float(cfg.get("wake_peak", 0.02))
        self.cooldown = float(cfg.get("wake_cooldown_sec", 3.0))
        self.words = []
        self.stream = None
        self.buf = deque(maxlen=int(self.sr * (self.window_sec + 0.5)))
        self.lock = threading.Lock()
        self.running = False
        self.paused = False
        # 总开关（面板上的「语音输入」）：关掉就彻底不听，连麦克风采样都跳过比对
        self.enabled = True

    # ---- 配置（面板改了唤醒词不用重启进程）----
    def set_words(self, words):
        self.words = [w.strip() for w in words if str(w).strip()]

    def set_enabled(self, on):
        self.enabled = bool(on)

    def pause(self, on=True):
        self.paused = bool(on)

    # ---- 音频 ----
    def _cb(self, indata, frames, t, status):
        with self.lock:
            self.buf.extend(indata[:, 0].copy())

    def _snapshot(self):
        with self.lock:
            need = int(self.sr * self.window_sec)
            if len(self.buf) < need:
                return None
            return np.array(list(self.buf)[-need:], dtype="float32")

    @staticmethod
    def _wav_bytes(audio, sr):
        pcm = np.clip(audio, -1.0, 1.0)
        pcm = (pcm * 32767).astype("<i2").tobytes()
        bio = io.BytesIO()
        with wave.open(bio, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes(pcm)
        return bio.getvalue()

    def listen_loop(self):
        last_hit = 0.0
        while self.running:
            time.sleep(self.hop)
            if not self.enabled or self.paused or self.is_busy() or not self.words:
                continue
            audio = self._snapshot()
            if audio is None:
                continue
            if float(np.max(np.abs(audio))) < self.min_peak:
                continue
            if time.time() - last_hit < self.cooldown:
                continue
            try:
                text = self.transcribe(self._wav_bytes(audio, self.sr))
            except Exception as e:  # 网络/服务抖动不该把监听循环打断
                self.log("  唤醒词识别失败: %s" % e)
                time.sleep(1.0)
                continue
            hit = match(text, self.words)
            if hit:
                last_hit = time.time()
                self.log("  ◆ 听到唤醒词「%s」（听成：%s）" % (hit, (text or "").strip() or "空"))
                try:
                    self.on_wake(hit)
                except Exception:
                    self.log("  唤醒处理失败")

    def start(self):
        if self.running:
            return
        self.running = True
        self.stream = sd.InputStream(
            samplerate=self.sr, channels=1, dtype="float32",
            device=self.device, callback=self._cb, blocksize=int(self.sr * 0.05))
        self.stream.start()
        threading.Thread(target=self.listen_loop, daemon=True).start()

    def stop(self):
        self.running = False
        s, self.stream = self.stream, None
        if s is not None:
            try:
                s.stop()
                s.close()
            except Exception:
                pass
