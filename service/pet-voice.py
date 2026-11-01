# -*- coding: utf-8 -*-
"""把桌宠的气泡和语音对齐：谁念谁画，而且「念完才收」。

原来的做法是「合成完就弹气泡，然后立刻播」，看起来像同步，其实差一拍：
气泡要经过 宿主写 state → 客户端长轮询取到 → React 渲染 才真的画到屏幕上，
而 PlaySound 是广播完立刻开始的 —— 于是变成「声音先出、字后到」；
气泡的倒计时又是从客户端收到那一刻起算，两边各走各的，很容易错开。

现在：

  1. 语音桥把台词丢进来时 duration=0（只递台词，不显示）
  2. 这里先把台词合成成 wav，拿到真实音频长度
  3. 广播气泡，duration 给足（音频 + 渲染提前量 + 尾巴）当保险
  4. 等 RENDER_LEAD_MS 让字先画出来，再 winsound 同步播（进程内，不起子进程、不闪窗）
  5. 播完显式 POST /bubble/clear 收气泡 —— 不靠倒计时，所以绝不会「没念完就没了」

用法: python voice/pet-voice.py --port 61173 --tts 8777 --poll 0.4
"""
import argparse
import os
import queue
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # 让 `import common` 生效

from common import audio as vaudio
from common import http as vhttp
from common import log as vlog
from common.settings import TTS_PORT
from common.ports import find_gui_port

# 广播到真正开口之间留的时间：够宿主写 state + 客户端长轮询 + React 画出来
# （实测宿主写完 state 到长轮询拿到只要 5ms，所以这个值主要是在等「客户端那一段」；
#   正回复的时候客户端偶尔会退到 1s 的兜底轮询，再叠上渲染，1.2s 不够 —— 定 2s。
#   命令行 --lead 可以临时调，不用改代码）
RENDER_LEAD_MS = 1200
# 气泡比音频多留一点（保险，正常由播放后的 /bubble/clear 收）
TAIL_MS = 1500
MIN_MS = 1200
# 播完到收气泡之间留一点，让最后一个字站住
HOLD_AFTER_MS = 300
# 合成失败时气泡至少显示这么久，别让人只看到一闪
FALLBACK_MS = 10000

TAG = "[pet-voice]"

# 一句多长就切一段：太短会让语调被切碎，太长又要等整段合成完才开口
CHUNK_CHARS = 30
# 断句符：这些字符后面切一刀最自然
BREAKS = "。！？；!?;\n"


def split_chunks(text, limit=CHUNK_CHARS):
    """把一段话切成「能边合边念」的小段。

    为什么要切：本地克隆音色合成一句话大约要 0.3 倍实时（19 秒音频要 5.6 秒合），
    整段合完再开口的话，第一句往往是回复出来 6 秒后才响。切成小段后第一段
    1~2 秒就能开口，后面的段落在播第一段的同时由后台线程接着合。
    """
    out, buf = [], ""
    for ch in text:
        buf += ch
        if ch in BREAKS and len(buf.strip()) >= 8:
            out.append(buf.strip())
            buf = ""
        elif len(buf) >= limit:
            cut = max(buf.rfind("，"), buf.rfind(","), buf.rfind("、"), buf.rfind(" "))
            if cut >= 8:
                out.append(buf[: cut + 1].strip())
                buf = buf[cut + 1 :]
            else:
                out.append(buf.strip())
                buf = ""
    if buf.strip():
        out.append(buf.strip())
    return out or [text]


class Say(object):
    """桌宠「说话气泡」叶子的一次快照。

    counter 用来判重（同一句不会念两遍），text 是要念的台词，data 是原始 payload。
    做成对象是为了让调用处不用记元组里谁是第几个。
    """

    __slots__ = ("counter", "text", "data")

    def __init__(self, counter, text, data):
        self.counter = counter
        self.text = text
        self.data = data


