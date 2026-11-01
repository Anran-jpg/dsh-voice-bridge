# -*- coding: utf-8 -*-
"""看门狗：把三个常驻脚本管住，谁挂了拉起来。

  1) tts-server.py  (8777)       —— 健康检查 GET /health，模型加载期给 40 秒宽限
  2) voice-in.py     (热键)      —— 只看进程还在不在
  3) pet-voice.py    (桌宠朗读)  —— 进程存活 + GUI 端口每次重启动态发现

用法:
  python sup.py                 # 常驻（开机自启的就是它）
  python sup.py --once          # 只体检+修复一轮，退出
  python sup.py --status        # 打一份当前状态
  python sup.py --interval 5    # 体检间隔（忙时会自动退避到 60 秒）

设计要点（踩过的坑写在对应位置）:
  - 日志句柄：Popen 的 stdout 句柄由子进程持有，父进程 spawn 完必须 close，
    否则每重拉一次就泄一个 fd。
  - 认进程：只认名字以 python 开头的进程 + 命令行含脚本名。**不能只按命令行子串匹配**，
    否则「命令行里恰好提到 voice-in.py」的 pwsh/编辑器也会被误杀。
  - 端口：不写死。DSH 每次重启 GUI 端口都变，靠 common.ports 现找。
"""
import argparse
import json
import os
import subprocess
import sys
import time

from common import http as web
from common import settings as vsettings
from common.log import cap_all, log as _log
from common.ports import find_gui_port

HERE = vsettings.VOICE
BASE = vsettings.ROOT
PY = vsettings.PY
TTS_PORT = vsettings.TTS_PORT
LOG_DIR = vsettings.LOG_DIR
LOG = vsettings.SUP_LOG
PIDFILE = vsettings.SUP_PID
CREATE_NO_WINDOW = 0x08000000

SCRIPTS = {
    "tts": os.path.join(HERE, "tts-server.py"),
    "voice": os.path.join(HERE, "voice-in.py"),
    "petvoice": os.path.join(HERE, "pet-voice.py"),
}
LOGS = {
    "tts": os.path.join(LOG_DIR, "tts-server.log"),
    "voice": os.path.join(LOG_DIR, "voice-in.out.log"),
    "petvoice": os.path.join(LOG_DIR, "pet-voice.log"),
}
NAMES = ("tts", "voice", "petvoice")

START_GRACE = 40.0        # TTS 模型加载要 40~60 秒，这段里不通不算挂
MAX_RESTARTS = 5          # 一个窗口里最多重启几次
RESTART_WINDOW = 60.0
RESTART_PAUSE = 30.0
POLL_INTERVAL = vsettings.PET_POLL   # 传给 pet-voice 的轮询间隔


def plog(msg):
    _log(msg, LOG, tag="[sup]", date=True)


def cap_logs():
    cap_all(LOGS.values())


class PidFile(object):
    """sup.pid 这一个文件的事：谁在跑、写进去、还活着吗。

    单独成类是因为它只是「单实例锁」，不是看门狗的业务逻辑；
    混进 Supervisor 会让「管进程」和「管一个文本文件」黏在一起。
    """

    def __init__(self, path):
        self.path = path

    def read(self):
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                return int((f.read() or "0").strip())
        except Exception:
            return 0

    def write(self, pid=None):
        pid = os.getpid() if pid is None else int(pid)
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as f:
            f.write(str(pid))
        return pid

    def remove(self):
        try:
            os.remove(self.path)
        except OSError:
            pass

    @staticmethod
    def alive(pid):
        if not pid:
            return False
        try:
            import psutil
            return psutil.pid_exists(pid) and psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
        except Exception:
            return False

    def running(self):
        """正在跑的那个 pid；没有就 0。"""
        pid = self.read()
        return pid if pid and self.alive(pid) else 0


