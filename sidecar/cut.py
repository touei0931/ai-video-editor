"""カット候補の検出（①カット）。

Whisper の**単語レベルのタイムスタンプ**から直接求める。
別途 VAD をかけなくても、単語と単語の間隔がそのまま「無音」になる。
Phase 1 の入口としてはこれで十分な精度が出る（足りなければ Silero VAD を足す）。

設計レポート §11.1「決定論とLLMの責務分割」に沿って、ここは**すべて決定論**。
LLM に投げるのは、この後の「言い直しかどうか」のようなグレーな判断だけにする。
"""

from __future__ import annotations

import re
from typing import Any

# 日本語のフィラー。前後が独立した語として現れたときだけ落とす。
FILLERS = [
    "えー", "えーと", "えっと", "えと", "あの", "あのー", "その", "そのー",
    "まあ", "まぁ", "なんか", "ええと", "うーん", "んー", "はい、はい",
]

# 判定に使う既定値。style_profile.yaml で友達の好みに合わせて上書きする想定（§12）
DEFAULTS = {
    # これより長い無音をカット候補にする
    "min_silence": 0.35,
    # カット後に前後へ残す余白。ここを0にすると詰まりすぎて聞き苦しくなる
    "keep_padding": 0.08,
    # これ以上長い無音は、確信度を上げる（明らかに切ってよい）
    "confident_silence": 0.8,
    # 動画の末尾の無音は文脈が無いので確信度を下げない
    "trim_tail": True,
}


def _normalize(text: str) -> str:
    return re.sub(r"[、。,.\s]", "", text)


def _is_filler(word: str) -> bool:
    w = _normalize(word)
    return w in {_normalize(f) for f in FILLERS}


def detect_candidates(transcript: dict[str, Any], options: dict[str, Any] | None = None) -> dict[str, Any]:
    """文字起こし結果からカット候補を作る。

    戻り値は analysis.json にそのまま入る形。
    **元素材のタイムコード（src_*）だけを持つ**。編集後タイムラインの座標は
    ここでは一切扱わない（§11.2 二重座標系の分離）。
    """
    opts = {**DEFAULTS, **(options or {})}
    segments = transcript.get("segments", [])
    duration = float(transcript.get("duration") or 0)

    # 全単語を時系列に並べる
    words: list[dict[str, Any]] = []
    for seg in segments:
        for w in seg.get("words", []):
            if not w.get("text", "").strip():
                continue
            words.append({
                "text": w["text"],
                "src_start": float(w["src_start"]),
                "src_end": float(w["src_end"]),
                "probability": float(w.get("probability", 0)),
                "segment_id": seg["id"],
            })

    candidates: list[dict[str, Any]] = []

    def add(kind: str, start: float, end: float, confidence: float, **extra: Any) -> None:
        if end - start <= 0.01:
            return
        candidates.append({
            "id": f"c{len(candidates):04d}",
            "kind": kind,
            "src_start": round(start, 3),
            "src_end": round(end, 3),
            "confidence": round(min(0.99, max(0.05, confidence)), 2),
            **extra,
        })

    # ── 無音 ──────────────────────────────────────────────
    # 単語間のギャップ。冒頭と末尾も対象にする。
    prev_end = 0.0
    for i, w in enumerate(words):
        gap = w["src_start"] - prev_end
        if gap > opts["min_silence"]:
            pad = opts["keep_padding"]
            start = prev_end + pad
            end = w["src_start"] - pad
            # 長い無音ほど「切ってよい」と言い切れる
            confidence = 0.6 + min(0.35, (gap - opts["min_silence"]) * 0.4)
            add(
                "silence",
                start,
                end,
                confidence,
                before="".join(x["text"] for x in words[max(0, i - 6):i]).strip(),
                after="".join(x["text"] for x in words[i:i + 6]).strip(),
                gap=round(gap, 3),
            )
        prev_end = max(prev_end, w["src_end"])

    if duration and duration - prev_end > opts["min_silence"]:
        add(
            "silence",
            prev_end + opts["keep_padding"],
            duration,
            0.9,
            before="".join(x["text"] for x in words[-6:]).strip(),
            after="",
            gap=round(duration - prev_end, 3),
        )

    # ── フィラー ──────────────────────────────────────────
    for i, w in enumerate(words):
        if not _is_filler(w["text"]):
            continue
        add(
            "filler",
            w["src_start"],
            w["src_end"],
            # 認識の確からしさをそのまま反映する
            0.6 + w["probability"] * 0.35,
            word=w["text"].strip(),
            before="".join(x["text"] for x in words[max(0, i - 5):i]).strip(),
            after="".join(x["text"] for x in words[i + 1:i + 6]).strip(),
        )

    # ── 言い直し（同じ語の繰り返し）────────────────────────
    # 「これ、これが」のように、短い間隔で同じ語が続く場合。
    # 本格的な判定は LLM に渡す（§11.4）。ここでは明らかなものだけ拾う。
    for i in range(1, len(words)):
        a, b = words[i - 1], words[i]
        if _normalize(a["text"]) and _normalize(a["text"]) == _normalize(b["text"]):
            if b["src_start"] - a["src_end"] < 0.6:
                add(
                    "restate",
                    a["src_start"],
                    a["src_end"],
                    0.55,
                    word=a["text"].strip(),
                    before="".join(x["text"] for x in words[max(0, i - 5):i - 1]).strip(),
                    after="".join(x["text"] for x in words[i:i + 5]).strip(),
                )

    candidates.sort(key=lambda c: c["src_start"])
    for i, c in enumerate(candidates):
        c["id"] = f"c{i:04d}"

    return {
        "duration": duration,
        "word_count": len(words),
        "candidates": candidates,
        "options": opts,
    }


def keep_ranges(duration: float, cuts: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """カット区間から「残す区間」を求める。

    重なりや隣接をまとめてから反転する。ここを雑にやると、
    書き出し時に区間が重なって音がダブる。
    """
    if not cuts:
        return [(0.0, duration)]

    merged: list[list[float]] = []
    for start, end in sorted(cuts):
        if merged and start <= merged[-1][1] + 0.001:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])

    keeps: list[tuple[float, float]] = []
    cursor = 0.0
    for start, end in merged:
        if start - cursor > 0.02:
            keeps.append((round(cursor, 3), round(start, 3)))
        cursor = max(cursor, end)

    if duration - cursor > 0.02:
        keeps.append((round(cursor, 3), round(duration, 3)))

    return keeps
