#!/usr/bin/env python3
"""テロップ用フォントを assets/fonts/ に用意する（Phase 0 T1）。

🔴 「商用利用可」と「アプリ同梱可（再配布可）」は別物（§13.4）。
   ここで使うのは **SIL Open Font License 1.1** のものだけ。OFL は再配布・同梱を明示的に許可している。
   モリサワ等の商用フォントは同梱不可なので絶対に混ぜないこと。

    $ python scripts/fetch_fonts.py
"""

from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _console import enable_utf8  # noqa: E402

enable_utf8()

ROOT = Path(__file__).resolve().parent.parent
FONT_DIR = ROOT / "assets" / "fonts"

GOOGLE_FONTS = "https://raw.githubusercontent.com/google/fonts/main"

# (用途, ファイル名, google/fonts 上のパス)
FONTS = [
    ("通常テロップ", "ZenKakuGothicNew-Black.ttf", "ofl/zenkakugothicnew/ZenKakuGothicNew-Black.ttf"),
    ("強調・怒り", "DelaGothicOne-Regular.ttf", "ofl/delagothicone/DelaGothicOne-Regular.ttf"),
    ("補足（明朝）", "ZenOldMincho-Bold.ttf", "ofl/zenoldmincho/ZenOldMincho-Bold.ttf"),
]


def main() -> int:
    FONT_DIR.mkdir(parents=True, exist_ok=True)
    failures: list[str] = []

    for purpose, filename, path in FONTS:
        dest = FONT_DIR / filename
        if dest.exists():
            print(f"  = {filename}（既にあります）")
            continue

        url = f"{GOOGLE_FONTS}/{path}"
        try:
            with urllib.request.urlopen(url) as res, dest.open("wb") as f:
                f.write(res.read())
            print(f"  ✓ {purpose}: {filename} ({dest.stat().st_size / 1024:.0f} KB)")
        except Exception as e:  # noqa: BLE001
            failures.append(f"{filename}: {e}")
            print(f"  ✗ {purpose}: {filename} — {e}")

    # ライセンス表示は配布時に必須（OFL の要件）
    notice = FONT_DIR / "LICENSE-NOTICE.md"
    if not notice.exists():
        notice.write_text(
            "# 同梱フォントのライセンス\n\n"
            "以下のフォントは **SIL Open Font License 1.1** で提供されており、\n"
            "アプリへの同梱・再配布が許可されている。\n\n"
            "| フォント | 用途 | 出典 |\n"
            "|---|---|---|\n"
            "| Zen Kaku Gothic New Black | 通常テロップ | google/fonts ofl/zenkakugothicnew |\n"
            "| Dela Gothic One | 強調・怒り | google/fonts ofl/delagothicone |\n"
            "| Zen Old Mincho Bold | 補足（明朝） | google/fonts ofl/zenoldmincho |\n\n"
            "🔴 配布物には OFL 全文を同梱すること（OFL の要件）。\n"
            "🔴 商用フォント（モリサワ等）は「商用利用可」でも**同梱不可**なものが多い。混ぜないこと。\n",
            encoding="utf-8",
        )
        print(f"  ✓ {notice.name}")

    if failures:
        print("\n取得に失敗したものがあります:")
        for f in failures:
            print(f"  {f}")
        return 1

    print(f"\n配置先: {FONT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
