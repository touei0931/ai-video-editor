"""幻聴（hallucination）の除去の検査。

🔴 守っていること:
   - 「島上栗 / 島下通 / 島 上手 / 島上栗 / 島上栗」のように、少しずつ変わりながら
     同じ文字を使い回す幻聴を落とす（完全一致の繰り返しだけでは捕まらない）。
     2026-09-11、VTuber のコラボ配信の切り抜きで、ゲーム音と歓声だけの
     25 秒にこれが並んでテロップになった。
   - Whisper が温度を上げてもだめだった窓（avg_logprob が -2 を大きく下回る）を落とす。
     ただし単語確度が高くて声が詰まっていれば残す。
   - 本物の連呼（「待て待て待て」×3、確度が高い）は落とさない。
   - 確度の低い「はい」は落とさない（needs_check で拾う。消えたものには気づけない）。

実行: python scripts/test_clean.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _console import enable_utf8  # noqa: E402

from sidecar.clean import clean_transcript  # noqa: E402

failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failed
    if not ok:
        failed += 1
    print(f"[clean] {'OK  ' if ok else 'NG  '} {name}")
    if detail:
        print(f"        {detail}")


def seg(start: float, end: float, text: str, probs: list[float], logprob: float = -0.6) -> dict:
    """1文字1語として組む（検査に要るのは確度と長さだけ）。"""
    chars = [c for c in text if c != " "]
    step = (end - start) / max(1, len(chars))
    words = [
        {"src_start": round(start + i * step, 3), "src_end": round(start + (i + 1) * step, 3),
         "text": c, "probability": probs[i % len(probs)]}
        for i, c in enumerate(chars)
    ]
    return {"src_start": start, "src_end": end, "text": text, "avg_logprob": logprob, "words": words}


def run(segments: list[dict]) -> tuple[list[str], dict]:
    t = {"duration": 100.0, "segments": segments}
    r = clean_transcript(t)
    return [s["text"] for s in t["segments"]], r


def main() -> int:
    enable_utf8()

    # ── 実例の形: ゲーム音だけの 25 秒に「島」が並ぶ ──
    kept, r = run([
        seg(22.1, 24.5, "ラミもここ1個だけ追いかけてくれたらいいよ", [0.9, 0.8]),
        seg(24.5, 25.6, "お尻だけが来るんだ", [0.7]),
        seg(30.5, 31.4, "島上栗", [0.0004, 0.09, 0.71], logprob=-2.75),
        seg(31.4, 32.18, "島下通", [0.93, 0.02, 0.0005], logprob=-2.75),
        seg(32.18, 40.36, "島 上手", [0.02, 0.04, 0.18], logprob=-2.75),
        seg(46.46, 51.84, "島上栗", [0.0006, 0.27, 0.6], logprob=-2.75),
        seg(51.84, 55.58, "島上栗", [0.99, 0.30, 0.71], logprob=-2.75),
        seg(55.58, 56.46, "左行ってね", [0.5]),
        seg(58.34, 59.44, "消した!消したよ", [0.7]),
    ])
    check("「島」の5つが全部落ちる", not any("島" in k for k in kept), str(kept))
    check("前後の本物の発話は残る", "お尻だけが来るんだ" in kept and "左行ってね" in kept, str(kept))
    check("落とした数は5", r["dropped"] == 5, str(r))
    check(
        "理由が2つに分かれて記録される（似た出力の繰り返し／復号に失敗した区間）",
        set(r["reasons"]) == {"似た出力の繰り返し", "復号に失敗した区間"},
        str(r["reasons"]),
    )

    # ── 本物の連呼は落とさない（確度が高い）──
    kept, _ = run([
        seg(15.3, 16.2, "待て待て待て!", [0.8, 0.7]),
        seg(16.4, 16.9, "待て待て!", [0.75]),
        seg(17.5, 18.2, "待て待て待て!", [0.7]),
        seg(18.2, 18.9, "待て待て待て待て!", [0.8]),
    ])
    check("確度の高い連呼は残る", len(kept) == 4, str(kept))

    # ── 完全一致の繰り返し（従来の規則）は今までどおり ──
    kept, _ = run([seg(i * 1.0, i * 1.0 + 0.8, "mr", [0.9]) for i in range(6)])
    check("同じ出力の繰り返しは従来どおり落ちる", kept == [], str(kept))

    # ── 復号に失敗した窓でも、声が詰まっていて確度が高ければ残す ──
    kept, _ = run([
        seg(10.0, 12.0, "面積で勝ってる!", [0.9, 0.8], logprob=-2.3),
        seg(12.5, 13.0, "はい!", [0.09], logprob=-1.0),
    ])
    check("復号に失敗した窓でも、確度が高くて声が詰まっていれば残る", "面積で勝ってる!" in kept, str(kept))
    check("確度の低い「はい」は残す（needs_check で拾う）", "はい!" in kept, str(kept))

    # ── 復号に失敗した窓で、声がまばら（8秒に3文字）なら確度が高くても落とす ──
    kept, _ = run([seg(30.0, 38.0, "島上栗", [0.9, 0.9, 0.9], logprob=-2.5)])
    check("復号に失敗した窓で声がまばらなら落ちる", kept == [], str(kept))

    # ── 似ていても確度が高ければ落とさない（歌詞のような繰り返し）──
    kept, _ = run([
        seg(0.0, 1.0, "ラララ", [0.9]),
        seg(1.0, 2.0, "ララ ラ", [0.9]),
        seg(2.0, 3.0, "ラララ", [0.9]),
    ])
    check("似た出力でも確度が高ければ残る", len(kept) == 3, str(kept))

    print()
    print("test-clean: OK" if failed == 0 else f"test-clean: {failed} 件失敗")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
