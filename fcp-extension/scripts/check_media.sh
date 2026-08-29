#!/bin/bash
# 素材の配り手（pac-media://）を検める
#
# 🔴 範囲の読み方が狂うと「再生はできるが途中へ飛べない」になる。
#    実機で触るまで気づけない見え方なので、机上で潰しておく。
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${TMPDIR:-/tmp}/pac-mediacheck"
echo "--- コンパイル ---"
swiftc -O Extension/MediaSchemeHandler.swift tools/mediacheck/main.swift -o "$OUT"

echo "--- 実行 ---"
"$OUT"
