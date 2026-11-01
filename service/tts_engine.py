# -*- coding: utf-8 -*-
"""TTS 引擎：模型、参考音、合成、播放都收在这一个对象里。

这一层**不知道 HTTP 的存在**，所以可以脱离端口单独测：
    python -c "from tts_engine import TTSEngine; e=TTSEngine(); print(e.synthesize('试试看'))"

为什么要对象：模型加载慢（几十秒）、要占显存、还必须串行 —— 这些都是**状态**，
用一个实例持有比散在模块全局里靠谱；锁也在这里，调用方不用关心线程安全。

目录约定（脚本在 voice\，资源仍在 tts\）见 common\settings.py。
"""
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # 让 `import common` 生效

from common import audio as vaudio
from common import http as vhttp
from common import log as vlog
from common import ports as vports
from common.settings import GUI_PORT_FALLBACK, OUTDIR, REF, REPO
from tts_text import sanitize

PROMPT = "嗯嘿嘿，人家只是平时懒得认真啦"
TAG = "[tts]"


class TTSEngine(object):
    """模型 + 合成 + 播放；对外只暴露「说一句」和「放一个文件」"""

    def __init__(self, repo=REPO, ref=REF, outdir=OUTDIR, prompt=PROMPT):
        self.repo = repo
        self.ref = ref
        self.outdir = outdir
        self.prompt = prompt
        self._tts = None
        self._lock = threading.Lock()        # 合成串行：显存装不下两份
        self._play_lock = threading.Lock()   # 播放串行：winsound 是全局单通道
        self._prepared = False

    # -- 模型 -----------------------------------------------------------
    def _prepare(self):
        """把 GPT-SoVITS 加进 sys.path，并把工作目录切到仓库根。

        切目录不是偷懒：GPT-SoVITS 自己有按相对路径加载的权重
        （`GPT_SoVITS/pretrained_models/sv/pretrained_eres2netv2w24s4ep4.ckpt`），
        不切就 FileNotFoundError。这个进程只跑 TTS，别处用的都是绝对路径，
        所以切在这里是安全的；但**只在真正要用模型时切**，import 期不动别人的 cwd。
        """
        if self._prepared:
            return
        for p in (
            self.repo,
            os.path.join(self.repo, "GPT_SoVITS"),
            os.path.join(self.repo, "GPT_SoVITS", "eres2net"),
        ):
            if p not in sys.path:
                sys.path.insert(0, p)
        os.chdir(self.repo)
        self._prepared = True

    def load(self):
        """加载模型（幂等）"""
        if self._tts is not None:
            return self._tts
        self._prepare()
        from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config

        cfg = {
            "custom": {
                "device": "cuda",
                "is_half": True,
                "version": "v2Pro",
                "t2s_weights_path": os.path.join(self.repo, "GPT_SoVITS", "pretrained_models", "s1v3.ckpt"),
                "vits_weights_path": os.path.join(
                    self.repo, "GPT_SoVITS", "pretrained_models", "v2Pro", "s2Gv2Pro.pth"),
                "bert_base_path": os.path.join(
                    self.repo, "GPT_SoVITS", "pretrained_models", "chinese-roberta-wwm-ext-large"),
                "cnhuhbert_base_path": os.path.join(
                    self.repo, "GPT_SoVITS", "pretrained_models", "chinese-hubert-base"),
            }
        }
        t0 = time.time()
        self._tts = TTS(TTS_Config(cfg))
        vlog.log("model loaded in %.1fs" % (time.time() - t0), tag=TAG)
        return self._tts

    @property
    def loaded(self):
        return self._tts is not None

    # -- 合成 -----------------------------------------------------------
    def synthesize(self, text, speed=1.0):
        """线程安全的「文本 → wav」，返回 (路径, 音频秒数, 合成耗时秒)"""
        with self._lock:
            return self._synth(text, speed)

    def _synth(self, text, speed=1.0):
        import numpy as np

        tts = self.load()
        spoken = sanitize(text)
        if not spoken:
            raise ValueError("没有可念的中文内容（原文只剩标点/英文）")
        speed = max(0.5, min(2.0, float(speed or 1.0)))
        req = {
            "text": spoken, "text_lang": "zh", "ref_audio_path": self.ref, "prompt_text": self.prompt,
            "prompt_lang": "zh", "top_k": 15, "top_p": 1.0, "temperature": 1.0,
            "text_split_method": "cut5", "batch_size": 1, "speed_factor": speed,
            "repetition_penalty": 1.35,
        }
        t0 = time.time()
        frames, sr = [], 32000
        for sr_, audio in tts.run(req):
            sr = sr_
            frames.append(np.asarray(audio).reshape(-1))
        audio = np.concatenate(frames) if frames else np.zeros(1, dtype=np.float32)
        # 模型输出经常峰值 >1，直接 clip 会削波失真（就是"杂音"）→ 先归一化到 -1dBFS
        peak = float(np.max(np.abs(audio))) if audio.size else 0.0
        if peak > 0:
            audio = (audio / peak) * 0.89
        os.makedirs(self.outdir, exist_ok=True)
        out = os.path.join(self.outdir, "say-%d.wav" % int(time.time() * 1000))
        vaudio.write_wav(out, audio, sr)
        return out, len(audio) / float(sr), time.time() - t0

    # -- 播放 -----------------------------------------------------------
    def play_file(self, path):
        """线程安全的播放，返回 (ok, why)。进程内 winsound，不起子进程 → 不闪窗"""
        with self._play_lock:
            return vaudio.play(path, self.outdir)

    def play(self, path):
        """只要成败的薄包装（/speak 的 play 字段用它）"""
        ok, why = self.play_file(path)
        if not ok:
            vlog.log("播放失败: %s" % why, tag="[play]")
        return ok

    # -- 桌宠 -----------------------------------------------------------
    def pet_say(self, text, pet="main"):
        """把一句话塞进桌宠气泡（GUI 端口每次启动都会变，所以现找）"""
        port = vports.find_gui_port(pet) or GUI_PORT_FALLBACK
        url = "http://127.0.0.1:%d/dsh-pet-7340/broadcast?surface=desktop&pet=%s" % (port, pet)
        try:
            return {"ok": True, "resp": vhttp.post_json(url, {"text": text}, timeout=5)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # -- 体检 -----------------------------------------------------------
    def health(self):
        cuda = False
        try:
            import torch

            cuda = bool(torch.cuda.is_available())
        except Exception:
            pass
        return {
            "ok": True,
            "model_loaded": self.loaded,
            "cuda": cuda,
            "ref": self.ref,
            "ref_exists": os.path.exists(self.ref),
            "outdir": self.outdir,
        }
