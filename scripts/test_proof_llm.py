"""ローカル LLM の見直し（sidecar/proof_llm.py）の、モデルが要らない部分。

🔴 ここで守りたいのは**検算**。小さいモデルは、頼んでいない書き直しを返す。
   - 「前」が本文に無い候補を通すと、画面に出しても置換できない
   - 長い言い換えを通すと、台詞そのものが別物になる（発言の引用なのに）
   - 同じ候補が何度も出る

🔴 本文は書き換えない。候補を返すだけ（人が選ぶ）。

実行: python scripts/test_proof_llm.py
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sidecar.proof_llm import (  # noqa: E402
    MAX_PER_TELOP,
    Proofreader,
    build_messages,
    parse_reply,
    validate,
)


class 返事の読み取り(unittest.TestCase):
    def test_素のJSON(self):
        out = parse_reply('{"直し":[{"前":"オロライブ","後":"ホロライブ","理由":"団体名"}]}')
        self.assertEqual(out, [{"before": "オロライブ", "after": "ホロライブ", "reason": "団体名"}])

    def test_コードブロックに囲まれていても読める(self):
        text = '説明します。\n```json\n{"直し":[{"前":"あ","後":"い","理由":"x"}]}\n```\nどうぞ'
        self.assertEqual(len(parse_reply(text)), 1)

    def test_英語のキーでも読める(self):
        out = parse_reply('{"fixes":[{"before":"a","after":"b","reason":"c"}]}')
        self.assertEqual(out[0]["before"], "a")

    def test_壊れた返事でも落ちない(self):
        for bad in ("", "直せません", "{", '{"直し":"文字列"}', '{"直し":[1,2]}'):
            self.assertEqual(parse_reply(bad), [])

    def test_直す所が無ければ空(self):
        self.assertEqual(parse_reply('{"直し":[]}'), [])


class 検算(unittest.TestCase):
    TEXT = "ではオロライブポケモンユナイト世界対抗戦は"

    def test_本文にある語だけ通す(self):
        ok = validate([{"before": "オロライブ", "after": "ホロライブ", "reason": ""}], self.TEXT)
        self.assertEqual(len(ok), 1)
        # 🔴 本文に無い語は捨てる（画面に出しても置換できない）
        ng = validate([{"before": "ホロライヴ", "after": "ホロライブ", "reason": ""}], self.TEXT)
        self.assertEqual(ng, [])

    def test_同じ語への置き換えは捨てる(self):
        self.assertEqual(validate([{"before": "では", "after": "では", "reason": ""}], self.TEXT), [])

    def test_長い言い換えは捨てる(self):
        # 🔴 台詞の作り直しは受けない
        long_before = self.TEXT
        self.assertEqual(
            validate([{"before": long_before, "after": "別の台詞に書き換えました", "reason": ""}], self.TEXT),
            [],
        )

    def test_同じ候補は1つにする(self):
        same = [{"before": "オロライブ", "after": "ホロライブ", "reason": "a"}] * 3
        self.assertEqual(len(validate(same, self.TEXT)), 1)

    def test_1枚あたりの上限(self):
        text = "あいうえおかきくけこ"
        many = [{"before": c, "after": c + "!", "reason": ""} for c in "あいうえおかきくけこ"]
        self.assertEqual(len(validate(many, text)), MAX_PER_TELOP)


class 頼み方(unittest.TestCase):
    def test_前後の会話と名前を入れる(self):
        m = build_messages("母はい!", ["はいはいはい", "まばたきしないからね"], ["母はいはい!"], ["ホロライブ"])
        user = m[1]["content"]
        self.assertIn("直前の会話", user)
        self.assertIn("直後の会話", user)
        self.assertIn("ホロライブ", user)
        self.assertIn("母はい!", user)
        self.assertIn("JSON", m[0]["content"])

    def test_前後が無くても組める(self):
        m = build_messages("ひとつだけ", [], [], None)
        self.assertIn("見直す文", m[1]["content"])


class 動かす側(unittest.TestCase):
    def test_知らないengineは断る(self):
        with self.assertRaises(ValueError):
            Proofreader("gpt")

    def test_何が足りないかを言う(self):
        self.assertIsInstance(Proofreader("ollama").describe(), str)

    def test_モデルが無くても理由を返す(self):
        """🔴 画面は返事を待っている。落ちると沈黙になる。"""

        class 壊れた(Proofreader):
            def ask(self, messages):  # noqa: ANN001, ANN201
                raise ValueError("モデルがありません")

        r = 壊れた("mlx").review([{"id": "t1", "text": "あいうえお"}])
        self.assertIn("error", r)
        self.assertEqual(r["candidates"], [])

    def test_候補を集めてidを付ける(self):
        class 偽物(Proofreader):
            def ask(self, messages):  # noqa: ANN001, ANN201
                return '{"直し":[{"前":"オロライブ","後":"ホロライブ","理由":"団体名"}]}'

        telops = [
            {"id": "t1", "text": "ではオロライブの大会です"},
            {"id": "t2", "text": "よろしくおねがいします"},
        ]
        r = 偽物("mlx").review(telops)
        self.assertEqual(r["checked"], 2)
        self.assertEqual([c["id"] for c in r["candidates"]], ["t1"])
        # 🔴 本文は書き換えない
        self.assertEqual(telops[0]["text"], "ではオロライブの大会です")

    def test_印が付いた所だけ見直せる(self):
        見た: list[str] = []

        class 記録(Proofreader):
            def ask(self, messages):  # noqa: ANN001, ANN201
                見た.append(messages[1]["content"])
                return '{"直し":[]}'

        telops = [{"id": "t1", "text": "あいうえお"}, {"id": "t2", "text": "かきくけこ"}]
        r = 記録("mlx").review(telops, only_ids=["t2"])
        self.assertEqual(r["checked"], 1)
        self.assertIn("かきくけこ", 見た[0])

    def test_途中で止められる(self):
        class 偽物(Proofreader):
            def ask(self, messages):  # noqa: ANN001, ANN201
                return '{"直し":[]}'

        r = 偽物("mlx").review(
            [{"id": f"t{i}", "text": "あいうえお"} for i in range(5)],
            is_cancelled=lambda: True,
        )
        self.assertTrue(r["cancelled"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
