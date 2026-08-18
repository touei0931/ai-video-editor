#!/usr/bin/env python3
"""1080×1920 の書き出しが通ることを確認する（Phase 0 T3 の受け入れ条件）。

横(16:9)素材を 9:16 にクロップして縦動画として書き出す、という
本アプリの中心的な出力経路を、実際のエンコーダ選択ロジック
（sidecar/ffmpeg/platform_args.py）を使って通す。

    $ python scripts/export_smoke.py

結果は phase0-artifacts/export-smoke.json に残す（CI で回収する）。
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from sidecar.ffmpeg.platform_args import (  # noqa: E402
    available_video_args,
    platform_name,
    proxy_args,
)

SAMPLES = ROOT / "samples"
OUT_DIR = ROOT / "phase0-artifacts"

TARGET_W, TARGET_H = 1080, 1920


def find_ffmpeg() -> str:
    for name in ("ffmpeg.exe", "ffmpeg"):
        candidate = ROOT / "vendor" / "ffmpeg" / name
        if candidate.exists():
            return str(candidate)
    sys.exit("vendor/ffmpeg/ に ffmpeg がありません。`python scripts/fetch_ffmpeg.py` を先に実行してください。")


def probe_stream(ffmpeg: str, path: Path) -> dict:
    """ffprobe が無い環境もありうるので ffmpeg の出力から読む。"""
    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    text = result.stderr
    info: dict = {}
    for line in text.splitlines():
        if "Video:" in line:
            info["video"] = line.strip()
        elif "Audio:" in line:
            info["audio"] = line.strip()
    return info


def export(ffmpeg: str, src: Path, dst: Path) -> dict:
    """横素材を 9:16 にクロップして 1080×1920 で書き出す。"""
    vargs, encoder = available_video_args(ffmpeg)

    # 中央を 9:16 で切り出してから目標解像度へ。
    # （実際のアプリでは顔追従でクロップ位置を動かす。ここでは中央固定で経路だけ確認する）
    #
    # クロップ幅は必ず偶数にする。1080*9/16 = 607.5 のように奇数/小数になると
    # SAR が 1:1 でなくなり、再生環境によって縦横比が狂う。
    # 最後に setsar=1 で正方形ピクセルを明示する。
    vf = f"crop=trunc(ih*9/16/2)*2:ih,scale={TARGET_W}:{TARGET_H},setsar=1"

    cmd = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(src),
        "-vf", vf,
        *vargs,
        "-c:a", "aac", "-b:a", "128k",
        str(dst),
    ]

    started = time.perf_counter()
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    elapsed = time.perf_counter() - started

    if result.returncode != 0:
        return {"ok": False, "encoder": encoder, "error": result.stderr[-1500:]}

    return {
        "ok": True,
        "encoder": encoder,
        "seconds": round(elapsed, 2),
        "size_mb": round(dst.stat().st_size / 1024 / 1024, 2),
        "stream": probe_stream(ffmpeg, dst),
    }


def export_proxy(ffmpeg: str, src: Path, dst: Path) -> dict:
    """レビュー用プロキシ。Mac では ProRes Proxy になる（§8.5）。"""
    pargs = proxy_args()
    encoder = pargs[pargs.index("-c:v") + 1]

    cmd = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(src), "-t", "5",
        "-vf", "scale=540:-2",
        *pargs, "-an", str(dst),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")

    if result.returncode != 0:
        return {"ok": False, "encoder": encoder, "error": result.stderr[-800:]}
    return {"ok": True, "encoder": encoder, "size_mb": round(dst.stat().st_size / 1024 / 1024, 2)}


def main() -> int:
    ffmpeg = find_ffmpeg()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    src = SAMPLES / "sample_landscape_solo.mp4"
    if not src.exists():
        sys.exit("テスト素材がありません。`python scripts/make_test_media.py` を先に実行してください。")

    print(f"プラットフォーム: {platform_name()}")
    print(f"入力: {src.name}\n")

    print(f"書き出し（{TARGET_W}x{TARGET_H} 縦）…")
    main_result = export(ffmpeg, src, OUT_DIR / "export_1080x1920.mp4")
    if main_result["ok"]:
        print(f"  ✓ {main_result['encoder']} / {main_result['seconds']}秒 / {main_result['size_mb']}MB")
        print(f"    {main_result['stream'].get('video', '')}")
    else:
        print(f"  ✗ {main_result['encoder']}")
        print(main_result["error"])

    print("\nレビュー用プロキシ…")
    proxy_result = export_proxy(ffmpeg, src, OUT_DIR / f"proxy.{'mov' if platform_name() == 'mac' else 'mp4'}")
    if proxy_result["ok"]:
        print(f"  ✓ {proxy_result['encoder']} / {proxy_result['size_mb']}MB")
    else:
        print(f"  ✗ {proxy_result['encoder']}")
        print(proxy_result["error"])

    summary = {
        "platform": platform_name(),
        "export_1080x1920": main_result,
        "proxy": proxy_result,
    }
    (OUT_DIR / "export-smoke.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    ok = main_result["ok"] and proxy_result["ok"]
    print(f"\n{'export_smoke: OK' if ok else 'export_smoke: 失敗あり'}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
