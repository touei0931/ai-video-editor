"""独り言・話が逸れた所の検出。

🔴 ここは間違えると**話の中身を消す**。
   「見つかること」より「本編を巻き込まないこと」を先に確かめる。

🔴 作り物の短い文で済ませないこと。
   実機で出た文（脱毛の解説と、末尾の「あれ止まってない」）を通す。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sidecar import cut as pac_cut  # noqa: E402


def words(pairs, start=0.0, per=0.35, gap_before=0.0):
    """(語, 語, ...) を等間隔に並べる。gap_before で直前の間を作る"""
    out = []
    at = start + gap_before
    for text in pairs:
        out.append({"text": text, "src_start": round(at, 3),
                    "src_end": round(at + per, 3), "probability": 0.9})
        at += per
    return out


def transcript(*chunks):
    """(語の並び, 直前の間) をつなげて文字起こしを作る"""
    all_words = []
    at = 0.0
    for texts, gap in chunks:
        ws = words(texts, start=at, gap_before=gap)
        all_words.extend(ws)
        at = ws[-1]["src_end"]
    return {"duration": at + 0.5,
            "segments": [{"id": 0, "text": "", "words": all_words}]}


def kinds_of(result, kind):
    return [c for c in result["candidates"] if c["kind"] == kind]


# 実機の素材に近い形。脱毛の話が続いたあと、最後に撮影のひとりごと
本編 = [
    (["鏡", "って", "正面", "から", "しか", "見え", "ない"], 0.0),
    (["他人", "が", "見る", "の", "は", "横顔", "の", "ヒゲ"], 0.5),
    (["ヒゲ", "の", "脱毛", "を", "考え", "て", "も", "いい", "かも"], 0.5),
]
独り言 = (["あれ", "止まって", "ない"], 1.6)


class 独り言を見つける(unittest.TestCase):

    def setUp(self):
        self.result = pac_cut.detect_candidates(transcript(*本編, 独り言))
        self.asides = kinds_of(self.result, "aside")

    def test_末尾のひとりごとを拾う(self):
        self.assertEqual(len(self.asides), 1, self.asides)
        self.assertIn("止まって", self.asides[0]["word"])

    def test_本編は巻き込まない(self):
        """🔴 これが本題。話の中身を消したら機能ごと有害になる"""
        for c in self.asides:
            self.assertNotIn("脱毛", c["word"], c)
            self.assertNotIn("鏡", c["word"], c)

    def test_必ず人が見る側に入る(self):
        """🔴 意味を読んでいるわけではないので、黙って切らせない"""
        band = self.result["review_band"]
        for c in self.asides:
            self.assertLess(c["confidence"], band["high"], c)
            self.assertGreaterEqual(c["confidence"], band["low"], c)
            self.assertTrue(pac_cut.needs_review(c, band), c)

    def test_理由が残る(self):
        """なぜそう判断したかを画面に出せること"""
        self.assertIn("reason", self.asides[0])
        self.assertIn("isolation", self.asides[0]["reason"])


class 話が繋がっていれば触らない(unittest.TestCase):

    def test_同じ話題の短い相槌は候補にしない(self):
        # 「ヒゲね」は短くて孤立しているが、前後と同じ語を使っている
        t = transcript(
            (["他人", "が", "見る", "の", "は", "ヒゲ"], 0.0),
            (["ヒゲ", "ね"], 1.5),
            (["ヒゲ", "の", "脱毛", "を", "考える"], 1.5),
        )
        asides = kinds_of(pac_cut.detect_candidates(t), "aside")
        self.assertEqual(asides, [], asides)

    def test_長く喋っていれば話の一部(self):
        t = transcript(
            (["鏡", "は", "正面"], 0.0),
            (["まったく", "関係", "ない", "話", "を", "延々", "と", "続け",
              "て", "いる", "けれど", "これ", "は", "本編", "な", "の", "です"], 2.0),
            (["鏡", "は", "正面"], 2.0),
        )
        asides = kinds_of(pac_cut.detect_candidates(t), "aside")
        self.assertEqual(asides, [], asides)

    def test_切ると決めていない(self):
        for c in pac_cut.detect_candidates(transcript(*本編, 独り言))["candidates"]:
            self.assertNotIn("decision", c)


class 設定で変えられる(unittest.TestCase):

    def test_切ることもできる(self):
        t = transcript(*本編, 独り言)
        off = pac_cut.detect_candidates(t, {"detect_aside": False})
        self.assertEqual(kinds_of(off, "aside"), [])

    def test_詰めるほど拾う(self):
        t = transcript(*本編, 独り言)
        counts = {
            name: len(kinds_of(pac_cut.detect_candidates(t, {"preset": name}), "aside"))
            for name in pac_cut.PRESET_ORDER
        }
        self.assertGreaterEqual(counts["tight"], counts["loose"], counts)


class 内容語の取り出し(unittest.TestCase):

    def test_漢字とカタカナを拾う(self):
        got = pac_cut._content_tokens("ヒゲの脱毛を考える")
        self.assertIn("脱毛", got)
        self.assertIn("ヒゲ", got)

    def test_ひらがなだけの語は拾わない(self):
        """助詞・助動詞は話題を表さない。拾うと何でも繋がって見える"""
        self.assertEqual(pac_cut._content_tokens("それはそうなのですが"), set())

    def test_空でも落ちない(self):
        self.assertEqual(pac_cut._content_tokens(""), set())


class 実機の素材で確かめる(unittest.TestCase):
    """友達が書き出した PAC.fcpxml から起こした、本物の並び。

    🔴 作り物だけで済ませないこと。本編が「脱毛の解説」で、
       末尾に「あれ止まってない」（撮影のひとりごと）が入っている。
       この形でこそ、拾うべきものと触ってはいけないものが分かれる。
    """

    # (本文, 開始秒, 終了秒)。fcpxml の title の offset / duration そのもの
    実データ = [
        ("自分の見た目って実は", 2.967, 5.033),
        ("一番自分が", 5.033, 6.333),
        ("分かってないのよ", 6.333, 7.267),
        ("鏡って正面からしかも", 8.133, 10.067),
        ("見た目整えた状態で", 10.067, 11.700),
        ("見るじゃんでも他人が", 11.733, 13.533),
        ("見るのは夕方のヒゲ", 13.533, 15.100),
        ("横顔近い距離自分では", 15.167, 17.800),
        ("見慣れた青ヒゲも", 17.800, 19.033),
        ("他人からは意外と", 19.033, 20.600),
        ("目立ちます周りから", 20.633, 22.267),
        ("ヒゲを出席", 22.267, 23.167),
        ("されたことある人一度", 23.167, 25.000),
        ("脱毛を考えても", 25.033, 26.600),
        ("いいかも", 26.600, 27.667),
        ("肌や", 28.933, 29.633),
        ("もうちょっとでも", 30.000, 30.833),
        ("あれ止まってない", 36.533, 37.633),
    ]

    def setUp(self):
        ws = []
        for text, start, end in self.実データ:
            # 1枚を等間隔の語に割る（語ごとの時刻は fcpxml に残っていないため）
            n = len(text)
            step = (end - start) / n
            for i, ch in enumerate(text):
                ws.append({"text": ch,
                           "src_start": round(start + i * step, 3),
                           "src_end": round(start + (i + 1) * step, 3),
                           "probability": 0.9})
        t = {"duration": 37.6, "segments": [{"id": 0, "text": "", "words": ws}]}
        self.result = pac_cut.detect_candidates(t)
        self.asides = kinds_of(self.result, "aside")

    def test_末尾の撮影のひとりごとを拾う(self):
        got = "".join(c["word"] for c in self.asides)
        self.assertIn("止まってない", got, [c["word"] for c in self.asides])

    def test_本編の解説を巻き込まない(self):
        """🔴 これが本題。1件でも本編に触れたら、この機能は有害"""
        for c in self.asides:
            for 本編語 in ("脱毛", "青ヒゲ", "横顔", "鏡", "他人"):
                self.assertNotIn(本編語, c["word"], f"本編を拾った: {c}")

    def test_拾いすぎない(self):
        """18枚のうち何件も挙がるようなら、それはただの誤検出"""
        self.assertLessEqual(len(self.asides), 3,
                             [c["word"] for c in self.asides])

    def test_全部レビュー行き(self):
        band = self.result["review_band"]
        for c in self.asides:
            self.assertTrue(pac_cut.needs_review(c, band), c)


if __name__ == "__main__":
    unittest.main(verbosity=2)
