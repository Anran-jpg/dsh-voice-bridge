# -*- coding: utf-8 -*-
"""HTTP 小封装：只做本项目要的那几件事，超时全部显式给。

以前每个脚本各写一份 urlopen：有的没超时（会一直挂着），有的没解码成 utf-8
（中文变乱码），有的把 ensure_ascii 忘了（中文被写成反斜杠 u 的转义，对面收到一堆码）。
"""
import json
import urllib.error
import urllib.request

UA = "dsh-voice-bridge/0.1"


def get_json(url, timeout=6.0, headers=None):
    req = urllib.request.Request(url, headers=dict({"User-Agent": UA}, **(headers or {})))
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def post_json(url, obj, timeout=300.0, headers=None):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    hdrs = {"Content-Type": "application/json; charset=utf-8", "User-Agent": UA}
    hdrs.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=hdrs, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def post_empty(url, timeout=6.0, headers=None):
    """无请求体的 POST（/bubble/clear 就是这个形态）"""
    hdrs = {"User-Agent": UA}
    hdrs.update(headers or {})
    req = urllib.request.Request(url, data=b"", headers=hdrs, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def healthy(url, timeout=2.0):
    """GET 一下，能出 JSON 且 ok 为真就算活着"""
    try:
        return bool(get_json(url, timeout).get("ok"))
    except Exception:
        return False
