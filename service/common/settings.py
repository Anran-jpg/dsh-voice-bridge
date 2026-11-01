# -*- coding: utf-8 -*-
"""在哪、用哪个端口 —— 四个脚本共用的一份。

以前「E:\\DSH_Work」和「8777」这两个字面量散在四个文件里，改一个地方要翻四遍，
而且挪目录时会漏。这里按 `common/` 的位置往上推，一步算清：

    common/  ->  voice/  ->  DSH_Work/                       （代码）
    DSH_Work/tts/  GPT-SoVITS-main / ref/ / out/ / venv/     （模型与素材）

模型和素材故意不跟着代码搬：GPT-SoVITS 有几十 G，挪一次得复制一遍。
要换位置就用 DSH_TTS_ROOT / DSH_TTS_REPO / DSH_TTS_REF / DSH_TTS_OUT 覆盖。
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))   # ...\voice\common
VOICE = os.path.dirname(HERE)                       # ...\voice
ROOT = os.path.dirname(VOICE)                       # ...\DSH_Work

TTS_ROOT = os.environ.get("DSH_TTS_ROOT") or os.path.join(ROOT, "tts")
REPO = os.environ.get("DSH_TTS_REPO") or os.path.join(TTS_ROOT, "GPT-SoVITS-main")
REF = os.environ.get("DSH_TTS_REF") or os.path.join(TTS_ROOT, "ref", "ref-8s.wav")
OUTDIR = os.environ.get("DSH_TTS_OUT") or os.path.join(TTS_ROOT, "out", "server")

CONFIG = os.path.join(VOICE, "config.json")
VOICE_CONFIG = os.path.join(VOICE, "config.json")   # 给说得更明白的调用方用
IN_DIR = os.path.join(VOICE, "in")
LOG_DIR = os.path.join(VOICE, "logs")
SUP_LOG = os.path.join(LOG_DIR, "sup.log")
SUP_PID = os.path.join(VOICE, "sup.pid")

PY = os.path.join(TTS_ROOT, "venv", "Scripts", "python.exe")
PYW = os.path.join(TTS_ROOT, "venv", "Scripts", "pythonw.exe")

# 本地 TTS 服务的端口：sup / tts-server / pet-voice / voice-in 都认这一个
TTS_PORT = 8777
# DSH GUI 端口探不到时的兜底（正常情况靠 common.ports 现找）
GUI_PORT_FALLBACK = 53290
# pet-voice 轮询桌宠 /state 的间隔（秒，字符串：要直接拼进命令行）
PET_POLL = "0.4"
