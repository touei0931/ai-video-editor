"""固めたバイナリに、使うものが全部入るかを検める。

🔴 これが抜けると「動くのに一部だけ効かない」形で現れる。

   PyInstaller は import を静的に辿るが、`repo.py` が実行時に sys.path を
   足してから import している sidecar は辿れない。だから spec の
   hiddenimports に手で並べている。並べ忘れると、そのモジュールだけ
   バイナリに入らず、実行時の import が失敗する。

   受け側が try/except で握りつぶしていると**誰も気づけない**。
   実際、sidecar.media（動画の大きさを調べる部分）が入っておらず、
   書き出しのプロジェクトが 1920x1080 に倒れ続けていた（2026-08-31）。
   縦4Kの素材が横向きの枠に小さく置かれる、という形でしか現れなかった。
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "packaging" / "engine.spec"
SOURCES = sorted((ROOT / "pac_fcp_engine").glob("*.py"))


def spec_hidden_imports() -> set[str]:
    text = SPEC.read_text(encoding="utf-8")
    return set(re.findall(r'"([A-Za-z_][A-Za-z0-9_.]*)"', text))


def imported_sidecar_modules() -> set[str]:
    """エンジンが読んでいる sidecar のモジュール名を集める。

    `from sidecar import cut as pac_cut` と
    `from sidecar.media import probe_video_info` の両方を拾う。
    """
    found: set[str] = set()
    for path in SOURCES:
        text = path.read_text(encoding="utf-8")
        for name in re.findall(r"from sidecar import ([A-Za-z_][A-Za-z0-9_]*)", text):
            found.add(f"sidecar.{name}")
        for name in re.findall(r"from sidecar\.([A-Za-z0-9_.]+) import", text):
            found.add(f"sidecar.{name}")
        for name in re.findall(r"import sidecar\.([A-Za-z0-9_.]+)", text):
            found.add(f"sidecar.{name}")
    return found


class 同梱漏れがないこと(unittest.TestCase):

    def test_読んでいる_sidecar_は全部_spec_に並んでいる(self):
        used = imported_sidecar_modules()
        listed = spec_hidden_imports()
        missing = sorted(m for m in used if m not in listed)
        self.assertEqual(
            missing,
            [],
            "spec の hiddenimports に足りません（固めると読み込みに失敗します）: "
            + ", ".join(missing),
        )

    def test_動画の大きさを調べるものが入っている(self):
        """🔴 これが抜けると書き出しが 1920x1080 に倒れる（実際に倒れた）"""
        self.assertIn("sidecar.media", spec_hidden_imports())

    def test_エンジン自身のモジュールも並んでいる(self):
        listed = spec_hidden_imports()
        for name in ("pac_fcp_engine.analyze", "pac_fcp_engine.mapping"):
            self.assertIn(name, listed)


class 失敗を握りつぶさないこと(unittest.TestCase):

    def test_大きさが取れない理由を持ち帰る(self):
        """🔴 黙って既定値に倒れると、同梱漏れに誰も気づけない"""
        text = (ROOT / "pac_fcp_engine" / "analyze.py").read_text(encoding="utf-8")
        self.assertIn("videoInfoError", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
