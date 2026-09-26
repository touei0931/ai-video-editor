"""テロップの見せ方の検査（sidecar/telop.py の classify）。

🔴 守っていること:
   - **自動で強調しない**。声の大きさ・感嘆符・強調語・補足の言い回し、どれでも
     見た目を変えない。見た目は利用者が読み込ませた見本（Motion テンプレ）に
     任せ、変えたい1枚だけ手で変えてもらう（2026-09-27）。
   - 過去に踏んだもの: 感嘆符で決めると叫び気味の配信でほぼ全部が強調になった
     （VTuber のコラボで 34枚中ほぼ全部。2026-09-11）。声の大きさだけに絞っても
     「強調表示はいらない」だった。

実行: python scripts/test_telop_style.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _console import enable_utf8  # noqa: E402

from sidecar.telop import DEFAULTS, build_units, classify  # noqa: E402

failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failed
    if not ok:
        failed += 1
    print(f"[telop-style] {'OK  ' if ok else 'NG  '} {name}")
    if detail:
        print(f"              {detail}")


def main() -> int:
    enable_utf8()

    cases = [
        ("感嘆符", "待て待て待て!", 0.0),
        ("感嘆符と大きい声", "まだ来るぞ!", 20.0),
        ("とても大きい声", "これはすごいことになった", 30.0),
        ("音量が測れない＋感嘆符", "やった!", None),
        ("強調語", "これがめちゃくちゃ硬くて", 0.0),
        ("補足の言い回し", "ちなみにこれは去年の話です", 10.0),
    ]
    for label, text, delta in cases:
        style, reason, word = classify(text, delta, DEFAULTS)
        check(f"{label}でも通常のまま", style == "normal", f"{style} / {reason}")
        check(f"{label}で目立たせる語を返さない", word is None, str(word))

    # 音量の設定はもう持たない（見た目を音で決めないため）
    check("音量の閾値の設定を持たない", "loud_db" not in DEFAULTS, str(DEFAULTS.keys()))

    # 通しても全部「通常」
    transcript = {
        "segments": [
            {
                "id": "s0",
                "src_start": 0.0,
                "src_end": 3.0,
                "text": "やばいこれすごい!",
                "avg_logprob": -0.2,
                "no_speech_prob": 0.0,
                "words": [
                    {"text": "やばい", "src_start": 0.0, "src_end": 0.6, "probability": 0.9},
                    {"text": "これ", "src_start": 0.6, "src_end": 1.0, "probability": 0.9},
                    {"text": "すごい!", "src_start": 1.0, "src_end": 1.8, "probability": 0.9},
                ],
            }
        ]
    }
    units = build_units(transcript)
    check("解析を通しても全部が通常", all(t["style"] == "normal" for t in units["telops"]),
          str([t["style"] for t in units["telops"]]))
    check("目立たせる語も付かない", all(t["highlight"] is None for t in units["telops"]))

    print()
    print("test-telop-style: OK" if failed == 0 else f"test-telop-style: {failed} 件失敗")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
