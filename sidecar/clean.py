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
    # ── 復号に失敗した区間 ──
    #
    # 🔴 Whisper は avg_logprob が -1.0 を下回ると温度を上げてやり直すが、
    #    全部失敗しても**最後の結果をそのまま返す**。そのとき avg_logprob は
    #    -2 を大きく下回る（実例 -2.75）。人の声を普通に聞き取れた区間は
    #    悪くても -1.0 前後なので、ここまで低いのは「聞き取れなかった」の印。
    #    ゲーム音と歓声だけの 25 秒に「島上栗／島下通／島 上手」が並んだ
    #    （2026-09-11、VTuber のコラボ配信の切り抜き）。
    "decode_failed_logprob": -2.0,
    # 復号に失敗した区間でも、単語確度がこれ以上なら人の声とみなして残す
    "decode_failed_min_prob": 0.5,
    # 1文字あたりの秒数がこれ以上なら「声がまばら」。人の日本語は 0.1〜0.3 秒/文字。
    # 8秒の区間に3文字（2.7秒/文字）は、喋っていない時間に文字を当てはめた形
    "sparse_seconds_per_char": 1.0,
    # ── 似た出力の繰り返し ──
    #
    # 🔴 完全一致だけでは捕まらない。「島上栗 / 島下通 / 島 上手 / 島上栗」のように
    #    少しずつ変わりながら同じ文字を使い回す。文字の集合の重なりで見る。
    "similar_run": 3,
    "similar_overlap": 0.5,
    "similar_max_prob": 0.5,
}


def _normalize(text: str) -> str:
    return _NORMALIZE.sub("", text).strip().lower()


def _mean_prob(segment: dict[str, Any]) -> float:
    probs = [w.get("probability", 0.0) for w in segment.get("words", [])]
    probs = [p for p in probs if p > 0]
    return sum(probs) / len(probs) if probs else 0.0


def _seconds_per_char(segment: dict[str, Any]) -> float:
    """1文字あたりの秒数。文字が無ければ 0（別の規則で落ちる）。"""
    chars = len(_normalize(segment.get("text", "")))
    if chars == 0:
        return 0.0
    length = float(segment.get("src_end", 0)) - float(segment.get("src_start", 0))
    return max(0.0, length) / chars


def _char_overlap(a: str, b: str) -> float:
    """2つの文字列が使っている文字の重なり（Jaccard）。"""
    sa, sb = set(a), set(b)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


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

    # ── 似た出力の繰り返し ──
    #
    # 「島上栗 / 島下通 / 島 上手 / 島上栗 / 島上栗」のように、少しずつ変わりながら
    # 同じ文字を使い回す。隣どうしの文字の重なりで連なりを取り、
    # 連なり全体の確度が低ければ幻聴とみなす。
    # 🔴 確度で縛ること。「待て待て待て」×3 のような本物の連呼は確度が高い。
    start = 0
    for i in range(1, len(segments) + 1):
        similar = (
            i < len(segments)
            and _char_overlap(_normalize(segments[i]["text"]), _normalize(segments[i - 1]["text"]))
            >= opts["similar_overlap"]
        )
        if similar:
            continue
        run = i - start
        if run >= opts["similar_run"]:
            probs = [_mean_prob(segments[j]) for j in range(start, i)]
            if sum(probs) / len(probs) < opts["similar_max_prob"]:
                for j in range(start, i):
                    mark(j, "似た出力の繰り返し")
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

        # 復号に失敗した区間（Whisper が温度を上げてもだめだった30秒窓）。
        # 単語確度が高ければ声とみなして残し、低いか声がまばらなら落とす。
        logprob = seg.get("avg_logprob")
        if isinstance(logprob, (int, float)) and logprob <= opts["decode_failed_logprob"]:
            sparse = _seconds_per_char(seg) >= opts["sparse_seconds_per_char"]
            if mean < opts["decode_failed_min_prob"] or sparse:
                mark(i, "復号に失敗した区間")
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
