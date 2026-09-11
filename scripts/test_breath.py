"""息継ぎで割る印（break_after）。

🔴 語の時刻の隙間で見ないこと。
   Whisper の語の時刻は隣と隙間なく繋がるので、息継ぎは時刻に現れない
   （実素材で全語 0.00秒、2026-09-11）。音で「声が止まっていた長さ」を測る。

🔴 「割れること」より「割れてはいけない所で割れないこと」を先に確かめる。
   地の音が大きくて声と分けられない素材では、音からは決めない。
"""

from __future__ import annotations

import math
import struct
import sys
import tempfile
import unittest
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sidecar import telop as pac_telop  # noqa: E402

RATE = 16000


def tone_wav(spans, seconds, floor=0.0, path=None):
    """spans=[(始め, 終わり)] の間だけ声（440Hz）が鳴る wav を作る。floor は地の音の大きさ"""
    import random

    rnd = random.Random(1)
    n = int(seconds * RATE)
    frames = bytearray()
    for i in range(n):
        t = i / RATE
        v = floor * (rnd.random() * 2 - 1)
        if any(a <= t < b for a, b in spans):
            v += 0.5 * math.sin(2 * math.pi * 440 * t)
        frames += struct.pack("<h", int(max(-1, min(1, v)) * 32767))
    path = path or tempfile.mktemp(suffix=".wav")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(bytes(frames))
    return path


def transcript(words):
    """語の並びから、Whisper の返す形（時刻は隣と隙間なし）を作る"""
    return {"segments": [{"src_start": words[0]["src_start"], "src_end": words[-1]["src_end"],
                          "text": "".join(w["text"] for w in words), "words": words}]}


def word(text, a, b, p=0.9):
    return {"text": text, "src_start": a, "src_end": b, "probability": p}


class Breath(unittest.TestCase):
    def units(self, tr, wav=None):
        return pac_telop.build_units(tr, wav_path=wav)["telops"]

    def test_声が止まっていたら印が付く(self):
        # 「今日は」0.0-0.6 で声、0.6-0.95 は息継ぎ、「勉強しよう」0.95-1.8。
        # Whisper の時刻は隙間なく繋がる（今日は 0.0-0.95）
        wav = tone_wav([(0.0, 0.6), (0.95, 1.8)], 2.0)
        tr = transcript([word("今日は", 0.0, 0.95), word("勉強しよう", 0.95, 1.8)])
        ws = self.units(tr, wav)[0]["words"]
        self.assertTrue(ws[0].get("break_after"), ws)
        self.assertFalse(ws[1].get("break_after"), ws)

    def test_止まっていなければ付かない(self):
        wav = tone_wav([(0.0, 1.8)], 2.0)
        tr = transcript([word("今日は", 0.0, 0.95), word("勉強しよう", 0.95, 1.8)])
        ws = self.units(tr, wav)[0]["words"]
        self.assertFalse(any(w.get("break_after") for w in ws), ws)

    def test_短い止まりでも読点があれば付く(self):
        # 0.12秒の止まり。それだけなら付かないが、Whisper が「、」を打っていれば付く
        wav = tone_wav([(0.0, 0.6), (0.72, 1.8)], 2.0)
        なし = transcript([word("今日は", 0.0, 0.72), word("勉強しよう", 0.72, 1.8)])
        あり = transcript([word("今日は、", 0.0, 0.72), word("勉強しよう", 0.72, 1.8)])
        self.assertFalse(self.units(なし, wav)[0]["words"][0].get("break_after"))
        self.assertTrue(self.units(あり, wav)[0]["words"][0].get("break_after"))

    def test_音が無ければ読点だけで決める(self):
        tr = transcript([word("今日は、", 0.0, 0.95), word("勉強しよう", 0.95, 1.8)])
        ws = self.units(tr)[0]["words"]
        self.assertTrue(ws[0].get("break_after"), ws)
        # 本文には「、」を残さない（語の連結 = 本文、の対応を崩さない）
        self.assertEqual(ws[0]["text"], "今日は")

    def test_地の音が大きい素材では音から決めない(self):
        # 声と同じくらいの地の音（波の音）。止まっている所も止まって見えない
        wav = tone_wav([(0.0, 0.6), (0.95, 1.8)], 2.0, floor=0.45)
        tr = transcript([word("今日は", 0.0, 0.95), word("勉強しよう", 0.95, 1.8)])
        ws = self.units(tr, wav)[0]["words"]
        self.assertFalse(any(w.get("break_after") for w in ws), ws)

    def test_時刻に隙間があればそれだけで付く(self):
        # Whisper がはっきり空けた場合（きれいな素材ではこうなる）
        tr = transcript([word("今日は", 0.0, 0.5), word("勉強しよう", 0.9, 1.8)])
        ws = self.units(tr)[0]["words"]
        self.assertTrue(ws[0].get("break_after"), ws)


if __name__ == "__main__":
    unittest.main(verbosity=2)
