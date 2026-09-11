"""日本語特化モデル（kotoba-whisper）の置き場所づくり。

🔴 配布されている faster-whisper 版は、config.json の alignment_heads が
   教師（デコーダ32層）のもので、2層しかないデコーダから存在しない層を読みに行って
   Segmentation fault になる（2026-09-11 に実測）。差し替えた置き場所から読む。

ネットには出ない。取り寄せた snapshot に見立てたフォルダで確かめる。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sidecar.asr import faster_whisper_backend as fw  # noqa: E402


class Kotoba(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.snap = self.tmp / "snapshot"
        self.snap.mkdir()
        # 配布物そのままの形（教師の alignment_heads）
        (self.snap / "config.json").write_text(json.dumps({
            "alignment_heads": [[7, 0], [10, 17], [25, 6]],
            "lang_ids": [1, 2, 3],
            "suppress_ids": [4],
        }), encoding="utf-8")
        (self.snap / "model.bin").write_bytes(b"x" * 4096)
        (self.snap / "vocabulary.json").write_text("[]", encoding="utf-8")

    def test_alignment_heads_だけ差し替わる(self):
        dest = fw.prepare_patched_model(self.snap, self.tmp / "dest", fw.KOTOBA_ALIGNMENT_HEADS)
        cfg = json.loads((dest / "config.json").read_text(encoding="utf-8"))
        self.assertEqual(cfg["alignment_heads"], [[1, h] for h in range(20)])
        # 他の項目は残る
        self.assertEqual(cfg["lang_ids"], [1, 2, 3])
        self.assertEqual(cfg["suppress_ids"], [4])

    def test_本体は複製せず共有する(self):
        dest = fw.prepare_patched_model(self.snap, self.tmp / "dest", fw.KOTOBA_ALIGNMENT_HEADS)
        self.assertTrue((dest / "model.bin").exists())
        self.assertTrue((dest / "vocabulary.json").exists())
        # ハードリンクなら inode が同じ。コピーに落ちた環境でも中身は同じ
        a, b = os.stat(self.snap / "model.bin"), os.stat(dest / "model.bin")
        self.assertEqual(a.st_size, b.st_size)
        self.assertEqual((dest / "model.bin").read_bytes(), b"x" * 4096)

    def test_二度目は作り直さない(self):
        dest = fw.prepare_patched_model(self.snap, self.tmp / "dest", fw.KOTOBA_ALIGNMENT_HEADS)
        before = os.stat(dest / "model.bin").st_mtime_ns
        fw.prepare_patched_model(self.snap, self.tmp / "dest", fw.KOTOBA_ALIGNMENT_HEADS)
        self.assertEqual(os.stat(dest / "model.bin").st_mtime_ns, before)

    def test_ふつうのモデルはそのまま通す(self):
        self.assertEqual(fw.resolve_model("large-v3-turbo"), "large-v3-turbo")
        self.assertEqual(fw.resolve_model("base"), "base")

    def test_置き場所はHFのキャッシュの隣(self):
        env = os.environ.copy()
        try:
            os.environ.pop("PAC_MODEL_ROOT", None)
            os.environ["HF_HOME"] = str(self.tmp / "hf")
            self.assertEqual(fw.pac_model_root(), self.tmp / "hf" / "pac-models")
            os.environ["PAC_MODEL_ROOT"] = str(self.tmp / "own")
            self.assertEqual(fw.pac_model_root(), self.tmp / "own")
        finally:
            os.environ.clear()
            os.environ.update(env)


if __name__ == "__main__":
    unittest.main(verbosity=2)
