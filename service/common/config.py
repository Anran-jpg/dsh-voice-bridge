# -*- coding: utf-8 -*-
"""配置对象：默认值打底，JSON 文件覆盖。

为什么不用裸 dict：
  - `cfg["asr_model"]` 这种写法只要配置少一项就 KeyError（之前就是这么炸的）
  - 默认值散在各处，读代码的人不知道「没配的时候是什么」
所以：默认值集中声明，读取一律 `cfg.get(键, 兜底)`，文件坏了就退回默认值。
"""
import json
import os


class Config(object):
    def __init__(self, path, defaults=None):
        self.path = path
        self.defaults = dict(defaults or {})
        self.data = dict(self.defaults)
        self.reload()

    def reload(self):
        """重新读文件（文件不存在 / 不是 JSON / 顶层不是对象 → 保持默认值）"""
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                raw = json.load(f)
        except Exception:
            self.data = dict(self.defaults)
            return self.data
        if isinstance(raw, dict):
            self.data = dict(self.defaults)
            self.data.update(raw)
        return self.data

    def get(self, key, default=None):
        value = self.data.get(key, self.defaults.get(key, default))
        return default if value is None else value

    def set(self, key, value):
        self.data[key] = value

    def save(self):
        os.makedirs(os.path.dirname(os.path.abspath(self.path)) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self.path)
