"""文字起こし結果から幻聴（hallucination）を落とす。

🔴 Whisper は**音声が入っていない素材に対して、自信満々に嘘をつく**。

実例（ゲーム実況の無言クリップ）:
    無音確率 0.000 / 平均logprob -0.863 / text='mr'  ← これが11セグメント続く

no_speech_prob も avg_logprob も正常値を返すので、**その2つでは検出できない**。
使えるのは「同じ短い文字列が延々と続く」という出力の形そのもの。

ここで落とさないと、
  - カット候補が素材全体を覆って「全部カット」になる
  - テロップが「mrmrmrmr」で埋まる
という形で下流すべてが壊れる。
"""

from __future__ import annotations

import re
from typing import Any

# ひらがな・カタカナ・漢字・長音
_JA = re.compile(r"[ぁ-んァ-ヶ一-龥ー]")
_NORMALIZE = re.compile(r"[\s、。，．,.!！?？]+")

DEFAULTS = {
    # 同じ文字列がこれだけ連続したら、日本語であっても異常とみなす
    "repeat_run_any": 5,
    # 日本語を1文字も含まない出力なら、これだけ連続した時点で異常
    "repeat_run_non_ja": 3,
    # 単語確度の平均がこれ未満なら、単体でも捨てる。
    #
    # 🔴 ここは低めにしておくこと。
    #    「認識できた発話を黙って消す」のと「怪しいテロップが1枚残る」のでは、
    #    前者のほうがはるかに悪い。残ったものは1キーで消せるが、
    #    消えたものには**そもそも気づけない**。
    #    実際に確度 0.107 の「はい」を落として「声があるのにテロップが無い」と指摘された。
    #    確度の低いものは needs_check が付くので、確認画面で拾える。
    "min_mean_prob": 0.08,
    # 日本語を含まない短い出力は、これ未満の確度なら捨てる
    "non_ja_min_prob": 0.5,
    "non_ja_max_len": 4,
}


def _normalize(text: str) -> str:
    return _NORMALIZE.sub("", text).strip().lower()


def _mean_prob(segment: dict[str, Any]) -> float:
    probs = [w.get("probability", 0.0) for w in segment.get("words", [])]
    probs = [p for p in probs if p > 0]
    return sum(probs) / len(probs) if probs else 0.0


def clean_transcript(
    transcript: dict[str, Any], options: dict[str, Any] | None = None
) -> dict[str, Any]:
    """幻聴とみなしたセグメントを落とし、何を落としたかを返す。

    transcript は破壊的に更新する（segments を差し替える）。
    """
    opts = {**DEFAULTS, **(options or {})}
    segments: list[dict[str, Any]] = transcript.get("segments", [])
    if not segments:
        return {"kept": 0, "dropped": 0, "reasons": {}, "speech_seconds": 0.0, "speech_ratio": 0.0}

    drop = [False] * len(segments)
    reasons: dict[str, int] = {}

    def mark(i: int, reason: str) -> None:
        if not drop[i]:
            drop[i] = True
            reasons[reason] = reasons.get(reason, 0) + 1

    # ── 同じ出力の連続 ──
    # 幻聴は「同じ短い文字列を延々と繰り返す」形で出る。
    # 人間も「うん」を続けることはあるので、日本語を含む場合は基準を厳しくする。
    start = 0
    for i in range(1, len(segments) + 1):
        same = i < len(segments) and _normalize(segments[i]["text"]) == _normalize(segments[start]["text"])
        if same:
            continue

        run = i - start
        text = _normalize(segments[start]["text"])
        has_ja = bool(_JA.search(text))
        limit = opts["repeat_run_any"] if has_ja else opts["repeat_run_non_ja"]
        if text and run >= limit:
            for j in range(start, i):
                mark(j, "同じ出力の繰り返し")
        start = i

    # ── 単体で見て明らかに怪しいもの ──
    for i, seg in enumerate(segments):
        text = _normalize(seg["text"])
        if not text:
            mark(i, "空")
            continue

        mean = _mean_prob(seg)
        if mean and mean < opts["min_mean_prob"]:
            mark(i, "確度が極端に低い")
            continue

        # 日本語として文字起こししたのに日本語が1文字も無い短い出力。
        # "OK" のように正当な場合もあるので、確度が低いものだけ落とす。
        if not _JA.search(text) and len(text) <= opts["non_ja_max_len"] and mean < opts["non_ja_min_prob"]:
            mark(i, "日本語を含まない短い出力")

    kept = [seg for i, seg in enumerate(segments) if not drop[i]]
    transcript["segments"] = kept

    # 実際に喋っている時間。素材が「そもそも音声入りか」を判断するのに使う。
    speech = 0.0
    for seg in kept:
        words = seg.get("words", [])
        if words:
            speech += max(0.0, words[-1]["src_end"] - words[0]["src_start"])
        else:
            speech += max(0.0, seg["src_end"] - seg["src_start"])

    duration = float(transcript.get("duration") or 0)
    return {
        "kept": len(kept),
        "dropped": len(segments) - len(kept),
        "reasons": reasons,
        "speech_seconds": round(speech, 2),
        "speech_ratio": round(speech / duration, 3) if duration else 0.0,
    }
