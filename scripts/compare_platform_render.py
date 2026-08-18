#!/usr/bin/env python3
"""Windows と macOS のテロップ描画を比較する（設計レポート §10.3）。

開発者は Mac を所持していないため、「Mac では見た目が違う」に気づく手段が要る。
CI で両 OS の T1 成果物を突き合わせ、**フォントメトリクスの一致**を守る。

守るもの / 許すもの:
  🔴 守る: 文字の外接矩形（= サイズ・配置・改行位置）。
          ここがズレると Mac だけレイアウトが崩れる。設計上の実害。
  ✅ 許す: 輪郭のアンチエイリアス差。
          OS のフォントラスタライザの違いで必ず出る。動画では知覚できず、
          最終書き出しは友達の Mac で行うので実害がない。

    $ python scripts/compare_platform_render.py <windows成果物dir> <macos成果物dir>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _console import enable_utf8  # noqa: E402

enable_utf8()

try:
    from PIL import Image, ImageChops
except ImportError:
    sys.exit("Pillow が必要です: python -m pip install -r scripts/requirements-dev.txt")

CASES = ["normal", "note", "emphasis"]

# 外接矩形のズレの許容値（px）。
# サブピクセル位置の丸めで 1px 程度は動きうるが、それ以上は metrics の相違を疑う。
BBOX_TOLERANCE = 2


def bbox(path: Path) -> tuple[int, int, int, int]:
    img = Image.open(path).convert("RGBA")
    box = img.split()[3].getbbox()
    if box is None:
        raise ValueError(f"透明な画像です（テロップが描かれていない）: {path}")
    return box


def main() -> int:
    if len(sys.argv) != 3:
        sys.exit(f"使い方: {sys.argv[0]} <windows成果物dir> <macos成果物dir>")

    win_dir, mac_dir = Path(sys.argv[1]), Path(sys.argv[2])
    report: list[dict] = []
    failed = False

    for case in CASES:
        win_png = win_dir / f"{case}-telop.png"
        mac_png = mac_dir / f"{case}-telop.png"
        if not win_png.exists() or not mac_png.exists():
            print(f"✗ {case}: 成果物が見つかりません")
            failed = True
            continue

        bw, bm = bbox(win_png), bbox(mac_png)
        deltas = [abs(a - b) for a, b in zip(bw, bm)]
        metrics_ok = max(deltas) <= BBOX_TOLERANCE

        w_img = Image.open(win_png).convert("RGB")
        m_img = Image.open(mac_png).convert("RGB")
        diff = ImageChops.difference(w_img, m_img).convert("L")
        hist = diff.histogram()
        total = w_img.width * w_img.height
        differing = sum(hist[1:])

        print(f"{'✓' if metrics_ok else '✗'} {case}")
        print(f"    外接矩形 Windows: {bw[2] - bw[0]}x{bw[3] - bw[1]}  macOS: {bm[2] - bm[0]}x{bm[3] - bm[1]}")
        print(f"    ズレ: {deltas}（許容 {BBOX_TOLERANCE}px）")
        print(f"    輪郭の差: {differing} px / {total}（{differing / total * 100:.3f}%・許容）")

        if not metrics_ok:
            failed = True
            print("    🔴 フォントメトリクスが一致しません。Mac だけレイアウトが崩れます。")

        report.append({
            "case": case,
            "metrics_ok": metrics_ok,
            "bbox_windows": bw,
            "bbox_macos": bm,
            "bbox_delta": deltas,
            "differing_pixels": differing,
            "differing_ratio": round(differing / total, 6),
        })

    out = Path("phase0-artifacts") / "platform-render-compare.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps({"ok": not failed, "cases": report}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print()
    if failed:
        print("フォントメトリクスの不一致を検出しました。")
        return 1
    print("compare_platform_render: OK — メトリクスは一致（輪郭の差のみ）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
