"""コマンドラインから解析する。

    python -m pac_fcp_engine --video 素材.mp4 --out state.json

Swift 側（コンテナアプリ）はこれを呼び、進捗は標準エラーの行区切り JSON で受け取る。
"""

from __future__ import annotations

import argparse
import json
import sys

from .analyze import analyze

#: 間の詰め具合。
#: 🔴 sidecar/cut.py の PRESET_ORDER と揃えること
#:    （engine/tests/test_engine.py が突き合わせる）。
#:    知らない名前を黙って受けると、PRESETS の上書きが空になり、
#:    「ふつう」ですらない中途半端な設定で候補を出すことになる。
CUT_PRESETS = ["loose", "talk", "short", "tight"]


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="pac_fcp_engine", description="動画を解析してパネル用 JSON を作る")
    p.add_argument("--video", required=True, help="解析する動画")
    p.add_argument("--out", required=True, help="書き出す JSON")
    p.add_argument("--model", default="large-v3-turbo")
    p.add_argument("--language", default="ja")
    p.add_argument("--cut-preset", default="talk", choices=CUT_PRESETS,
                   help="間の詰め具合（左ほど間を残す）")
    p.add_argument("--aside", default="on", choices=["on", "off"],
                   help="話が繋がっていないひとりごとも候補に挙げるか")
    p.add_argument("--ffmpeg", default="ffmpeg")
    p.add_argument("--waveform-points", type=int, default=800)
    args = p.parse_args(argv)

    def progress(stage: str, ratio: float) -> None:
        # 1行1メッセージ。呼び出し側が読みやすい形にしておく
        print(json.dumps({"stage": stage, "ratio": round(ratio, 3)}, ensure_ascii=False),
              file=sys.stderr, flush=True)

    try:
        state = analyze(
            args.video,
            model=args.model,
            language=args.language,
            ffmpeg=args.ffmpeg,
            waveform_points=args.waveform_points,
            options={"cut": {
                "preset": args.cut_preset,
                "detect_aside": args.aside == "on",
            }},
            progress=progress,
        )
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": str(e)}, ensure_ascii=False), file=sys.stderr, flush=True)
        return 1

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)
    print(json.dumps({
        "ok": True,
        "cuts": len(state["cuts"]),
        "telops": len(state["telops"]),
        "duration": state["durationSec"],
    }, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
