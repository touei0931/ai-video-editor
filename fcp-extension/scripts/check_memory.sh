#!/bin/bash
# 「間の好み」の覚え方を検める（Mac が無いので CI に見張らせる）
#
# 🔴 ここは候補を減らす仕組みなので、間違えると
#    「切りたい所が候補に出てこない」という形で現れる。
#    出てこないものには気づけないので、必ず検査で縛る。
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${TMPDIR:-/tmp}/pac-memcheck"
echo "--- コンパイル ---"
swiftc -O Extension/CutMemory.swift tools/memcheck/main.swift -o "$OUT"

echo "--- 実行 ---"
"$OUT"
