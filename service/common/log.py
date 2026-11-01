# -*- coding: utf-8 -*-
"""日志：带毫秒时间戳 + 超限就地裁剪。

为什么要毫秒：排查「先出声还是先出字」这种东西，光有 HH:MM:SS 根本对不上，
而 stdout 已经重定向进文件了，时间戳只能自己打。

为什么要「就地裁剪」而不是重开文件：子进程的 stdout 是 append 句柄，
换文件名它不知道；截成「只留最后 500KB」再写回去，句柄不受影响。
"""
import os
import time

MAX_BYTES = 2 * 1024 * 1024
KEEP_BYTES = 500 * 1024


def now(date=False):
    """HH:MM:SS.mmm —— 排查时序用；date=True 时带上日期（看门狗日志要按天回看）"""
    ms = int(time.time() * 1000) % 1000
    if date:
        return time.strftime("%Y-%m-%d %H:%M:%S") + ".%03d" % ms
    return time.strftime("%H:%M:%S") + ".%03d" % ms


def cap(path, max_bytes=MAX_BYTES, keep_bytes=KEEP_BYTES):
    """超过上限就把前面截掉，只留最后 keep_bytes"""
    try:
        if os.path.getsize(path) <= max_bytes:
            return False
        with open(path, "rb") as f:
            f.seek(-keep_bytes, os.SEEK_END)
            tail = f.read()
        with open(path, "wb") as f:
            f.write(tail)
        return True
    except Exception:
        return False


def log(msg, path=None, tag=None, date=False):
    """打一行：终端（被重定向时就是 .log）+ 可选写另一份文件

    date=True 打「年-月-日 时:分:秒.毫秒」，适合一天要回看好几次的看门狗日志。
    """
    line = "%s %s%s" % (now(date), (tag + " ") if tag else "", msg)
    try:
        print(line, flush=True)
    except Exception:
        pass
    if path:
        try:
            os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
            with open(path, "a", encoding="utf-8") as f:
                f.write(line + "\n")
            cap(path)
        except Exception:
            pass
    return line

def cap_all(paths, max_bytes=None, keep_bytes=None):
    """一次裁一批日志（看门狗每轮都会扫一遍 logs/ 下的几个文件）。"""
    for p in paths:
        try:
            cap(p, max_bytes or MAX_BYTES, keep_bytes or KEEP_BYTES)
        except Exception:
            pass
