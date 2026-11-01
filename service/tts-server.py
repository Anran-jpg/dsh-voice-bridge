# -*- coding: utf-8 -*-
"""大肥鱼 TTS 常驻服务：模型只加载一次，之后 POST 一句话就出声。

这个文件只剩「入口」：解析参数、造引擎、起 HTTP。
具体实现分两处：
  tts_engine.py  模型 / 合成 / 播放（不知道 HTTP 存在，可以单测）
  tts_http.py    路由外壳（只知道 engine 的公开方法）

用法:
  python voice/tts-server.py [--port 8777] [--no-preload]

接口:
  POST /speak   {"text": "...", "play": true, "pet": false, "speed": 1.0}
      -> {"ok": true, "file": "...wav", "audio_sec": 4.1, "cost_sec": 1.8}
  POST /play    {"file": "....wav|.mp3"}   -> {"ok": true}（进程内播，不闪窗）
  GET  /health  -> {"ok": true, "model_loaded": true, "cuda": true, ...}

目录约定（脚本在 voice\，资源仍在 tts\）：见 common\settings.py。
"""
import argparse
import os
import sys
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # 让 `import common` 生效

from common import log as vlog
from common.settings import TTS_PORT
from tts_engine import TTSEngine
from tts_http import make_handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=TTS_PORT)
    ap.add_argument("--no-preload", action="store_true", help="先不加载模型，等第一次 /speak")
    a = ap.parse_args()

    engine = TTSEngine()
    vlog.log(
        "repo=%s\n         ref=%s\n         out=%s" % (engine.repo, engine.ref, engine.outdir),
        tag="[tts]",
    )
    if not a.no_preload:
        engine.load()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(engine))
    vlog.log("listening on http://127.0.0.1:%d" % a.port, tag="[tts]")
    srv.serve_forever()


if __name__ == "__main__":
    main()
