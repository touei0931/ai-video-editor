"""テロップの見せ方（通常／強調／補足）の判定の検査（sidecar/telop.py の classify）。

🔴 守っていること:
   - 強調は「その素材の中で声が大きい」で決める。感嘆符だけでは強調にしない。
     Whisper は叫び気味の配信ではほぼ全部の文に「!」を付けるので、
     感嘆符で決めると全部が強調になる（VTuber のコラボで 34枚中ほぼ全部。2026-09-11）
   - 感嘆符は、声が平均より少し大きい（閾値の半分）ときの後押しにだけ使う
   - 音量が測れない（wav が無い）ときだけ、感嘆符で決める（プラグイン版の試験も同じ前提）
   - 強調語（「めちゃくちゃ」など）は文全体ではなく、その語だけを目立たせる

実行: python scripts/test_telop_style.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _console import enable_utf8  # noqa: E402

from sidecar.telop import DEFAULTS, classify  # noqa: E402

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
    loud = DEFAULTS["loud_db"]

    # 感嘆符だけ（声は平均並み）→ 通常
    s, r, _ = classify("待て待て待て!", 0.0, DEFAULTS)
    check("感嘆符だけで声が平均並みなら通常", s == "normal", f"{s} / {r}")
    s, r, _ = classify("消えた!消えた!", loud * 0.5 - 0.1, DEFAULTS)
    check("感嘆符があっても閾値の半分に届かなければ通常", s == "normal", f"{s} / {r}")

    # 感嘆符 + 少し大きい声 → 強調
    s, r, _ = classify("まだ来るぞ!", loud * 0.5 + 0.1, DEFAULTS)
    check("感嘆符と少し大きい声なら強調", s == "emphasis", f"{s} / {r}")

    # 大きい声 → 感嘆符が無くても強調
    s, r, _ = classify("これはすごいことになった", loud + 0.5, DEFAULTS)
    check("声が大きければ感嘆符が無くても強調", s == "emphasis", f"{s} / {r}")

    # 音量が測れない → 感嘆符で決める（従来どおり）
    s, r, _ = classify("やった!", None, DEFAULTS)
    check("音量が測れないときは感嘆符で強調", s == "emphasis", f"{s} / {r}")
    s, r, _ = classify("やった", None, DEFAULTS)
    check("音量が測れず感嘆符も無ければ通常", s == "normal", f"{s} / {r}")

    # 強調語は語だけ
    s, r, word = classify("これがめちゃくちゃ硬くて", 0.0, DEFAULTS)
    check("強調語は文全体ではなく語だけ", s == "normal" and word == "めちゃくちゃ", f"{s} / {word}")

    # 補足は音量に関係なく補足
    s, r, _ = classify("ちなみにこれは去年の話です", loud + 2, DEFAULTS)
    check("補足の言い回しは声が大きくても補足", s == "note", f"{s} / {r}")

    print()
    print("test-telop-style: OK" if failed == 0 else f"test-telop-style: {failed} 件失敗")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
