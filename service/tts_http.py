# -*- coding: utf-8 -*-
"""TTS 的 HTTP 外壳：只做「收 JSON → 调引擎 → 回 JSON」，不碰模型。

路由：
  GET  /health          -> {"ok", "model_loaded", "cuda", "ref", "ref_exists", "outdir"}
  POST /play   {file}   -> {"ok", "file"}
  POST /speak  {text, speed, play, pet, petId}
                        -> {"ok", "file", "audio_sec", "cost_sec"[, "pet"][, "played"]}

引擎是注入进来的（`make_handler(engine)`），所以这里没有全局变量，
想换引擎/造假引擎测试都只用在入口处换一个对象。
"""
import json
import os
from http.server import BaseHTTPRequestHandler

TAG_HANDLER = "[tts-http]"


class JsonHandler(BaseHTTPRequestHandler):
    """极简 JSON 路由：回包、读包、别把每条请求吐进日志"""

    server_version = "dsh-tts/1.0"

    def log_message(self, fmt, *args):
        pass

    def _json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")


def make_handler(engine):
    """把 engine 关进闭包：Handler 不持有任何全局状态"""

    class Handler(JsonHandler):
        # -- GET --------------------------------------------------------
        def do_GET(self):
            if self.path.startswith("/health"):
                self._json(200, engine.health())
            else:
                self._json(404, {"ok": False, "error": "not found"})

        # -- POST -------------------------------------------------------
        def do_POST(self):
            if self.path.startswith("/play"):
                return self._post_play()
            if self.path.startswith("/speak"):
                return self._post_speak()
            self._json(404, {"ok": False, "error": "not found"})

        def _payload(self):
            """读 body；坏 JSON 直接回 400 并返回 None"""
            try:
                return self._body()
            except Exception as e:
                self._json(400, {"ok": False, "error": "bad json: %s" % e})
                return None

        def _post_play(self):
            payload = self._payload()
            if payload is None:
                return
            wav = str(payload.get("file") or "").strip()
            if not wav or not os.path.exists(wav):
                return self._json(400, {"ok": False, "error": "file 不存在: %s" % wav})
            ok, why = engine.play_file(wav)
            res = {"ok": bool(ok), "file": wav}
            if not ok:
                res["error"] = why
            self._json(200, res)

        def _post_speak(self):
            payload = self._payload()
            if payload is None:
                return
            text = str(payload.get("text") or "").strip()
            if not text:
                return self._json(400, {"ok": False, "error": "text 为空"})
            speed = float(payload.get("speed") or 1.0)
            try:
                wav, audio_sec, cost = engine.synthesize(text, speed)
            except Exception as e:
                return self._json(500, {"ok": False, "error": "%s: %s" % (type(e).__name__, e)})
            res = {"ok": True, "file": wav, "audio_sec": round(audio_sec, 2), "cost_sec": round(cost, 2)}
            if payload.get("pet"):
                res["pet"] = engine.pet_say(text, str(payload.get("petId") or "main"))
            if payload.get("play", True):
                res["played"] = engine.play(wav)
            self._json(200, res)

    return Handler
