#!/usr/bin/env python3
"""テスト素材を ffmpeg で合成生成する（Phase 0 T0）。

実素材（友達が映っている動画）は**リポジトリに置かない**方針のため、
CI とローカルの回帰テストでは合成素材を使う。

合成素材のほうが回帰テストには向いている:
  - 決定論的（同じ入力から必ず同じ出力）
  - 無音区間の位置が既知なので、期待値を厳密に書ける
  - 権利・プライバシーの問題が一切ない
  - バイナリをリポジトリに入れずに済む（Git LFS 不要）

    $ python scripts/make_test_media.py

生成物は samples/ に出る（.gitignore 済み）。
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from _console import enable_utf8  # noqa: E402

enable_utf8()

OUT_DIR = ROOT / "samples"

FPS = 30
DURATION = 30.0

# 発話とみなす区間（秒）。ここ以外は無音になる。
# ① カット（無音検出）の期待値をこの表から直接書けるようにしてある。
SPEECH_SOLO: list[tuple[float, float]] = [
    (0.5, 3.2),
    (4.0, 6.8),
    (7.9, 8.3),  # 短い相槌
    (9.6, 14.1),
    (15.4, 15.9),  # 短い相槌
    (16.2, 21.0),
    (22.8, 27.5),
]

# 二人の掛け合い。話者A/Bを左右チャンネルに分けて、
# 話者アクティブ判定のロジックを「形だけ」通せるようにする。
SPEECH_DUO_A: list[tuple[float, float]] = [(0.5, 4.0), (8.5, 12.0), (17.0, 21.5), (25.0, 28.0)]
SPEECH_DUO_B: list[tuple[float, float]] = [(4.4, 8.0), (12.6, 16.5), (21.8, 24.6)]

# 話者ごとに基本周波数を変えておく（韻律解析の動作確認用）
TONE_A_HZ = 180
TONE_B_HZ = 240


def find_ffmpeg() -> str:
    """同梱の LGPL ビルド（T3）を優先し、無ければ PATH の ffmpeg を使う。"""
    for candidate in (ROOT / "vendor" / "ffmpeg" / "ffmpeg.exe", ROOT / "vendor" / "ffmpeg" / "ffmpeg"):
        if candidate.exists():
            return str(candidate)

    found = shutil.which("ffmpeg")
    if found:
        return found

    sys.exit(
        "ffmpeg が見つかりません。\n"
        "  - T3 で vendor/ffmpeg/ に LGPL ビルドを置く\n"
        "  - もしくは PATH の通った場所に ffmpeg を用意する"
    )


def gate_expr(segments: list[tuple[float, float]]) -> str:
    """発話区間だけ音を通すボリューム式を組み立てる。"""
    conditions = "+".join(f"between(t,{s},{e})" for s, e in segments)
    return f"if({conditions},1,0)"


def build(ffmpeg: str, name: str, width: int, height: int, duo: bool) -> Path:
    out = OUT_DIR / name

    # 映像: testsrc2 は決定論的で、フレーム番号が焼き込まれるので
    #       カット位置のズレを目視でも確認できる。
    video_src = f"testsrc2=size={width}x{height}:rate={FPS}:duration={DURATION}"

    if duo:
        audio_src = (
            f"sine=frequency={TONE_A_HZ}:duration={DURATION}[a0];"
            f"sine=frequency={TONE_B_HZ}:duration={DURATION}[b0];"
            f"[a0]volume='{gate_expr(SPEECH_DUO_A)}':eval=frame[a1];"
            f"[b0]volume='{gate_expr(SPEECH_DUO_B)}':eval=frame[b1];"
            f"[a1][b1]amerge=inputs=2[aout]"
        )
        audio_map = "[aout]"
        channels = "2"
    else:
        audio_src = (
            f"sine=frequency={TONE_A_HZ}:duration={DURATION}[a0];"
            f"[a0]volume='{gate_expr(SPEECH_SOLO)}':eval=frame[aout]"
        )
        audio_map = "[aout]"
        channels = "1"

    # 🔴 テスト素材は**ソフトウェアエンコーダ固定**にする。
    #
    # ハードウェアエンコーダ（NVENC / VideoToolbox）はマシンやドライバによって
    # 出力バイト列が変わるため、golden file テストの入力としては使えない。
    # mpeg4 は ffmpeg に必ず内蔵されていて外部ライブラリもライセンス問題もなく、
    # 同じ ffmpeg なら同じ出力になる。素材の画質は検証内容に影響しない。
    encoder = "mpeg4"
    vargs = ["-c:v", encoder, "-b:v", "4M", "-pix_fmt", "yuv420p"]

    cmd = [
        ffmpeg, "-y",
        "-f", "lavfi", "-i", video_src,
        "-filter_complex", audio_src,
        "-map", "0:v", "-map", audio_map,
        "-ac", channels,
        *vargs,
        "-c:a", "aac", "-b:a", "128k",
        "-r", str(FPS),
        str(out),
    ]

    print(f"生成中: {name} ({width}x{height}, {'二人' if duo else '一人'}, {encoder})")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(result.stderr[-2000:], file=sys.stderr)
        sys.exit(f"ffmpeg が失敗しました: {name}")
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="テスト素材を合成生成する")
    parser.parse_args()

    ffmpeg = find_ffmpeg()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    targets = [
        ("sample_portrait_solo.mp4", 1080, 1920, False),
        ("sample_landscape_solo.mp4", 1920, 1080, False),
        ("sample_landscape_duo.mp4", 1920, 1080, True),
    ]

    for name, w, h, duo in targets:
        path = build(ffmpeg, name, w, h, duo)
        print(f"  → {path} ({path.stat().st_size / 1024 / 1024:.1f} MB)")

    print("\n完了。無音区間の期待値は scripts/make_test_media.py の SPEECH_* を参照。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
