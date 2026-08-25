"""エンジンの検査。モデルも ffmpeg も要らないので Windows でも走る。

PAC 本体の検出ロジック（sidecar/cut.py, sidecar/telop.py）は純粋な Python なので、
作り物の文字起こしを通せば「検出 → パネル用 JSON」まで一気に確かめられる。
"""

from __future__ import annotations

import sys
import unittest
from array import array
from pathlib import Path

# fcp-extension/engine を import できるようにする
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pac_fcp_engine import repo  # noqa: E402,F401  (sidecar への道を通す)
from pac_fcp_engine.mapping import (  # noqa: E402
    cut_text_from_transcript,
    map_cuts,
    map_telops,
    project_state,
)
from pac_fcp_engine.waveform import peaks_from_samples  # noqa: E402

from sidecar import cut as pac_cut  # noqa: E402
from sidecar import telop as pac_telop  # noqa: E402


def word(text: str, start: float, end: float, prob: float = 0.9) -> dict:
    return {"text": text, "src_start": start, "src_end": end, "probability": prob}


def make_transcript() -> dict:
    """喋り → 長い無音 → フィラー → 言い直し、が入った素材を作る。"""
    words = [
        word("今日", 0.0, 0.4), word("は", 0.4, 0.6),
        word("自動", 0.6, 1.0), word("カット", 1.0, 1.4),
        word("の", 1.4, 1.6), word("話", 1.6, 2.0),
        word("です", 2.0, 2.4),
        # ここで 1.5 秒の無音
        word("えー", 3.9, 4.3),
        word("これ", 4.4, 4.8), word("は", 4.8, 5.0),
        word("これ", 5.1, 5.5), word("は", 5.5, 5.7),   # 言い直し
        word("すごい", 5.8, 6.4), word("です", 6.4, 6.8),
        word("！", 6.8, 6.9),
    ]
    return {"duration": 8.0, "segments": [{"id": 0, "start": 0.0, "end": 8.0, "words": words}]}


class TestDetection(unittest.TestCase):
    def setUp(self) -> None:
        self.transcript = make_transcript()
        analysis = pac_cut.detect_candidates(self.transcript)
        self.candidates = cut_text_from_transcript(list(analysis["candidates"]), self.transcript)
        self.cuts = map_cuts(self.candidates)

    def test_三種類とも検出できる(self) -> None:
        kinds = {c["kind"] for c in self.cuts}
        self.assertIn("silence", kinds, f"無音が出ていない: {self.cuts}")
        self.assertIn("filler", kinds, f"フィラーが出ていない: {self.cuts}")
        self.assertIn("restate", kinds, f"言い直しが出ていない: {self.cuts}")

    def test_勝手に切らない(self) -> None:
        # 判断は必ず人間。既定で approved になっていたら事故になる
        for c in self.cuts:
            self.assertEqual(c["decision"], "pending")

    def test_時刻が並んでいて正しい向き(self) -> None:
        starts = [c["start"] for c in self.cuts]
        self.assertEqual(starts, sorted(starts))
        for c in self.cuts:
            self.assertLess(c["start"], c["end"])

    def test_フィラーには文字が入る(self) -> None:
        fillers = [c for c in self.cuts if c["kind"] == "filler"]
        self.assertTrue(fillers)
        self.assertTrue(all(f["text"] for f in fillers), f"文字が空: {fillers}")

    def test_無音には文字を出さない(self) -> None:
        # 無音区間に文字を出すと「何を切るのか」が誤解される
        for c in self.cuts:
            if c["kind"] == "silence":
                self.assertEqual(c["text"], "")

    def test_確信度は0から1(self) -> None:
        for c in self.cuts:
            self.assertGreaterEqual(c["confidence"], 0.0)
            self.assertLessEqual(c["confidence"], 1.0)


class TestTelops(unittest.TestCase):
    def setUp(self) -> None:
        units = pac_telop.build_units(make_transcript())
        self.telops = map_telops(units["telops"])

    def test_テロップができる(self) -> None:
        self.assertTrue(self.telops)

    def test_スタイルは通常か強調の2種類だけ(self) -> None:
        # パネルのテンプレートは2種類しか持たない。note が漏れると Swift 側で落ちる
        for t in self.telops:
            self.assertIn(t["style"], ("normal", "emphasis"), t)

    def test_感嘆符は強調になる(self) -> None:
        self.assertTrue(
            any(t["style"] == "emphasis" for t in self.telops),
            f"「！」があるのに強調が無い: {self.telops}",
        )

    def test_空のテロップは捨てる(self) -> None:
        for t in self.telops:
            self.assertTrue(t["text"].strip())

    def test_時刻が正しい向き(self) -> None:
        for t in self.telops:
            self.assertLess(t["start"], t["end"])


class TestWaveform(unittest.TestCase):
    def test_無音と発話が見分けられる(self) -> None:
        samples = array("h", [0] * 1000 + [20000] * 1000)
        peaks = peaks_from_samples(samples, points=10)
        self.assertEqual(len(peaks), 10)
        self.assertLess(peaks[0], 0.1)
        self.assertGreater(peaks[-1], 0.5)

    def test_空でも落ちない(self) -> None:
        self.assertEqual(peaks_from_samples(array("h", []), points=10), [])


class TestProjectState(unittest.TestCase):
    def test_パネルが読む形になっている(self) -> None:
        state = project_state(12.5, [0.1, 0.9], [], [], media_path="/tmp/a.mp4")
        self.assertEqual(
            set(state), {"videoUrl", "durationSec", "waveform", "cuts", "telops"}
        )
        self.assertEqual(state["durationSec"], 12.5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
