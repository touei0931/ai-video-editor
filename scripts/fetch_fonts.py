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
#
# 🔴 「普通の太さ」と「太い太さ」を**両方**取ること。
#    1書体につき1ファイルしか持たないと、画面で「太字」を選んだときに
#    ブラウザが輪郭を太らせて偽の太字を作る。日本語書体でこれをやると
#    細部が潰れて濁点や画数の多い漢字が読めなくなる。
#    実物の太さを持っておけば、選んだとおりの字が出る。
FONTS = [
    ("ゴシック体（普通）", "ZenKakuGothicNew-Regular.ttf", "ofl/zenkakugothicnew/ZenKakuGothicNew-Regular.ttf"),
    ("ゴシック体（太字）", "ZenKakuGothicNew-Black.ttf", "ofl/zenkakugothicnew/ZenKakuGothicNew-Black.ttf"),
    ("丸ゴシック体（普通）", "ZenMaruGothic-Regular.ttf", "ofl/zenmarugothic/ZenMaruGothic-Regular.ttf"),
    ("丸ゴシック体（太字）", "ZenMaruGothic-Black.ttf", "ofl/zenmarugothic/ZenMaruGothic-Black.ttf"),
    ("明朝体（普通）", "ZenOldMincho-Regular.ttf", "ofl/zenoldmincho/ZenOldMincho-Regular.ttf"),
    ("明朝体（太字）", "ZenOldMincho-Bold.ttf", "ofl/zenoldmincho/ZenOldMincho-Bold.ttf"),
    ("インパクト", "DelaGothicOne-Regular.ttf", "ofl/delagothicone/DelaGothicOne-Regular.ttf"),
]


# ライセンス全文。OFL は「フォントを配るならライセンス全文も一緒に配ること」を求めている。
# 名前を書いておくだけでは要件を満たさないので、ファイルとして同梱する。
LICENSES = [
    ("ZenKakuGothicNew", "ofl/zenkakugothicnew/OFL.txt"),
    ("ZenMaruGothic", "ofl/zenmarugothic/OFL.txt"),
    ("ZenOldMincho", "ofl/zenoldmincho/OFL.txt"),
    ("DelaGothicOne", "ofl/delagothicone/OFL.txt"),
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

    # ライセンス全文も一緒に配る（OFL の要件）
    license_dir = FONT_DIR / "licenses"
    license_dir.mkdir(parents=True, exist_ok=True)
    for family, path in LICENSES:
        dest = license_dir / f"{family}-OFL.txt"
        if dest.exists():
            print(f"  = {dest.name}（既にあります）")
            continue
        try:
            with urllib.request.urlopen(f"{GOOGLE_FONTS}/{path}") as res, dest.open("wb") as f:
                f.write(res.read())
            print(f"  ✓ ライセンス: {dest.name}")
        except Exception as e:  # noqa: BLE001
            failures.append(f"{dest.name}: {e}")
            print(f"  ✗ ライセンス: {dest.name} — {e}")

    # ライセンス表示は配布時に必須（OFL の要件）
    notice = FONT_DIR / "LICENSE-NOTICE.md"
    if not notice.exists():
        notice.write_text(
            "# 同梱フォントのライセンス\n\n"
            "以下のフォントは **SIL Open Font License 1.1** で提供されており、\n"
            "アプリへの同梱・再配布が許可されている。\n\n"
            "| フォント | 用途 | 出典 |\n"
            "|---|---|---|\n"
            "| Zen Kaku Gothic New Regular / Black | ゴシック体（普通 / 太字） | google/fonts ofl/zenkakugothicnew |\n"
            "| Zen Maru Gothic Regular / Black | 丸ゴシック体（普通 / 太字） | google/fonts ofl/zenmarugothic |\n"
            "| Zen Old Mincho Regular / Bold | 明朝体（普通 / 太字） | google/fonts ofl/zenoldmincho |\n"
            "| Dela Gothic One | インパクト | google/fonts ofl/delagothicone |\n\n"
            "OFL 全文は `licenses/` に書体ごとに置いてある（配布物にもそのまま入る）。\n\n"
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
