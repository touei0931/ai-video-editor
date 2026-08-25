#!/bin/bash
# 配布する形の PAC.app から、解析が通しで動くかを確かめる。
#
# 🔴 見るのは「同梱されているか」ではなく「配布した形で、リポジトリの外から動くか」。
#    PAC 本体で2度踏んだ罠（同梱物のパス解決／Homebrew 依存）は、
#    どちらも「同梱の確認」では見つからず、配布して初めて壊れた。
set -euo pipefail

APP="${1:?PAC.app のパスを渡してください}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# アプリを一度リポジトリの外へ写す。手元の作業ツリーに依存していないことを確かめるため
cp -R "$APP" "$WORK/PAC.app"
ENGINE="$WORK/PAC.app/Contents/Resources/engine/pac-engine/pac-engine"
FFMPEG="$WORK/PAC.app/Contents/Resources/ffmpeg/ffmpeg"

echo "--- 配布物の外での起動確認 ---"
test -x "$ENGINE" || { echo "❌ エンジンが実行できない"; exit 1; }
test -x "$FFMPEG" || { echo "❌ ffmpeg が実行できない"; exit 1; }

echo "--- 検証用の日本語音声を作る ---"
say -v Kyoko -o "$WORK/voice.aiff" \
  "これはテストです。えー、自動カットとテロップの確認をします。"

echo "--- 解析を通す（アプリの中のエンジンで） ---"
"$ENGINE" \
  --video "$WORK/voice.aiff" \
  --out "$WORK/state.json" \
  --model base \
  --ffmpeg "$FFMPEG"

echo "--- 結果の検査 ---"
python3 - "$WORK/state.json" <<'PY'
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
PY
