# -*- coding: utf-8 -*-
"""音频：写 wav、把任意格式转成 wav、同步播放。

为什么播放放在这里：三处都要「放一段声音」，而各自开子进程的写法都踩过坑
（detached 的 powershell 0.2 秒就退出、python.exe 会闪控制台窗口）。
统一做法是**进程内** winsound —— 谁调用谁阻塞，不起子进程，就不闪窗。
"""
import os
import time
import wave

import numpy as np


def write_wav(path, samples, sr):
    """单声道 float32（-1~1）→ 16bit wav，顺手 clip 一下免得爆音"""
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    pcm = (np.clip(np.asarray(samples, dtype="float32"), -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(pcm.tobytes())
    return path


def to_wav(src, outdir=None):
    """winsound 只吃 wav；edge 之类只会给 mp3 —— 用 soundfile 解一份出来。

    解出来的临时文件由调用方（或 play 的 finally）删。
    """
    import soundfile as sf

    data, sr = sf.read(src, dtype="float32", always_2d=True)
    mono = data.mean(axis=1) if data.shape[1] > 1 else data[:, 0]
    outdir = outdir or os.path.dirname(os.path.abspath(src))
    out = os.path.join(outdir, "play-%d.wav" % int(time.time() * 1000))
    return write_wav(out, mono, sr)


def play(path, outdir=None):
    """同步播完才返回。非 wav 先转，播放完删临时文件。

    返回 (ok, 说明)：ok=False 时说明里带原因，方便 /health 或日志追问。
    """
    tmp = None
    try:
        import winsound
    except Exception:
        return False, "这台机器没有 winsound（不是 Windows？）"
    try:
        target = path
        if not str(path).lower().endswith(".wav"):
            tmp = to_wav(path, outdir)
            target = tmp
        winsound.PlaySound(target, winsound.SND_FILENAME)
        return True, ""
    except Exception as e:
        return False, str(e)
    finally:
        if tmp and os.path.exists(tmp):
            try:
                os.remove(tmp)
            except Exception:
                pass


def duration(path):
    """wav 时长（秒）；读不出来返回 0"""
    try:
        with wave.open(path, "rb") as w:
            return w.getnframes() / float(w.getframerate() or 1)
    except Exception:
        return 0.0
