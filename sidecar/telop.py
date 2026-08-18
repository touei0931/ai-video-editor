"""テロップ候補の生成（②自動文字起こし・テロップ入れ）。

文字起こし結果 → 表示単位への分割 → スタイル判定、までをここで行う。
**改行位置と描画はここではやらない**。それは Canvas 側（src/telop/*）の仕事で、
実際の描画幅を測らないと正しい改行位置が決まらないため（§6.6）。

🔴 このモジュールは「承認されたカット」を受け取る。
   テロップはカットの**あと**に作らないと、切った箇所の言葉が残る。
   例: 「これ、これがですね」の1つ目を切ったのに
   テロップは「これこれがですね」のまま、という事故が起きる。

座標系（§11.2）:
   ここが返すのは**すべて元素材のタイムコード（src_*）**。
   編集後タイムラインへの変換は書き出し時にだけ行う。
"""

from __future__ import annotations

import re
from typing import Any

# ── 表示単位の分割条件 ────────────────────────────────────
DEFAULTS = {
    # 保険としての上限（全角換算）。句読点も間も無いまま喋り続けたときだけ効く。
    #
    # 🔴 ここを「1画面に出す量」の上限にしてはいけない。
    #    文字数で機械的に切ると「これがめちゃく / ちゃかたくて」のように
    #    文節の途中で切れる。1画面ぶんへの分割は Canvas 側（src/telop/split.ts）が
    #    BudouX の文節境界と実測幅で行う。ここは文の区切りまでを担当する。
    "hard_max_chars": 40,
    # これより長く間が空いたら別のテロップにする
    "split_gap": 0.5,
    # 短すぎるテロップは読めないので、最低これだけ表示する
    "min_duration": 0.7,
    # 表示を終わらせるまでの余韻。次のテロップが来ればそちらが優先。
    "tail_padding": 0.15,
    # 平均よりこれ以上大きい声なら「強調」とみなす
    "loud_db": 4.0,
    # 単語の認識確度がこれ未満なら「要確認」として印を付ける
    "low_confidence": 0.6,
}

SENTENCE_END = "。．.！!？?"
SOFT_BREAK = "、，,"

# テロップに句読点は普通入れない。！？は感情を運ぶので残す。
_STRIP_PUNCT = re.compile(r"[、。，．]")

# ── スタイル判定の手がかり ────────────────────────────────
# 🔴 ここは暫定のルールベース。
#    設計上は LLM が発言内容と感情から判定する部分（§11.4）で、
#    classify() の入出力を変えずに中身だけ差し替えられるようにしてある。
EMPHASIS_WORDS = [
    "すごい", "すげー", "すげえ", "やばい", "やば", "めちゃくちゃ", "めっちゃ",
    "絶対", "最高", "マジ", "本当に", "ほんとに", "超", "一番", "絶対に",
    "驚", "ヤバ", "痛い", "無理", "ダメ", "だめ", "危ない", "注意",
]

NOTE_PREFIXES = [
    "つまり", "ちなみに", "ただし", "なお", "ようは", "要は", "実は",
    "補足", "ここで", "念のため", "参考", "ちなみ",
]

NOTE_MARKERS = ["※", "（", "(", "…つまり"]


def _display_len(text: str) -> float:
    """全角換算の長さ。半角英数は0.5文字として数える。"""
    return sum(0.5 if ord(c) < 0x3000 else 1.0 for c in text)


def _clean(text: str) -> str:
    return _STRIP_PUNCT.sub("", text).strip()


def _clean_word(text: str) -> str:
    """単語の掃除。**前後の空白は落とさない**。

    落とすと英単語が繋がってしまうのに加えて、
    「単語列を連結したもの = テロップ本文」という対応が崩れる。
    Canvas 側は文字位置から時刻を引くので、この対応が崩れると字幕がずれる。
    """
    return _STRIP_PUNCT.sub("", text)


