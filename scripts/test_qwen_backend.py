"""Qwen3-ASR バックエンドの、モデルが要らない部分。

🔴 出力の形は faster-whisper と同じでなければならない。後段（clean / cut / telop）は
   どちらのバックエンドか知らない。
🔴 整列モデルは句読点を語に含めない。Whisper と同じく「ですね、」の形に付け直す
   （telop.py が「、」で息継ぎを、文末記号で文の終わりを見るため）。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sidecar.asr import qwen_backend as qb  # noqa: E402


def item(text, a, b):
    return {"text": text, "src_start": a, "src_end": b}


class Punctuation(unittest.TestCase):
    def test_直前の語に句読点を付け直す(self):
        text = "ええ、今日はですね、このバイクを紹介します。"
        items = [item("ええ", 0, 0.4), item("今日", 0.8, 1.0), item("は", 1.0, 1.1),
                 item("です", 1.1, 1.3), item("ね", 1.3, 1.6), item("この", 2.0, 2.2),
                 item("バイク", 2.2, 2.5), item("を", 2.5, 2.6), item("紹介", 2.6, 3.0),
                 item("し", 3.0, 3.1), item("ます", 3.1, 3.4)]
        out = qb.attach_punctuation(text, items)
        self.assertEqual([w["text"] for w in out],
                         ["ええ、", "今日", "は", "です", "ね、", "この", "バイク", "を", "紹介", "し", "ます。"])
        # 時刻は触らない
        self.assertEqual(out[4]["src_start"], 1.3)

    def test_語が本文に見つからなくても落ちない(self):
        out = qb.attach_punctuation("今日は。", [item("きょう", 0, 1), item("は", 1, 2)])
        self.assertEqual(out[1]["text"], "は。")

    def test_語の連結が本文と一致する(self):
        # 🔴 後段は「語の連結 = 本文」を前提に文字位置から時刻を引く
        text = "はい、一瞬で外れました。"
        items = [item("はい", 0, 0.3), item("一瞬", 0.7, 1.1), item("で", 1.1, 1.2),
                 item("外れ", 1.2, 1.5), item("まし", 1.5, 1.7), item("た", 1.7, 1.9)]
        out = qb.attach_punctuation(text, items)
        self.assertEqual("".join(w["text"] for w in out), text)


class Segments(unittest.TestCase):
    def test_文末と長い間で切る(self):
        words = [item("はい、", 0, 0.3), item("外れました。", 0.7, 1.9),
                 item("この", 2.3, 2.5), item("工具", 2.5, 2.9),
                 item("すごく", 5.0, 5.4), item("おすすめです", 5.4, 6.0)]
        segs = qb.to_segments(words)
        self.assertEqual([s["text"] for s in segs],
                         ["はい、外れました。", "この工具", "すごくおすすめです"])
        self.assertEqual(segs[1]["src_start"], 2.3)
        self.assertEqual(segs[1]["src_end"], 2.9)

    def test_形がfaster_whisperと同じ(self):
        segs = qb.to_segments([item("あ。", 0, 0.5)])
        for key in ("src_start", "src_end", "text", "avg_logprob", "no_speech_prob", "words"):
            self.assertIn(key, segs[0])
        # 落とされない側の値（clean.py は -2.0 以下を落とす）
        self.assertEqual(segs[0]["avg_logprob"], 0.0)


class Chunks(unittest.TestCase):
    def test_短ければ1つ(self):
        import numpy as np

        x = np.zeros(16000 * 30, dtype="float32")
        self.assertEqual(qb.chunk_bounds(x, 16000), [(0, len(x))])

    def test_静かな所で区切る(self):
        import numpy as np

        rate = 16000
        x = np.random.default_rng(0).uniform(-0.3, 0.3, rate * 200).astype("float32")
        # 95 秒の所だけ 1 秒間 無音にしておく
        x[rate * 95: rate * 96] = 0.0
        bounds = qb.chunk_bounds(x, rate, chunk_sec=90.0, search_sec=15.0)
        self.assertEqual(bounds[0][0], 0)
        cut = bounds[0][1] / rate
        self.assertTrue(95.0 <= cut <= 96.0, cut)
        # 隙間なく繋がっている
        for (a, b), (c, d) in zip(bounds, bounds[1:]):
            self.assertEqual(b, c)
        self.assertEqual(bounds[-1][1], len(x))

    def test_名前の判定(self):
        self.assertTrue(qb.is_qwen_model("qwen3-asr-1.7b"))
        self.assertFalse(qb.is_qwen_model("large-v3-turbo"))


if __name__ == "__main__":
    unittest.main(verbosity=1)
