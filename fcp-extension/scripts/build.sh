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

APP="$BUILD_DIR/Build/Products/Release/PAC.app"
[ -d "$APP" ] || { echo "❌ PAC.app が生成されていません"; exit 1; }
echo "✅ built: $APP"