# ── 音量 ─────────────────────────────────────────────────


class Loudness:
    """区間ごとの音量（dB）を返す。強調の判定に使う。

    文字だけでは「大声で言った」が拾えない。②の要件は
    「AIによる発言内容と感情の判断」なので、音の情報を落としてはいけない。
    """

    def __init__(self, samples: Any, rate: int) -> None:
        self._samples = samples
        self._rate = rate

    @classmethod
    def from_wav(cls, path: str) -> "Loudness | None":
        try:
            import wave

            with wave.open(path, "rb") as wav:
                if wav.getsampwidth() != 2:
                    return None
                rate = wav.getframerate()
                raw = wav.readframes(wav.getnframes())
        except Exception:  # noqa: BLE001
            return None

        try:
            import numpy as np

            samples = np.frombuffer(raw, dtype="<i2").astype("float32")
        except Exception:  # noqa: BLE001
            from array import array

            samples = array("h")
            samples.frombytes(raw)

        return cls(samples, rate)

    def db(self, start: float, end: float) -> float | None:
        a = max(0, int(start * self._rate))
        b = min(len(self._samples), int(end * self._rate))
        if b - a < 16:
            return None

        chunk = self._samples[a:b]
        try:
            import numpy as np

            if hasattr(chunk, "dtype"):
                rms = float(np.sqrt(np.mean(np.square(chunk))))
            else:
                raise TypeError
        except Exception:  # noqa: BLE001
            total = 0.0
            for v in chunk:
                total += float(v) * float(v)
            rms = (total / len(chunk)) ** 0.5

        if rms < 1e-6:
            return None
        import math

        return 20 * math.log10(rms / 32768.0)


# ── カット区間の適用 ──────────────────────────────────────


def _drop_cut_words(words: list[dict[str, Any]], cuts: list[tuple[float, float]]) -> list[dict[str, Any]]:
    """承認されたカットに入る単語を落とす。

    単語の中心がカット範囲に入っていれば落とす。
    端がわずかに重なっただけで落とすと、語頭・語尾が消えて文が壊れる。
    """
    if not cuts:
        return words

    merged: list[list[float]] = []
    for start, end in sorted(cuts):
        if merged and start <= merged[-1][1] + 0.001:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])

    kept: list[dict[str, Any]] = []
    for w in words:
        center = (w["src_start"] + w["src_end"]) / 2
        if any(start <= center <= end for start, end in merged):
            continue
        kept.append(w)
    return kept


# ── スタイル判定 ─────────────────────────────────────────


def classify(text: str, loud_delta: float | None, opts: dict[str, Any]) -> tuple[str, str]:
    """テロップのスタイルを決める。(スタイル名, 理由) を返す。

    理由を必ず返すのは、レビュー画面で「なぜ赤くなったのか」を出すため。
    判定を人間が直すとき、根拠が見えないと直しようがない。
    """
    if any(m in text for m in NOTE_MARKERS) or any(text.startswith(p) for p in NOTE_PREFIXES):
        return "note", "補足の言い回し"

    if "！" in text or "!" in text:
        return "emphasis", "感嘆符"

    hit = next((w for w in EMPHASIS_WORDS if w in text), None)
    if hit:
        return "emphasis", f"強調語「{hit}」"

    if loud_delta is not None and loud_delta >= opts["loud_db"]:
        return "emphasis", f"声が大きい（平均+{loud_delta:.1f}dB）"

    return "normal", ""


# ── 本体 ─────────────────────────────────────────────────


