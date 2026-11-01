# -*- coding: utf-8 -*-
"""把「写给人看的文本」改成「念出来不别扭的中文」。

这层只做字符串：不碰模型、不碰网络、不碰文件，所以能单独测
（`E:\DSH_Work\tts\_test_sanitize.py` 就是拿它当被测对象）。

为什么是函数而不是类：全是纯函数，输入字符串输出字符串，没有状态也没有依赖，
做成类只是给每次调用多塞一个 self。要加新规则就往这里加一个纯函数。
"""
import re
_ASCII_WORD = re.compile(r"[A-Za-z][A-Za-z0-9_]*")
_MD_SYMBOLS = re.compile(r"[*_`#>\[\]()~|]")
_NUM = re.compile(r"\d+(?:\.\d+)?")

_DIGITS = "零一二三四五六七八九"
_UNITS = ["", "十", "百", "千"]
_BIG = ["", "万", "亿", "万亿"]


# ---------------------------------------------------------------- 中文读法
def _num4(n):
    """0-9999 → 中文（不带前导零）"""
    s = ""
    zero = False
    for i in (3, 2, 1, 0):
        d = (n // (10 ** i)) % 10
        if d == 0:
            if s:
                zero = True
            continue
        if zero:
            s += "零"
            zero = False
        s += _DIGITS[d] + _UNITS[i]
    return s


def num2cn(n):
    """整数 → 中文读法；13 → 十三，105 → 一百零五，12345 → 一万二千三百四十五"""
    if n == 0:
        return "零"
    if n < 0:
        return "负" + num2cn(-n)
    groups = []
    while n > 0:
        groups.append(n % 10000)
        n //= 10000
    out = ""
    pending_zero = False
    for i in range(len(groups) - 1, -1, -1):
        g = groups[i]
        if g == 0:
            if out:
                pending_zero = True
            continue
        if out and (pending_zero or g < 1000):
            out += "零"
        pending_zero = False
        out += _num4(g) + _BIG[i]
    if out.startswith("一十"):
        out = out[1:]
    return out


def _num2cn_any(s):
    """'87.5' → 八十七点五（小数部分逐位念）"""
    s = str(s)
    if "." in s:
        a, b = s.split(".", 1)
        return num2cn(int(a)) + "点" + "".join(_DIGITS[int(c)] for c in b if c.isdigit())
    return num2cn(int(s))


def read_numbers(text):
    """把数字读成中文：2026-10-30 → 二零二六年十月三十日；87.5% → 百分之八十七点五"""

    def _date(m):
        year = "".join(_DIGITS[int(c)] for c in m.group(1))
        return "%s年%s月%s日" % (year, num2cn(int(m.group(2))), num2cn(int(m.group(3))))

    text = re.sub(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", _date, text)
    text = re.sub(
        r"(\d{1,2}):(\d{2})",
        lambda m: "%s点%s分" % (num2cn(int(m.group(1))), num2cn(int(m.group(2)))),
        text,
    )
    # 百分号：原来拿 re.match 去套子串再喂给 _num2cn_any，绕了一圈还容易漏；直接取值即可
    text = re.sub(r"(\d+(?:\.\d+)?)\s*%", lambda m: "百分之" + _num2cn_any(m.group(1)), text)
    return _NUM.sub(lambda m: _num2cn_any(m.group(0)), text)


# 少数常用英文，换成中文说法或谐音（模型是中文音色，念英文会崩）
_EN_WORDS = {
    "token": "偷肯", "tokens": "偷肯", "ds": "滴艾斯", "dsh": "滴艾斯欸区", "api": "诶皮艾",
    "ok": "欧克", "okay": "欧克", "ai": "诶艾", "gpu": "鸡屁优", "cpu": "西屁优",
    "pc": "皮西", "app": "诶皮皮", "bug": "八哥", "log": "老哥", "web": "韦布",
    "github": "吉特哈布", "v2pro": "微二普罗", "f8": "艾福八", "tts": "提提艾斯",
}


def sanitize(text):
    """模型是中文音色：英文按表换说法（换不了的去掉），数字转中文读法，再清 markdown 记号。"""
    t = _MD_SYMBOLS.sub(" ", text or "")
    t = re.sub(r"```.*?```", " ", t, flags=re.S)

    def _word(m):
        w = m.group(0).lower()
        if w in _EN_WORDS:
            return " " + _EN_WORDS[w] + " "
        return " "  # 念不了的英文：整词去掉，但留一个停顿

    # 先换英文再转数字：F8 要整体查表，别被拆成 F + 8
    t = _ASCII_WORD.sub(_word, t)
    t = read_numbers(t)
    t = re.sub(r"[A-Za-z]+", " ", t)
    return re.sub(r"\s+", " ", t).strip(" ，。、,.!?；;:：")
