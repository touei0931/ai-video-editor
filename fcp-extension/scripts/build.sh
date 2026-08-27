#!/bin/bash
# PAC Workflow Extension をビルドする（macOS 専用）
#   前提: xcodegen / Xcode / Workflow Extensions SDK が入っていること
set -euo pipefail
cd "$(dirname "$0")/.."

SDK_PATH="/Library/Developer/SDKs/WorkflowExtensionSDK.sdk"
BUILD_DIR="${BUILD_DIR:-build}"

if [ ! -d "$SDK_PATH" ]; then
  echo "❌ Workflow Extensions SDK が見つかりません: $SDK_PATH"
  echo "   https://developer.apple.com/download/all/?q=WorkflowExtensions から入手して展開してください。"
  exit 1
fi
echo "✅ SDK: $SDK_PATH"

echo "--- webui をビルド ---"
if [ -d webui ]; then
  ( cd webui && npm ci --no-audit --no-fund && npm run build )
  rm -rf Extension/webui
  cp -R webui/dist Extension/webui
  echo "✅ webui を Extension/webui に配置"
  ls Extension/webui | head
else
  echo "⚠ webui が無いのでスキップ"
fi

echo "--- xcodegen ---"
xcodegen generate

echo "--- xcodebuild ---"
xcodebuild \
  -project PAC.xcodeproj \
  -scheme PAC \
  -configuration Release \
  -derivedDataPath "$BUILD_DIR" \
  CODE_SIGNING_ALLOWED=NO \
  build

APP="$BUILD_DIR/Build/Products/Release/PAC for Final Cut.app"
[ -d "$APP" ] || { echo "❌ PAC for Final Cut.app が生成されていません"; exit 1; }
echo "✅ built: $APP"