class Supervisor:
    def __init__(self):
        self.procs = {}      # name -> Popen
        self.gui_port = None
        self.restarts = {}   # name -> [时间戳...]
        self.spawn_at = {}   # name -> 时间戳

    # ---------- 认进程 / 杀进程 ----------
    def pids_of(self, name):
        """这个脚本现在有几个进程（venv 的 python.exe + 真解释器 = 两个，正常）"""
        try:
            import psutil
        except Exception:
            return []
        script = os.path.basename(SCRIPTS[name]).lower()
        me = os.getpid()
        out = []
        for p in psutil.process_iter(["pid", "name", "cmdline"]):
            try:
                if p.pid == me:
                    continue
                exe = (p.info.get("name") or "").lower()
                # 只认 python 系：别把「命令行里提到脚本名」的 pwsh 也算进来
                if not (exe.startswith("python") or exe.startswith("pythonw")):
                    continue
                cmd = " ".join(p.info.get("cmdline") or []).lower()
                if script in cmd:
                    out.append(p.pid)
            except Exception:
                continue
        return out

    def kill(self, name):
        for pid in self.pids_of(name):
            try:
                import psutil
                psutil.Process(pid).kill()
                plog("清掉残留 %s pid=%d" % (name, pid))
            except Exception as e:
                plog("清 %s pid=%d 失败: %s" % (name, pid, e))
        p = self.procs.pop(name, None)
        if p is not None and p.poll() is None:
            try:
                p.kill()
            except Exception:
                pass
        return

    # ---------- 起进程 ----------
    def spawn(self, name, extra=()):
        cmd = [PY, SCRIPTS[name]] + list(extra)
        out = open(LOGS[name], "ab")
        try:
            p = subprocess.Popen(
                cmd, cwd=BASE, stdin=subprocess.DEVNULL,
                stdout=out, stderr=subprocess.STDOUT,
                creationflags=CREATE_NO_WINDOW)
        finally:
            out.close()  # 子进程已经拿到句柄，父进程这份必须放掉，否则每次重拉泄一个 fd
        self.procs[name] = p
        self.spawn_at[name] = time.time()
        self.restarts.setdefault(name, []).append(time.time())
        return p

    # ---------- 体检 ----------
    def tts_ok(self):
        return web.healthy("http://127.0.0.1:%d/health" % TTS_PORT, timeout=3.0)

    def healthy(self, name):
        if name == "tts":
            if self.tts_ok():
                return True
            # 刚拉起来的模型还在加载：不算挂，别来回重启
            p = self.procs.get(name)
            just_started = p is not None and p.poll() is None and (time.time() - self.spawn_at.get(name, 0)) < START_GRACE
            return just_started
        p = self.procs.get(name)
        if p is not None and p.poll() is None:
            return True
        return bool(self.pids_of(name))

    def _too_many_restarts(self, name):
        now = time.time()
        hist = [t for t in self.restarts.get(name, []) if now - t <= RESTART_WINDOW]
        self.restarts[name] = hist
        return len(hist) >= MAX_RESTARTS

    def ensure(self, name):
        if self.healthy(name):
            return True
        if self._too_many_restarts(name):
            plog("%s 一分钟内重启 %d 次，先歇 %.0f 秒再看" % (name, MAX_RESTARTS, RESTART_PAUSE))
            self.restarts[name] = []
            time.sleep(RESTART_PAUSE)
            return False

        self.kill(name)
        extra = []
        if name == "petvoice":
            port = self.gui_port or find_gui_port()
            if not port:
                plog("找不到 DSH 的 GUI 端口，这轮先跳过 petvoice")
                return False
            self.gui_port = port
            extra = ["--port", str(port), "--tts", str(TTS_PORT), "--poll", POLL_INTERVAL]
        try:
            self.spawn(name, extra)
            plog("启动 %s pid=%d%s" % (name, self.procs[name].pid,
                                       (" (gui=%s)" % self.gui_port) if name == "petvoice" else ""))
            return True
        except Exception as e:
            plog("启动 %s 失败: %s" % (name, e))
            return False

    # ---------- 状态 ----------
    def status(self):
        return {
            # --status 是只读查询，顺手现找一次端口，别让人以为「没找到」
            "gui_port": self.gui_port or find_gui_port(),
            "tts_ok": self.tts_ok(),
            "procs": {
                n: {
                    "pids": self.pids_of(n),
                    "healthy": self.healthy(n),
                    "script": SCRIPTS[n],
                }
                for n in NAMES
            },
        }

    # ---------- 主循环 ----------
    def loop(self, interval, once=False):
        # 首次接管：把旧实例清干净，避免两份抢端口
        for name in NAMES:
            self.kill(name)
        time.sleep(1.0)
        idle = max(interval * 2, 10.0)
        loops = 0
        while True:
            loops += 1
            if loops % 4 == 1:
                cap_logs()
            bad = False
            for name in NAMES:
                if self.healthy(name):
                    continue
                bad = True
                self.ensure(name)
            port = find_gui_port() if (bad or loops % 20 == 1) else None
            if port and port != self.gui_port:
                if self.gui_port is not None:
                    plog("GUI 端口变了：%s -> %s，重启 petvoice" % (self.gui_port, port))
                    self.kill("petvoice")
                self.gui_port = port
            idle = interval if bad else min(idle * 1.6, 60.0)
            if once:
                return
            time.sleep(idle)


def main(argv=None):
    ap = argparse.ArgumentParser(description="大肥鱼语音看门狗")
    ap.add_argument("--once", action="store_true", help="只体检一轮就退出")
    ap.add_argument("--status", action="store_true", help="打印状态后退出")
    ap.add_argument("--interval", type=float, default=5.0, help="体检间隔秒数")
    args = ap.parse_args(argv)

    os.makedirs(LOG_DIR, exist_ok=True)
    sup = Supervisor()

    if args.status:
        print(json.dumps(sup.status(), ensure_ascii=False, indent=2))
        return 0

    pidfile = PidFile(PIDFILE)
    old = pidfile.running()
    if old and old != os.getpid():
        plog("已有看门狗在跑（pid=%d），本实例退出" % old)
        return 0
    pidfile.write()
    if os.path.exists(PY):
        plog("看门狗启动 pid=%d，解释器 %s" % (os.getpid(), PY))
    else:
        plog("看门狗启动 pid=%d，但找不到解释器 %s" % (os.getpid(), PY))
    try:
        sup.loop(args.interval, once=args.once)
    except KeyboardInterrupt:
        plog("看门狗退出（Ctrl+C）")
    except Exception:
        import traceback
        plog("看门狗异常退出: " + traceback.format_exc(limit=5))
        raise
    return 0


if __name__ == "__main__":
    sys.exit(main())