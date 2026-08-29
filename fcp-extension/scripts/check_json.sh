#!/bin/bash
# パネルへ返す値の均し方を検める（Mac が無いので CI に見張らせる）
#
# 🔴 これが抜けると拡張が丸ごと落ちる。JSONSerialization は
#    Objective-C の例外を投げるので Swift 側では受け止められず、
#    パネルは「読み込み中…」のまま止まる。理由はどこにも出ない。
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${TMPDIR:-/tmp}/pac-jsoncheck"
echo "--- コンパイル ---"
swiftc -O Extension/JSONSafe.swift tools/jsoncheck/main.swift -o "$OUT"

echo "--- 実行 ---"
"$OUT"