def build_units(
    transcript: dict[str, Any],
    cuts: list[tuple[float, float]] | None = None,
    wav_path: str | None = None,
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """文字起こし結果からテロップ候補を作る。"""
    opts = {**DEFAULTS, **(options or {})}

    words: list[dict[str, Any]] = []
    for seg in transcript.get("segments", []):
        for w in seg.get("words", []):
            if not w.get("text", "").strip():
                continue
            words.append({
                "text": w["text"],
                "src_start": float(w["src_start"]),
                "src_end": float(w["src_end"]),
                "probability": float(w.get("probability", 0)),
            })

    words = _drop_cut_words(words, cuts or [])
    if not words:
        return {"telops": [], "options": opts}

    # ── 文の区切りで分ける ──
    # 切ってよいのは「句読点」「間が空いた」「長すぎる」の3つだけ。
    # ここで作るのは意味のまとまりで、1画面に出す量ではない。
    groups: list[list[dict[str, Any]]] = []
    buf: list[dict[str, Any]] = []

    for i, w in enumerate(words):
        buf.append(w)
        raw = "".join(x["text"] for x in buf).strip()
        nxt = words[i + 1] if i + 1 < len(words) else None
        gap = (nxt["src_start"] - w["src_end"]) if nxt else float("inf")
        length = _display_len(_clean(raw))

        ends_sentence = raw[-1:] in SENTENCE_END
        # 読点は「そこで切れると自然」な位置。長くなってきたら使う。
        soft = raw[-1:] in SOFT_BREAK and length >= opts["hard_max_chars"] * 0.4

        if ends_sentence or soft or gap > opts["split_gap"] or nxt is None:
            groups.append(buf)
            buf = []
        elif length >= opts["hard_max_chars"]:
            groups.append(buf)
            buf = []

    if buf:
        groups.append(buf)

    loudness = Loudness.from_wav(wav_path) if wav_path else None

    # 平均音量。「大声かどうか」は絶対値ではなく素材内の相対で見る。
    levels: list[float] = []
    if loudness:
        for g in groups:
            db = loudness.db(g[0]["src_start"], g[-1]["src_end"])
            if db is not None:
                levels.append(db)
    baseline = sorted(levels)[len(levels) // 2] if levels else None

    telops: list[dict[str, Any]] = []
    for i, g in enumerate(groups):
        unit_words = [
            {
                "text": _clean_word(w["text"]),
                "src_start": round(w["src_start"], 3),
                "src_end": round(w["src_end"], 3),
            }
            for w in g
        ]
        unit_words = [w for w in unit_words if w["text"].strip()]
        # 🔴 本文は単語列の連結そのもの。加工してはいけない（_clean_word 参照）。
        text = "".join(w["text"] for w in unit_words)
        if not text.strip():
            continue

        start = g[0]["src_start"]
        end = g[-1]["src_end"]

        # 余韻を足す。ただし次のテロップに食い込ませない。
        next_start = groups[i + 1][0]["src_start"] if i + 1 < len(groups) else None
        end += opts["tail_padding"]
        if end - start < opts["min_duration"]:
            end = start + opts["min_duration"]
        if next_start is not None:
            end = min(end, next_start - 0.02)
        if end <= start:
            end = start + 0.2

        db = loudness.db(g[0]["src_start"], g[-1]["src_end"]) if loudness else None
        loud_delta = (db - baseline) if (db is not None and baseline is not None) else None

        style, reason = classify(text.strip(), loud_delta, opts)

        probs = [w["probability"] for w in g if w["probability"] > 0]
        confidence = min(probs) if probs else 1.0

        telops.append({
            "id": f"t{len(telops):04d}",
            "src_start": round(start, 3),
            "src_end": round(end, 3),
            "text": text,
            "style": style,
            "reason": reason,
            "position": "bottom",
            # 認識が怪しい箇所は、読まずに飛ばさず必ず目を通してほしい
            "needs_check": confidence < opts["low_confidence"],
            "confidence": round(confidence, 3),
            # 1画面ぶんへの再分割は Canvas 側が行う。
            # そのとき各画面の表示時刻を正確に出せるよう、単語の時刻をそのまま渡す。
            "words": unit_words,
        })

    return {
        "telops": telops,
        "options": opts,
        "baseline_db": round(baseline, 2) if baseline is not None else None,
    }
