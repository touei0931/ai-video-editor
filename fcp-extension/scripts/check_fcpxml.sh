#!/bin/bash
# 生成される FCPXML を検査する（Mac が無いので CI に見張らせる）
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${TMPDIR:-/tmp}/pac-xmlcheck"
echo "--- コンパイル ---"
swiftc -O \
  Extension/FCPXMLWriter.swift \
  Extension/TitleTemplate.swift \
  tools/xmlcheck/main.swift \
  -o "$OUT"

echo "--- 実行 ---"
"$OUT"

echo "--- xmllint（整形式かどうか） ---"
if [ -f /tmp/pac-sample.fcpxml ]; then
  xmllint --noout /tmp/pac-sample.fcpxml && echo "✅ xmllint 通過"
  echo "--- 生成物の先頭 ---"
  head -20 /tmp/pac-sample.fcpxml
fi
