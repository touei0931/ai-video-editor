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

# 版はここで決めて、画面（webui）とアプリ（Info.plist）の両方で同じものを使う。
# 🔴 2か所で別々に決めないこと。片方だけ古い版を名乗ることになる。
PAC_VERSION="${PAC_VERSION:-1.0.$(git rev-list --count HEAD 2>/dev/null || echo 0)}"
PAC_BUILD="v$PAC_VERSION"
export PAC_VERSION PAC_BUILD

echo "--- webui をビルド ---"
if [ -d webui ]; then
  # 🔴 版を埋め込むこと。画面に出しておかないと、直したものを渡しても
  #    「本当にそれが動いているのか」がキャプチャから分からない。
  #
  # 🔴 版はビルドのたびに必ず変わること。
  #    手で上げる決まりにすると、上げ忘れた版が「新しい版のはず」として出回る。
  #    積み上げたコミットの数を使えば、勝手に、必ず1つ増える。
  export PAC_BUILD
  echo "版: $PAC_BUILD"
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
  MARKETING_VERSION="$PAC_VERSION" \
  build

APP="$BUILD_DIR/Build/Products/Release/PAC for Final Cut.app"
[ -d "$APP" ] || { echo "❌ PAC for Final Cut.app が生成されていません"; exit 1; }
echo "✅ built: $APP"
