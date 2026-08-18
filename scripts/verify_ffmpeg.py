#!/usr/bin/env python3
"""同梱する ffmpeg の構成を検証する（Phase 0 T3 / §13.1）。

🔴 収益化を視野に入れているため、GPL 汚染は致命的。
   「LGPL ビルドのつもりが実は GPL だった」を機械的に防ぐのがこのスクリプトの役目。

検証項目:
  1. buildconf に --enable-gpl / --enable-nonfree が **無い** こと
  2. libx264 / libx265 / libfdk-aac が **無い** こと
  3. 実際に使うエンコーダが **在る** こと（プラットフォーム別）

    $ python scripts/verify_ffmpeg.py
"""

from __future__ import annotations

import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor" / "ffmpeg"

# 🔴 これらが1つでも入っていたら失格
#
# 注意: --enable-version3 は**禁止ではない**。
#   これは LGPL v2.1 → LGPL v3 への引き上げであって、GPL 化ではない。
#   GPL になるのは --enable-gpl と組み合わせたときだけ。
#   本アプリは ffmpeg を**別プロセスとして起動する**（リンクしない）ので、
#   LGPL v2.1 でも v3 でも義務はほぼ生じない。検出したら情報として表示するに留める。
FORBIDDEN_CONFIG = ["--enable-gpl", "--enable-nonfree"]
FORBIDDEN_LIBS = ["libx264", "libx265", "libfdk-aac", "libxvid", "libsmbclient"]

# 在ることを確認するエンコーダ（無ければ設計が成立しない）
REQUIRED_COMMON = ["aac"]

# Mac は VideoToolbox が必ず使えるので、外部の H.264 エンコーダを持たなくてよい。
# これにより macOS 版は外部ライブラリ依存ゼロでビルドでき、
# Homebrew の dylib に依存しない（＝友達の Mac でそのまま動く）。
REQUIRED_MAC = ["h264_videotoolbox", "prores_videotoolbox"]

# Windows は GPU 無し環境がありうるので、ソフトウェアのフォールバックが必須（§13.6）。
# NVENC/QSV/AMF は環境依存なので必須にはしない。
REQUIRED_WINDOWS = ["libopenh264"]
OPTIONAL_WINDOWS = ["h264_nvenc", "h264_qsv", "h264_amf"]


def find_ffmpeg() -> str:
    for name in ("ffmpeg.exe", "ffmpeg"):
        candidate = VENDOR / name
        if candidate.exists():
            return str(candidate)
    found = shutil.which("ffmpeg")
    if found:
        print(f"⚠ vendor/ffmpeg/ に無いため PATH の ffmpeg を検証します: {found}")
        return found
    sys.exit("ffmpeg が見つかりません。先に `python scripts/fetch_ffmpeg.py` を実行してください。")


def run(cmd: list[str]) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return (result.stdout or "") + (result.stderr or "")


def main() -> int:
    ffmpeg = find_ffmpeg()
    banner = run([ffmpeg, "-hide_banner", "-version"])
    encoders = run([ffmpeg, "-hide_banner", "-encoders"])

    version = re.search(r"ffmpeg version (\S+)", banner)
    print(f"ffmpeg: {ffmpeg}")
    print(f"バージョン: {version.group(1) if version else '不明'}\n")

    failures: list[str] = []
    warnings: list[str] = []

    # 1 + 2. 禁止された構成が入っていないこと
    for flag in FORBIDDEN_CONFIG:
        if flag in banner:
            failures.append(f"🔴 GPL 汚染: configuration に {flag} が含まれています")

    for lib in FORBIDDEN_LIBS:
        if f"--enable-{lib}" in banner:
            failures.append(f"🔴 GPL/非フリー汚染: {lib} がリンクされています")

    # ライセンスの実効的な種別を明示する（禁止ではなく記録）
    license_name = "LGPL v3" if "--enable-version3" in banner else "LGPL v2.1"
    print(f"ライセンス: {license_name}（ffmpeg は別プロセス起動なのでリンク義務は生じない）\n")

    # 3. 必要なエンコーダが在ること
    is_mac = platform.system() == "Darwin"
    required = REQUIRED_COMMON + (REQUIRED_MAC if is_mac else REQUIRED_WINDOWS)

    for enc in required:
        if re.search(rf"^\s*\S*\s+{re.escape(enc)}\s", encoders, re.MULTILINE):
            print(f"  ✓ {enc}")
        else:
            failures.append(f"🔴 必要なエンコーダがありません: {enc}")

    if not is_mac:
        available = [e for e in OPTIONAL_WINDOWS
                     if re.search(rf"^\s*\S*\s+{re.escape(e)}\s", encoders, re.MULTILINE)]
        if available:
            print(f"  ✓ ハードウェアエンコーダ: {', '.join(available)}")
        else:
            warnings.append(
                "⚠ ハードウェアエンコーダ（NVENC/QSV/AMF）がありません。"
                "libopenh264 にフォールバックします（§13.6）"
            )

    print()
    for w in warnings:
        print(w)

    if failures:
        print("\n検証に失敗しました:\n")
        for f in failures:
            print(f"  {f}")
        print("\nこの ffmpeg は同梱できません。LGPL ビルドを取り直してください。")
        return 1

    print("verify_ffmpeg: OK — GPL 汚染なし、必要なエンコーダあり")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