class PetVoice(object):
    """桌宠的那张嘴：看 state → 合成 → 弹气泡 → 播 → 收气泡"""

    def __init__(self, port, pet="main", tts_port=TTS_PORT, poll=0.4, lead_ms=None):
        self.port = port
        self.pet = pet
        self.poll = poll
        self.lead_ms = RENDER_LEAD_MS if lead_ms is None else lead_ms
        self.tts_url = "http://127.0.0.1:%d/speak" % tts_port
        self._rebuild_urls()

    def _rebuild_urls(self):
        """网页端地址跟着 GUI 端口走：DSH 重启后端口会变，这里统一重算一次。"""
        p, pet = self.port, self.pet
        self.state_url = "http://127.0.0.1:%d/dsh-pet-7340/state" % p
        self.broadcast_url = "http://127.0.0.1:%d/dsh-pet-7340/broadcast?pet=%s&surface=any" % (p, pet)
        self.bubble_url = "http://127.0.0.1:%d/dsh-pet-7340/bubble/clear?pet=%s&surface=any" % (p, pet)

    # -- 气泡
    def _bubble(self, text, duration_ms, anim):
        payload = {"text": text, "duration": int(duration_ms)}
        if anim is not None:
            payload["anim"] = anim
        return vhttp.post_json(self.broadcast_url, payload, timeout=6)

    def _clear(self):
        try:
            vhttp.post_empty(self.bubble_url, timeout=6)
            vlog.log("收气泡", tag=TAG)
        except Exception as e:
            vlog.log("收气泡失败: %s" % e, tag=TAG)

    def _synth(self, text):
        """合成一句，拿回 (wav 路径, 音频秒数)；失败直接抛，由调用处决定怎么兜。"""
        r = vhttp.post_json(self.tts_url, {"text": text, "play": False, "pet": False}, timeout=300)
        wav = r.get("file")
        sec = float(r.get("audio_sec") or 0)
        if not wav:
            raise RuntimeError("TTS 没返回音频文件")
        return wav, sec

    def speak(self, text):
        """边合边念：第一段合完就开口，后面几段在播的时候接着合。

        整段合完再念的代价是「开口等整段合成时间」（长回复 5 秒以上），
        所以这里切成小段：先出字、先开口，剩下的在后面排队播。
        """
        t0 = time.time()
        chunks = split_chunks(text)
        vlog.log("开始合成：%s（%d 段）" % (text[:24], len(chunks)), tag=TAG)

        q = queue.Queue()

        def worker():
            for c in chunks:
                try:
                    wav, sec = self._synth(c)
                    q.put((c, wav, sec, None))
                except Exception as e:
                    q.put((c, None, 0.0, e))
            q.put((None, None, 0.0, None))  # 结束哨兵

        threading.Thread(target=worker, daemon=True).start()

        played = 0
        total_sec = 0.0
        while True:
            chunk, wav, sec, err = q.get()
            if chunk is None:
                break
            if err is not None:
                vlog.log("合成失败（%s）: %s" % (chunk[:12], err), tag=TAG)
                if played == 0:
                    # 合不出来也别把字吞了：按固定时长显示，让人至少能读到
                    try:
                        self._bubble(text, FALLBACK_MS, False)
                    except Exception:
                        pass
                    return False
                break

            total_sec += sec
            if played == 0:
                dur = max(MIN_MS, int(sec * 1000) + self.lead_ms + TAIL_MS)
                try:
                    self._bubble(text, dur, False)
                    vlog.log(
                        "第一段合成完 %.2fs（用时 %.2fs），气泡已广播，等 %dms 再开口"
                        % (sec, time.time() - t0, self.lead_ms),
                        tag=TAG,
                    )
                except Exception as e:
                    vlog.log("气泡没弹出来: %s" % e, tag=TAG)
                time.sleep(self.lead_ms / 1000.0)
            else:
                # 续段：文本不变，只是把气泡倒计时续到这一段的长度（不插静默）
                try:
                    self._bubble(text, max(MIN_MS, int(sec * 1000) + TAIL_MS), False)
                except Exception:
                    pass

            vlog.log("开口（第 %d/%d 段）" % (played + 1, len(chunks)), tag=TAG)
            ok, why = vaudio.play(wav)
            if not ok:
                vlog.log("播不出来: %s" % why, tag=TAG)
                return False
            played += 1

        vlog.log("播完", tag=TAG)

        # 念完才收气泡 —— 这是「气泡不会提前消失」的唯一保证
        time.sleep(HOLD_AFTER_MS / 1000.0)
        self._clear()
        vlog.log(
            "念完 %.2fs（%d 段，字先到 %.2fs 再开口，共 %.2fs）：%s"
            % (total_sec, played, self.lead_ms / 1000.0, time.time() - t0, text[:24]),
            tag=TAG,
        )
        return True

    @staticmethod
    def read_say(state, pet):
        """从 /state 里摘出这只宠物的说话气泡（没有就是空的 Say）。"""
        say = (((state or {}).get("pets") or {}).get(pet) or {}).get("say") or {}
        data = say.get("data") or {}
        return Say(say.get("counter"), (data.get("text") or "").strip(), data)

    # -- 主循环
    def run(self):
        seen = None
        primed = False
        vlog.log(
            "watching %s poll=%.2fs lead=%dms" % (self.state_url, self.poll, self.lead_ms),
            tag=TAG,
        )
        while True:
            try:
                state = vhttp.get_json(self.state_url, timeout=6)
                say = self.read_say(state, self.pet)
                counter, text, data = say.counter, say.text, say.data
                new_line = bool(counter) and counter != seen
                # 刚起来这一轮只对齐进度：屏幕上的旧台词不再念一遍
                if new_line and primed and text and data.get("anim") is not False:
                    vlog.log("新台词: %r" % text, tag=TAG)
                    self.speak(text)
                # 处理完才推进游标：中途抛错下一轮还会重试，不会漏掉这句话
                if new_line:
                    seen = counter
                primed = True
            except Exception as e:
                vlog.log("轮询失败: %s" % e, tag=TAG)
                # DSH 重启会换 GUI 端口 —— 自己找回来，别等着看门狗发现
                try:
                    fresh = find_gui_port(self.pet)
                except Exception:
                    fresh = 0
                if fresh and fresh != self.port:
                    vlog.log("DSH 端口变了：%d -> %d，改投新端口" % (self.port, fresh), tag=TAG)
                    self.port = fresh
                    self._rebuild_urls()
            time.sleep(self.poll)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=53290, help="DSH GUI 端口（每次启动都会变）")
    ap.add_argument("--pet", default="main")
    ap.add_argument("--tts", type=int, default=TTS_PORT)
    ap.add_argument("--poll", type=float, default=0.4)
    ap.add_argument("--lead", type=int, default=RENDER_LEAD_MS)
    a = ap.parse_args()
    PetVoice(a.port, a.pet, a.tts, a.poll, a.lead).run()


if __name__ == "__main__":
    main()