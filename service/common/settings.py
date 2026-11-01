# -*- coding: utf-8 -*-
"""在哪、用哪个端口 —— 四个脚本共用的一份。

**代码和数据分开**：
    service/common/  ->  service/           代码（跟着插件包走：node_modules\\dsh-voice-bridge\\service\\）
    <工作区>/voice/  ->  config.json、in\\、logs\\、sup.pid   运行时数据（不跟着包走）
    <工作区>/tts/    ->  GPT-SoVITS-main、ref\\、out\\、venv\\   模型与素材（几十 G，不能跟包走）

所以「代码在哪个目录」和「数据写到哪个目录」是两件事：
    SERVICE = 这个 common/ 的上一级           —— 脚本在哪
    ROOT    = 工作区                          —— DSH_WORKSPACE，或 SERVICE 的上一级（当它下面有 tts\\）
    VOICE   = ROOT/voice                      —— 配置、录音、日志、pid

覆盖开关：DSH_WORKSPACE / DSH_VOICE_DATA / DSH_TTS_ROOT / DSH_TTS_REPO / DSH_TTS_REF / DSH_TTS_OUT。
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))   # ...\service\common
SERVICE = os.path.dirname(HERE)                     # ...\service   （代码就住这）


def _workspace():
    """工作区：有环境变量听环境变量；否则看代码目录的上一级像不像工作区。"""
    env = os.environ.get("DSH_WORKSPACE")
    if env:
        return env
    parent = os.path.dirname(SERVICE)
    if os.path.isdir(os.path.join(parent, "tts")) or os.path.isdir(os.path.join(parent, "voice")):
        return parent
    return os.getcwd()


ROOT = _workspace()                                             # 工作区（跑起来的 cwd）
VOICE = os.environ.get("DSH_VOICE_DATA") or os.path.join(ROOT, "voice")   # 运行时数据

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
