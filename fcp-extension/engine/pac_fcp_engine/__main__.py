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


def probe_backends() -> dict:
    """文字起こしの部品が import できるか。

    🔴 固めたバイナリの中で確かめること。素の Python で通っても、
       PyInstaller が拾い損ねると固めた後だけ動かない。モデルは要らない。
    """
    out: dict = {}
    for name, mod in (
        ("faster-whisper", "faster_whisper"),
        ("mlx-qwen3-asr", "mlx_qwen3_asr"),
        ("nagisa", "nagisa"),
        # 話者（喋っている人）を声で見分ける部品
        ("sherpa-onnx", "sherpa_onnx"),
    ):
        try:
            __import__(mod)
            out[name] = "ok"
        except Exception as e:  # noqa: BLE001
            out[name] = f"ng: {e}"

    """
    🔴 声のモデル（40MB）が同梱から漏れていないかも、ここで見ること。
       import は通るのにモデルだけ無い、が起こりうる（datas の書き忘れ）。
       そのときは「話者の色だけ効かない」形で現れ、解析も書き出しも
       普通に動くので気づけない。
    """
    try:
        from sidecar.speakers import model_path

        out["声のモデル"] = "ok" if model_path().exists() else "ng: 見つからない"
    except Exception as e:  # noqa: BLE001
        out["声のモデル"] = f"ng: {e}"
    return out


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="pac_fcp_engine", description="動画を解析してパネル用 JSON を作る")
    p.add_argument("--probe", action="store_true",
                   help="解析せず、文字起こしの部品が読み込めるかだけを JSON で出す（配布物の検査用）")
    p.add_argument("--speakers",
                   help="話者（喋っている人）の操作。中身が JSON のファイルを渡す。解析はしない")
    p.add_argument("--keep-wav",
                   help="取り出した音声を残す場所。あとで声を見分けるのに使う")
    p.add_argument("--video", help="解析する動画")
    p.add_argument("--out", help="書き出す JSON")
    p.add_argument("--model", default="large-v3-turbo")
    p.add_argument("--language", default="ja")
    p.add_argument("--cut-preset", default="talk", choices=CUT_PRESETS,
                   help="間の詰め具合（左ほど間を残す）")
    p.add_argument("--aside", default="on", choices=["on", "off"],
                   help="話が繋がっていないひとりごとも候補に挙げるか")
    p.add_argument("--fillers", default="",
                   help="利用者が足す口ぐせ（読点・空白区切り）")
    p.add_argument("--min-gain", type=float, default=0.0,
                   help="これより短くしかならない間は候補にしない（0 なら詰め具合の既定）")
    p.add_argument("--ffmpeg", default="ffmpeg")
    p.add_argument("--waveform-points", type=int, default=800)
    args = p.parse_args(argv)

    if args.probe:
        print(json.dumps(probe_backends(), ensure_ascii=False))
        return 0

    """
    🔴 話者の操作は、解析とは別の入口にすること。
       解析（数分〜数十分）の仕組みに混ぜると、見分け直すたびに
       文字起こしから始めることになる。
    """
    if args.speakers:
        if not args.out:
            p.error("--speakers には --out が要ります")
        from .speakers import run_file

        result = run_file(args.speakers, args.out)
        # 失敗も 0 で返す（中身の error を読ませる。呼び出し側は結果の JSON だけ見る）
        print(json.dumps({"ok": "error" not in result}, ensure_ascii=False), flush=True)
        return 0

    if not args.video or not args.out:
        p.error("--video と --out が要ります")

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
                "extra_fillers": args.fillers,
                # 🔴 0 は「覚えていない」の意味。詰め具合の既定を上書きしない
                **({"min_gain": args.min_gain} if args.min_gain > 0 else {}),
            }},
            keep_wav=args.keep_wav,
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
