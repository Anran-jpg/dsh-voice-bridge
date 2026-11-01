# -*- coding: utf-8 -*-
"""找当前 DSH 的端口。

DSH 每次启动 GUI 端口都会变（53290 / 61173 / …），所以凡是「要跟 DSH 说话」
的脚本都不能写死端口，得现找。两类端口：

    gui      —— 桌宠路由所在的端口（/dsh-pet-7340/…），pet-voice 用
    bridge   —— 语音桥路由所在端口（/dsh-voice-bridge/…），voice-in 用

两者现在都在同一个进程里，但探针不同，所以分开两个函数。
psutil 是延迟导入的：没有它时这些函数直接返回 None，调用方自己兜底。
"""
import sys


def _listen_ports():
    """DeepSeek Harness 进程所有监听端口（升序）"""
    try:
        import psutil
    except Exception:
        return []
    ports = set()
    for p in psutil.process_iter(["name", "pid"]):
        try:
            name = p.info.get("name") or ""
            if "DeepSeek Harness" not in name:
                continue
            for c in p.net_connections(kind="inet"):
                if c.status == psutil.CONN_LISTEN and c.laddr and c.laddr.port > 1024:
                    ports.add(c.laddr.port)
        except Exception:
            continue
    return sorted(ports)


def _probe(path_tpl, ok, timeout=1.2):
    from .http import get_json

    for port in _listen_ports():
        try:
            data = get_json(path_tpl.format(port=port), timeout=timeout)
        except Exception:
            continue
        if ok(data):
            return port
    return None


def find_gui_port(pet="main"):
    """桌宠路由所在的端口：能读到这只宠物的配置就算认了"""
    return _probe(
        "http://127.0.0.1:{port}/dsh-pet-7340/config?pet=" + pet,
        lambda d: isinstance(d, dict) and ("pets" in d or "ok" in d or pet in d),
    )


def find_bridge_port():
    """语音桥路由所在的端口：/config 回 ok 就算认了。

    别拿 /status 当探针 —— 它要顺带做四家引擎的健康检查，经常超过 1 秒，
    探针超时了就误判成"没有桥"。
    """
    return _probe(
        "http://127.0.0.1:{port}/dsh-voice-bridge/config",
        lambda d: isinstance(d, dict) and d.get("ok"),
        timeout=3.0,
    )


if __name__ == "__main__":
    # 手动排查用：python -m common.ports
    print("gui   =", find_gui_port())
    print("bridge=", find_bridge_port())
    sys.exit(0)
