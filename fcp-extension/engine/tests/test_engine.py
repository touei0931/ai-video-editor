"""エンジンの検査。モデルも ffmpeg も要らないので Windows でも走る。

PAC 本体の検出ロジック（sidecar/cut.py, sidecar/telop.py）は純粋な Python なので、
作り物の文字起こしを通せば「検出 → パネル用 JSON」まで一気に確かめられる。
"""

from __future__ import annotations

import re
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

from pac_fcp_engine.__main__ import CUT_PRESETS  # noqa: E402

from sidecar import cut as pac_cut  # noqa: E402
from sidecar import telop as pac_telop  # noqa: E402

# fcp-extension/engine/tests -> fcp-extension
EXT_ROOT = Path(__file__).resolve().parents[2]


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



class Test知らないものが来たとき(unittest.TestCase):
    """PAC 本体に新しい種類が増えたら、黙って減らさずに知らせる。

    🔴 これが無いと、増えたことに気づけない。
       通せないもの自体は仕方がないが、**何も言わずに捨てる**と
       「なんとなく候補が少ない」としか見えない。
    """

    def test_知らないカットの種類は理由が残る(self) -> None:
        unknown: list[str] = []
        out = map_cuts(
            [{"id": "x", "src_start": 1.0, "src_end": 2.0, "kind": "新種", "confidence": 0.9}],
            unknown,
        )
        self.assertEqual(out, [])
        self.assertTrue(any("新種" in m for m in unknown), unknown)

    def test_知らない見た目は通常にして理由が残る(self) -> None:
        unknown: list[str] = []
        out = map_telops(
            [{"id": "t", "src_start": 1.0, "src_end": 2.0, "text": "あ", "style": "特大"}],
            unknown,
        )
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["style"], "normal")
        self.assertTrue(any("特大" in m for m in unknown), unknown)

    def test_知っているものでは何も言わない(self) -> None:
        unknown: list[str] = []
        map_cuts([{"id": "x", "src_start": 1.0, "src_end": 2.0, "kind": "filler"}], unknown)
        map_telops(
            [{"id": "t", "src_start": 1.0, "src_end": 2.0, "text": "あ", "style": "emphasis"}],
            unknown,
        )
        self.assertEqual(unknown, [])


class Test間の詰め具合(unittest.TestCase):
    """「カットが2つしかない」を防ぐ。

    🔴 詰め具合をエンジンまで届けること。
       画面 → 拡張 → アプリ → エンジン と4つ跨ぐので、どこか1つ落ちると
       黙って「ふつう」で候補を出す。ショート動画では**候補が数件**しか
       出ず、素材を渡した側からは「カットが効いていない」としか見えない
       （2026-08-31に言われた）。

    🔴 名前は3か所（PAC 本体・エンジン・パネルの画面）で揃えること。
       ずれた名前を送ると PRESETS の引きが空振りし、
       「ふつう」ですらない中途半端な設定になる。
    """

    def test_エンジンとPAC本体で名前が揃っている(self) -> None:
        self.assertEqual(CUT_PRESETS, pac_cut.PRESET_ORDER)

    def test_画面の選択肢とも名前が揃っている(self) -> None:
        text = (EXT_ROOT / "webui" / "src" / "lib" / "types.ts").read_text(encoding="utf-8")
        # 型注釈の "}[]" に引っかからないよう、値の "= [" から先を見る
        block = text.split("export const CUT_PRESETS")[1].split("= [", 1)[1]
        block = block.split(chr(10) + "]")[0]
        names = re.findall(r"name: '([a-z]+)'", block)
        self.assertEqual(names, CUT_PRESETS)

    def test_詰めるほど候補が増える(self) -> None:
        """間の長さをいろいろ混ぜた素材で、詰めるほど候補が増えること。

        🔴 make_transcript() のような「大きな間しかない」素材では確かめられない。
           どの設定でも同じ数になり、通ってしまう。
        """
        words = []
        at = 0.0
        for gap in (0.25, 0.4, 0.6, 0.9, 1.5):
            at += gap
            words.append(word("話", at, at + 0.4))
            at += 0.4
        transcript = {
            "duration": at,
            "segments": [{"id": 0, "text": "話" * len(words), "words": words}],
        }
        counts = {
            name: len(pac_cut.detect_candidates(transcript, {"preset": name})["candidates"])
            for name in CUT_PRESETS
        }
        self.assertGreater(counts["tight"], counts["loose"], counts)

    def test_知らない名前は受け取らない(self) -> None:
        """🔴 黙って既定に戻さないこと。効いていないことに気づけなくなる"""
        from pac_fcp_engine.__main__ import main

        with self.assertRaises(SystemExit):
            main(["--video", "a.mp4", "--out", "b.json", "--cut-preset", "ばりばり"])



class Test独り言がパネルまで届く(unittest.TestCase):
    """🔴 mapping の _KINDS はふるいになっている。

    ここに足し忘れると、PAC 本体が候補を出していても
    パネルには**1件も届かない**。エラーにもならないので、
    「なんとなく出ない」としか見えない。
    """

    def test_独り言が通る(self) -> None:
        unknown: list[str] = []
        out = map_cuts([{
            "id": "a1", "src_start": 36.5, "src_end": 37.6, "kind": "aside",
            "text": "あれ止まってない", "confidence": 0.75,
        }], unknown)
        self.assertEqual(len(out), 1, unknown)
        self.assertEqual(out[0]["kind"], "aside")
        self.assertEqual(out[0]["text"], "あれ止まってない")
        self.assertEqual(out[0]["decision"], "pending")
        self.assertEqual(unknown, [])

    def test_PAC本体が出す種類は全部通る(self) -> None:
        """PAC 本体に種類が増えたら、ここが落ちて気づけるようにする"""
        transcript = make_transcript()
        got = {c["kind"] for c in pac_cut.detect_candidates(transcript)["candidates"]}
        unknown: list[str] = []
        map_cuts([{"id": "x", "src_start": 0.0, "src_end": 1.0, "kind": k} for k in got],
                 unknown)
        self.assertEqual(unknown, [], f"パネルに届かない種類がある: {unknown}")

    def test_設定で切れる(self) -> None:
        from pac_fcp_engine.__main__ import main  # noqa: F401  (引数の形だけ確かめる)
        import argparse
        # 知らない値は受け取らない（黙って既定に戻すと、効いていないことに気づけない）
        with self.assertRaises(SystemExit):
            main(["--video", "a.mp4", "--out", "b.json", "--aside", "たぶん"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
