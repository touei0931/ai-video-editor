"""カット候補の確信度が、3分割として成立しているかを検査する。

🔴 これが守っている不具合:
   無音の確信度は `0.6 + 0.3 * ...` という式で、**構造上 0.6 を下回れなかった**。
   フィラーも言い直しも下限が 0.6 以上。つまり
   「自動で見送り（確信度 0.60 未満）」の層が最初から空で、
   3分割のうち1本が死んでいた。完了画面はずっと 0 件と表示していた。

   さらに向きも逆だった。間が長いほど自動でカットする式だったため、
   オチの後や話題転換前など**意図して置いた間ほど黙って切られ**、
   息継ぎのような安全に詰められる間が人間に回っていた。

   どちらも「動くが間違っている」種類なので、実行しても気づけない。
   数字で縛る。

実行: python scripts/test_cut_confidence.py
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _console import enable_utf8  # noqa: E402

from sidecar.cut import DEFAULTS, PRESETS, REVIEW_BAND, _silence_confidence  # noqa: E402

failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failed
    if not ok:
        failed += 1
    print(f"[cut-conf] {'OK  ' if ok else 'NG  '} {name}")
    if detail:
        print(f"          {detail}")


def where(conf: float) -> str:
    if conf >= REVIEW_BAND["high"]:
        return "auto-cut"
    if conf < REVIEW_BAND["low"]:
        return "auto-skip"
    return "human"


def main() -> int:
    enable_utf8()
    opts = {**DEFAULTS, **PRESETS["talk"]}
    mid = "ですよ"      # 文中
    end = "です。"      # 文末直後

    # ── 向き ──────────────────────────────────────────
    breath = _silence_confidence(1.0, mid, opts)
    long_pause = _silence_confidence(3.0, mid, opts)
    check(
        "息継ぎの間は、長い間より確信度が高い",
        breath > long_pause,
        f"1.0秒 {breath:.2f} > 3.0秒 {long_pause:.2f}",
    )
    check("息継ぎの間は自動でカットになる", where(breath) == "auto-cut", f"{breath:.2f}")
    check(
        "3秒の間は自動でカットしない",
        where(long_pause) != "auto-cut",
        f"{long_pause:.2f} → {where(long_pause)}",
    )

    # ── 文末 ──────────────────────────────────────────
    at_end = _silence_confidence(1.0, end, opts)
    check(
        "文末直後の間は、文中より確信度が低い",
        at_end < breath,
        f"文末 {at_end:.2f} < 文中 {breath:.2f}",
    )
    check("文末直後の間は人間に回る", where(at_end) == "human", f"{at_end:.2f}")

    # ── 3分割が全部使われるか ──────────────────────────
    seen = {where(_silence_confidence(g, t, opts))
            for g in (0.8, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0)
            for t in (mid, end)}
    check(
        "自動でカット / 人が確認 / 自動で見送り の3つが全部出る",
        seen == {"auto-cut", "human", "auto-skip"},
        f"出た区分: {sorted(seen)}",
    )

    # ── 件数の配分 ────────────────────────────────────
    # 20分のトークに現れる「間」の分布を対数正規で近似して、
    # 人が1件ずつ見る件数が現実的な範囲に収まるかを見る。
    random.seed(7)
    gaps: list[tuple[float, bool]] = []
    while len(gaps) < 118:
        g = random.lognormvariate(-0.15, 0.55)
        if g < 0.79:
            continue
        gaps.append((g, random.random() < 0.30))

    counts = {"auto-cut": 0, "human": 0, "auto-skip": 0}
    for g, is_end in gaps:
        counts[where(_silence_confidence(g, end if is_end else mid, opts))] += 1

    check(
        "人が1件ずつ見る件数が、候補の半分以下に収まる",
        counts["human"] <= len(gaps) // 2,
        f"候補{len(gaps)}件 → 自動でカット{counts['auto-cut']} / "
        f"人が確認{counts['human']} / 自動で見送り{counts['auto-skip']}",
    )
    check("自動で見送りが実際に発生する", counts["auto-skip"] > 0)

    # ── プリセット ────────────────────────────────────
    for name in PRESETS:
        p = {**DEFAULTS, **PRESETS[name]}
        vals = [_silence_confidence(g, mid, p) for g in (0.5, 1.0, 2.0, 4.0)]
        check(
            f"プリセット {name} でも 0〜1 の範囲に収まる",
            all(0.0 <= v <= 1.0 for v in vals),
            " / ".join(f"{v:.2f}" for v in vals),
        )

    print()
    print("test-cut-confidence: OK" if failed == 0 else f"test-cut-confidence: {failed} 件失敗")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
