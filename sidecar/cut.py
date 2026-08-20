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
    # 言い直しとみなす繰り返しの最大語数
    "restate_max_words": 4,
    # 繰り返しの間がこれより空いていれば、言い直しではなく別の発言とみなす
    "restate_max_gap": 1.2,
    # 繰り返しとみなす最小の文字数
    "restate_min_chars": 2,
    # これより短くしかならないカットは候補にしない。
    # 0.2秒詰めるためにジャンプカットを1つ増やすのは割に合わない。
    "min_gain": 0.3,
}

#: 素材の種類で「間」の扱いはまるで違う。
#:
#: 🔴 解説・実況を既定にすること。
#:    ショート向けの詰めた設定を長尺に当てると、
#:    話の切れ目に**意図して置いた間まで全部消える**。
#:    間は編集で作るものであって、機械的に消すものではない。
#: 🔴 confident_silence は「息継ぎとして自然な間の上限」。
#:    ここまでは詰めてよいものとして扱い、超えたら人間に見せる方向へ寄せる
#:    （_silence_confidence 参照）。以前は「これを超えたら自動カット」という
#:    逆の意味で使っていた。
PRESETS: dict[str, dict[str, Any]] = {
    # ゆったり：間を大きく残す。落ち着いた解説向け
    "loose": {
        "min_silence": 0.55,
        "keep_padding": 0.3,
        "confident_silence": 1.0,
        "min_gain": 0.45,
    },
    # 10〜20分の解説・実況。既定
    "talk": {
        "min_silence": 0.45,
        "keep_padding": 0.22,
        "confident_silence": 1.4,
        "min_gain": 0.35,
    },
    # ショート動画。テンポ優先で詰める
    "short": {
        "min_silence": 0.3,
        "keep_padding": 0.08,
        "confident_silence": 1.8,
        "min_gain": 0.2,
    },
    # とにかく詰める。間はほとんど残らない
    "tight": {
        "min_silence": 0.22,
        "keep_padding": 0.05,
        "confident_silence": 2.4,
        "min_gain": 0.12,
    },
}

#: 画面に出す並び。左ほど間を残し、右ほど詰まる。
PRESET_ORDER = ["loose", "talk", "short", "tight"]

# 確信度による3分割の境目（§3.3.1）。
# これ以上は自動承認、これ未満は自動却下、その間だけ人間が1件ずつ見る。
#
# 🔴 UI 側（ReviewScreen）と必ず同じ値を使うこと。
#    ずれると「レビュー対象なのにプレビューが無い候補」が出る。
#    そのため analysis.json に review_band として書き出し、UI はそれを読む。
REVIEW_BAND = {"low": 0.6, "high": 0.9}


def needs_review(candidate: dict[str, Any], band: dict[str, float] | None = None) -> bool:
    """人間が1件ずつ見る対象か。

    フィラーは確信度が一定以上なら一括処理するので、個別レビューには回さない。
    """
    b = band or REVIEW_BAND
    conf = candidate["confidence"]
    if candidate["kind"] == "filler" and conf >= b["low"]:
        return False
    return b["low"] <= conf < b["high"]


#: 文の終わりを示す記号。ここでの間は「意図して置いた間」であることが多い。
_SENTENCE_END = "。！？!?"


