#!/bin/bash
# 配布する形の PAC for Final Cut.app から、解析が通しで動くかを確かめる。
#
# 🔴 見るのは「同梱されているか」ではなく「配布した形で、リポジトリの外から動くか」。
#    PAC 本体で2度踏んだ罠（同梱物のパス解決／Homebrew 依存）は、
#    どちらも「同梱の確認」では見つからず、配布して初めて壊れた。
set -euo pipefail

APP="${1:?PAC for Final Cut.app のパスを渡してください}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# アプリを一度リポジトリの外へ写す。手元の作業ツリーに依存していないことを確かめるため
cp -R "$APP" "$WORK/PAC for Final Cut.app"
ENGINE="$WORK/PAC for Final Cut.app/Contents/Resources/engine/pac-engine/pac-engine"
FFMPEG="$WORK/PAC for Final Cut.app/Contents/Resources/ffmpeg/ffmpeg"

echo "--- 配布物の外での起動確認 ---"
test -x "$ENGINE" || { echo "❌ エンジンが実行できない"; exit 1; }
test -x "$FFMPEG" || { echo "❌ ffmpeg が実行できない"; exit 1; }

echo "--- 検証用の日本語音声を作る ---"
say -v Kyoko -o "$WORK/voice.aiff" "これはテストです。えー、自動カットとテロップの確認をします。"

# 🔴 音声ファイルだけで済ませないこと。
#    ここは長らく .aiff を渡していたため、「素材の大きさが取れるか」を
#    一度も確かめていなかった。実際には同梱 ffmpeg の場所が PAC 本体へ
#    伝わっておらず、**毎回**失敗して 1920x1080 に倒れていた。
#    縦の素材が枠の 0.316 倍で真ん中に出る、という形でしか現れない
#    （2026-08-31に判明）。
# 🔴 縦で、かつ 16:9 ではない大きさにすること。
#    決め打ちの 1920x1080 に倒れたら必ず食い違うようにしておく。
echo "--- 検証用の縦動画を作る（1080x1920 / 30fps） ---"
"$FFMPEG" -y -loglevel error -f lavfi -i "testsrc=size=1080x1920:rate=30:duration=6" -i "$WORK/voice.aiff" -c:v mpeg4 -q:v 5 -pix_fmt yuv420p -c:a aac -shortest "$WORK/sample.mp4"

# 🔴 PATH を裸にして走らせること。
#    CI の Mac には Homebrew が入っているので、PAC 本体が同梱の ffmpeg を
#    見つけられなくても、PATH の ffmpeg に助けられて通ってしまう。
#    友達の Mac には ffmpeg は入っていない。そちらに合わせて確かめる。
echo "--- 解析を通す（アプリの中のエンジンで／PATH は裸） ---"
env PATH=/usr/bin:/bin "$ENGINE" --video "$WORK/sample.mp4" --out "$WORK/state.json" --model base --ffmpeg "$FFMPEG"

echo "--- 結果の検査 ---"
python3 - "$WORK/state.json" <<'PYEOF'
import json, sys

state = json.load(open(sys.argv[1], encoding="utf-8"))
fails = []

def check(label, ok, detail=""):
    print(("✅ " if ok else "❌ ") + label + ("" if ok else f" {detail}"))
    if not ok:
        fails.append(label)

check("尺が取れている", state["durationSec"] > 0, str(state["durationSec"]))
check("波形が作られている", len(state["waveform"]) > 100, str(len(state["waveform"])))
check("文字起こしが返っている", bool(state["telops"]), "テロップが空")
check("パネルが読む形になっている",
      {"videoUrl", "durationSec", "waveform", "cuts", "telops"} <= set(state))

# 🔴 素材の大きさとコマ数。取れないと書き出しが 1920x1080 に倒れ、
#    縦の素材が枠の 0.316 倍で真ん中に出る（2026-08-31に踏んだ）。
report = state.get("report", {})
check("大きさが読めない理由が残っていない", not report.get("videoInfoError"),
      str(report.get("videoInfoError")))
check("素材の幅が取れている", state.get("width") == 1080, str(state.get("width")))
check("素材の高さが取れている", state.get("height") == 1920, str(state.get("height")))
check("縦のまま渡っている", (state.get("height") or 0) > (state.get("width") or 0),
      f"{state.get('width')}x{state.get('height')}")
check("コマ数が取れている", abs((state.get("fps") or 0) - 30) < 0.5, str(state.get("fps")))

for t in state["telops"]:
    check(f"テロップの時刻が正しい向き（{t['text'][:12]}）", t["start"] < t["end"])
    check("スタイルは通常か強調", t["style"] in ("normal", "emphasis"), t["style"])

for c in state["cuts"]:
    check("カットは未判断で返る", c["decision"] == "pending", c["decision"])
    check("カットの種類が想定内", c["kind"] in ("silence", "filler", "restate"), c["kind"])

print()
for t in state["telops"]:
    print(f"  {t['start']:5.2f}s  {t['text']}")

if fails:
    print("\n🚫 失敗: " + " / ".join(fails))
    sys.exit(1)
print("\n🎉 配布した形で解析が通った")
PYEOF
