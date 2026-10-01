"""話者（喋っている人）の操作を、エンジンの入口から通す検査。

🔴 モデルも sherpa-onnx も要らない所だけを見る。
   声を実際に見比べる所は PAC 本体の検査（scripts/test_speakers.py）が持っている。
   ここで見たいのは**配管**:
   - `--speakers` に JSON ファイルを渡すと、結果が JSON ファイルで返ること
   - 失敗しても落ちずに、理由が中身の error に入って返ること
     （パネルに「見分けられません」の一言しか出ないと、手が打てない）

実行: python fcp-extension/engine/tests/test_speakers_cli.py
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from pac_fcp_engine.__main__ import main  # noqa: E402
from pac_fcp_engine.speakers import run  # noqa: E402


class 入口(unittest.TestCase):

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="pac-spk-")
        self.dir = Path(self.tmp.name)
        self.profiles = str(self.dir / "speakers.json")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _run_cli(self, params: dict) -> dict:
        params_path = self.dir / "params.json"
        out_path = self.dir / "result.json"
        params_path.write_text(json.dumps(params, ensure_ascii=False), encoding="utf-8")
        code = main(["--speakers", str(params_path), "--out", str(out_path)])
        self.assertEqual(code, 0, "入口そのものは落ちないこと")
        return json.loads(out_path.read_text(encoding="utf-8"))

    def test_登録がまだ無ければ空で返る(self) -> None:
        out = self._run_cli({"op": "list", "profiles_path": self.profiles})
        self.assertEqual(out.get("speakers"), [])
        # 部品の有無は必ず持ち帰る（同梱漏れを画面から辿れるように）
        self.assertIn("backend", out)

    def test_名前と色を覚えて読み直せる(self) -> None:
        # 声を伴わない登録（名前と色だけ）はモデルが無くても通る
        out = self._run_cli({
            "op": "enroll", "profiles_path": self.profiles,
            "name": "フブキ", "color": "#7ec8ff", "ranges": [],
        })
        self.assertEqual(out["speaker"]["name"], "フブキ")
        self.assertEqual(out["speaker"]["color"], "#7ec8ff")
        again = self._run_cli({"op": "list", "profiles_path": self.profiles})
        self.assertEqual([s["name"] for s in again["speakers"]], ["フブキ"])

    def test_色だけ変えられる(self) -> None:
        made = self._run_cli({
            "op": "enroll", "profiles_path": self.profiles, "name": "おかゆ", "ranges": [],
        })
        sid = made["speaker"]["id"]
        out = self._run_cli({
            "op": "update", "profiles_path": self.profiles, "id": sid, "color": "#c59bff",
        })
        self.assertEqual(out["speakers"][0]["color"], "#c59bff")

    def test_消せる(self) -> None:
        made = self._run_cli({
            "op": "enroll", "profiles_path": self.profiles, "name": "ラミィ", "ranges": [],
        })
        out = self._run_cli({
            "op": "delete", "profiles_path": self.profiles, "id": made["speaker"]["id"],
        })
        self.assertEqual(out["speakers"], [])

    def test_知らない操作は理由を返す(self) -> None:
        out = self._run_cli({"op": "なにこれ", "profiles_path": self.profiles})
        self.assertIn("error", out)
        self.assertIn("なにこれ", out["error"])

    def test_音が無ければ理由を返す(self) -> None:
        # 🔴 落ちないこと。パネルは返事を待っているので、落ちると沈黙になる
        out = run({
            "op": "identify", "profiles_path": self.profiles,
            "wav_path": str(self.dir / "ない.wav"),
            "units": [{"id": "t1", "src_start": 0.0, "src_end": 2.0}],
        })
        self.assertIn("error", out)

    def test_profiles_path_を忘れたら理由を返す(self) -> None:
        out = run({"op": "list"})
        self.assertIn("error", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