def _silence_confidence(gap: float, before: str, opts: dict[str, Any]) -> float:
    """無音カットの確信度。

    🔴 「間が長いほど自動でカット」にしてはいけない。

       以前は gap の単調増加で、confident_silence（既定1.5秒）を超えると
       自動カット（0.9）になっていた。しかしトークで1.5秒以上の間は、
       オチの後・話題転換前・強調前など**意図して置いた間**であることが多い。
       逆に 0.8〜1.2秒は息継ぎで、機械的に詰めて構わない。
       つまり「安全に切れるもの」を人間に見せ、
       「切ってはいけないもの」を黙って切っていた。

       しかも確信度が gap の関数でしかないので、
       画面の「確信度 0.82」は隣の「⟨1.32秒⟩」と同じことを言い換えているだけで、
       新しい情報を1ビットも運んでいなかった。

    そこで:
      - breath_max（息継ぎとして自然な上限）までは、そのまま詰めてよいものとして高くする
      - それを超えたら下げていく。長いほど「意図して置いた」可能性が上がる
      - 文末（。！？）の直後の間は、さらに下げる。話の区切りの可能性が高い

    🔴 下限を 0.6 未満まで届かせること。
       以前は式の下限が 0.6 だったため、**自動却下の層が構造上ずっと空**だった。
       3分割のうち1本が最初から死んでいて、完了画面の
       「自動で見送り（確信度0.60未満）」は永遠に 0 件と表示されていた。

    実測（talk プリセット / breath_max 1.4）:
        間      文中    → 行き先        文末直後 → 行き先
        0.8秒   0.92     自動でカット    0.77      人が確認
        1.2秒   0.95     自動でカット    0.80      人が確認
        2.0秒   0.83     人が確認        0.68      人が確認
        3.0秒   0.61     人が確認        0.46      自動で見送り
        4.0秒   0.39     自動で見送り    0.24      自動で見送り
    """
    peak = float(opts["confident_silence"])
    lo = float(opts["min_silence"])

    if gap <= peak:
        # 息継ぎの範囲。詰めても話の意味は変わらない
        span = max(0.01, peak - lo)
        conf = 0.92 + 0.04 * min(1.0, (gap - lo) / span)
    else:
        # 長い間は「意図して置いた」可能性が上がるので下げていく
        conf = 0.96 - min(0.6, (gap - peak) * 0.22)

    # 文末の直後は話の区切り。切ると流れが変わるので人間に見せたい
    if before and before[-1] in _SENTENCE_END:
        conf -= 0.15

    return max(0.2, min(0.97, conf))


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
    options = options or {}
    opts = {**DEFAULTS, **PRESETS.get(str(options.get("preset", "talk")), {}), **options}
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
            # 詰まる量がわずかなら、ジャンプカットを増やすだけ損
            if end - start < opts["min_gain"]:
                prev_end = max(prev_end, w["src_end"])
                continue
            before_text = "".join(x["text"] for x in words[max(0, i - 6):i]).strip()
            add(
                "silence",
                start,
                end,
                _silence_confidence(gap, before_text, opts),
                before=before_text,
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

    # ── 言い直し（同じ語句の繰り返し）──────────────────────
    #
    # 「これ、これがですね」「ここの、ここのボルト」のように、
    # 短い間隔で同じ語句が続く場合。最初の方を切る。
    #
    # 🔴 確信度は必ずレビュー対象の帯（0.6以上 0.9未満）に入れること。
    #    以前は 0.55 固定だったため**常に自動却下**され、
    #    検出しているのに結果に一切影響しない状態になっていた。
    #    言い直しは文脈がないと判断できないので、人間に見せるのが正しい。
    #
    # 本格的な判定は LLM に渡す（§11.4）。ここでは形の上で明らかなものだけ拾う。
    max_len = int(opts["restate_max_words"])
    used: set[int] = set()
    for n in range(max_len, 0, -1):
        for i in range(len(words) - 2 * n + 1):
            first = words[i:i + n]
            second = words[i + n:i + 2 * n]
            if any(j in used for j in range(i, i + 2 * n)):
                continue

            a = "".join(_normalize(w["text"]) for w in first)
            b = "".join(_normalize(w["text"]) for w in second)
            # 1文字の一致はただの偶然（Whisper は語をさらに細かく割る）。
            # 「す」が2回続いただけで言い直し扱いにすると誤検出だらけになる。
            if len(a) < opts["restate_min_chars"] or a != b:
                continue
            # 間が空きすぎていれば、繰り返しではなく別の発言
            if second[0]["src_start"] - first[-1]["src_end"] > opts["restate_max_gap"]:
                continue

            used.update(range(i, i + 2 * n))
            add(
                "restate",
                first[0]["src_start"],
                # 2つ目の語句の直前まで切る（間の「えー」なども一緒に消える）。
                # ここは無音ではなく発話を切るので、無音用の余白は使わない。
                # 使うと talk プリセット（余白0.22秒）では区間が消えてしまう。
                second[0]["src_start"] - 0.02,
                # 語数が多い繰り返しほど「言い直し」らしい
                0.62 + min(0.2, (n - 1) * 0.08),
                word=a,
                before="".join(x["text"] for x in words[max(0, i - 5):i]).strip(),
                after="".join(x["text"] for x in words[i + n:i + n + 6]).strip(),
            )

    candidates.sort(key=lambda c: c["src_start"])
    for i, c in enumerate(candidates):
        c["id"] = f"c{i:04d}"

    return {
        "duration": duration,
        "word_count": len(words),
        "candidates": candidates,
        "options": opts,
        "review_band": REVIEW_BAND,
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


def map_time_to_output(keeps: list[tuple[float, float]], t: float) -> float:
    """元素材の時刻を、編集後タイムラインの時刻に写す（§11.2）。

    🔴 二重座標系の変換はここだけで行う。
    テロップは元素材の時刻で作られるが、カットを適用すると時間が詰まるので、
    そのまま焼き込むと後半になるほど字幕がずれる。

    カットされた区間に落ちる時刻は、その手前の残存区間の終端に寄せる。
    """
    cursor = 0.0
    for start, end in keeps:
        if t < start:
            return round(cursor, 3)
        if t <= end:
            return round(cursor + (t - start), 3)
        cursor += end - start
    return round(cursor, 3)
