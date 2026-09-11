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

    # ── 息継ぎ ──
    #
    # 🔴 語の時刻の隙間で息継ぎを見ないこと。
    #    Whisper の語の時刻は**隣の語と隙間なく繋がる**。間は前の語の
    #    終わりに吸われるので、時刻だけ見ると間は「無い」ことになる
    #    （実素材で全語 0.00秒だった、2026-09-11）。
    #    音そのものを見て「声が止まっていた長さ」で決める。
    #
    # 息継ぎがあれば、そこは話し手が区切った所。長さに関わらず
    # 別の1枚にする（「今日は」「勉強しようと思います」）。
    # 🔴 0.2 では短すぎる。「使います」の「か」（無声子音）の落ち込みが
    #    0.18〜0.2秒あり、語の途中で割れた（実音声で確認、2026-09-11）。
    #    息継ぎは 0.3秒前後で、地の音まで落ちる。
    "breath_gap": 0.25,        # 声がこれだけ止まっていたら息継ぎ
    # Whisper が「、」を打った所は、それより短い止まりでも息継ぎとみなす。
    # 「、」は Whisper が間を聞いて打っているので、それ自体が手がかり。
    "breath_gap_soft": 0.08,
    # 声があるかどうかの線。区間の大きい音からこれだけ下がったら「止まっている」。
    # 🔴 浅くしないこと。12dB だと子音や語尾の弱い所まで「止まっている」に
    #    入る。息継ぎは地の音まで落ちるので、深めに取っても取りこぼさない
    "voice_drop_db": 20.0,

    # ── 「要確認」の判定 ──
    #
    # 🔴 単語確度の**最小値**で判定してはいけない。
    #    助詞ひとつの確度が低いだけで全部に印が付き、印が意味を失う。
    #    実測: 完全に正しい「これがめちゃくちゃ硬くて全然回らないんですよ」で
    #    最小 0.14。この基準だと 10 件中 9 件が「要確認」になった。
    #
    # 平均と「確度の低い語がどれだけ固まっているか」で見る。
    # 実測では、この基準でクリーンな素材は 0 件、
    # ゲーム音声では実際に誤っている 4 件だけが引っかかった。
    "low_word_prob": 0.5,      # この確度未満の語を「怪しい語」と数える
    "min_mean_prob": 0.7,      # 平均がこれ未満なら文全体が怪しい
    "low_word_ratio": 0.25,    # 怪しい語がこの割合以上
    "low_word_min": 3,         # かつ最低この語数（短い文で誤検出しないため）
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

    # ── 声の有無 ──
    #
    # 10ms ごとの音量（dB）を一度だけ作って持つ。語ごとに作り直すと
    # 数百語で数百回になり、遅い。
    #
    # 🔴 numpy を前提にしないこと。検査の環境には入っていないし、
    #    無いときに例外で止まると解析ごと落ちる（CI で踏んだ、2026-09-11）。
    #    あれば速く、無ければ素の Python で同じ値を出す。
    _FRAME = 0.010

    def _frames(self) -> list[float]:
        cached = getattr(self, "_db", None)
        if cached is not None:
            return cached
        import math

        n = int(self._rate * self._FRAME)
        x = self._samples
        count = len(x) // n if n > 0 else 0
        out: list[float] = []
        if count > 0:
            try:
                import numpy as np

                arr = x if hasattr(x, "dtype") else np.asarray(x, dtype="float32")
                frames = arr[: count * n].reshape(count, n).astype("float32")
                rms = np.sqrt(np.square(frames).mean(axis=1)) + 1e-9
                out = (20 * np.log10(rms / 32768.0)).tolist()
            except Exception:  # noqa: BLE001
                out = []
                for i in range(count):
                    total = 0.0
                    for v in x[i * n : (i + 1) * n]:
                        total += float(v) * float(v)
                    rms = (total / n) ** 0.5 + 1e-9
                    out.append(20 * math.log10(rms / 32768.0))
        self._db = out
        return out

    def voiced_span(
        self, start: float, end: float, ceiling_db: float, drop_db: float
    ) -> tuple[float, float] | None:
        """区間の中で、声が出ている最初と最後の時刻。

        ceiling_db（まわりの大きい音）から drop_db 下がったら「声が止まっている」
        とみなす。区間の中に声が無ければ None。
        """
        db = self._frames()
        if not db:
            return None
        # 🔴 終わりは含めない。+1 で1コマ足すと、次の語の最初のコマまで
        #    「この語の声」に数えてしまい、息継ぎが消える
        a = max(0, int(round(start / self._FRAME)))
        b = min(len(db), int(round(end / self._FRAME)))
        if b <= a:
            return None
        line = ceiling_db - drop_db
        voiced = [i for i in range(a, b) if db[i] > line]
        if not voiced:
            return None
        return (voiced[0] * self._FRAME, (voiced[-1] + 1) * self._FRAME)

    def ceiling(self, start: float, end: float, drop_db: float = 20.0) -> float | None:
        """区間の「大きい音」の目安（90 パーセンタイル）。

        🔴 区間の音量差が小さいとき（波の音など、常に鳴っている素材）は
           None を返す。声と地の音を分けられないので、無理に線を引くと
           息継ぎでない所で割れる。
        """
        db = self._frames()
        if not db:
            return None
        a = max(0, int(round(start / self._FRAME)))
        b = min(len(db), int(round(end / self._FRAME)))
        if b - a < 10:
            return None
        chunk = sorted(db[a:b])
        hi = chunk[int((len(chunk) - 1) * 0.9)]
        lo = chunk[int((len(chunk) - 1) * 0.1)]
        # 「止まっている」の線（hi - drop）より地の音が下にないと測れない
        return hi if hi - lo >= drop_db + 6.0 else None


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


def classify(
    text: str, loud_delta: float | None, opts: dict[str, Any]
) -> tuple[str, str, str | None]:
    """テロップの見せ方を決める。(スタイル名, 理由, 強調する語) を返す。

    理由を必ず返すのは、レビュー画面で「なぜ赤くなったのか」を出すため。
    判定を人間が直すとき、根拠が見えないと直しようがない。

    🔴 強調語が出てきても、文全体を赤くしてはいけない。
       日本語テロップの作法は「**その語だけ**を目立たせる」。
       文ごと書体まで変えると、テロップが1枚ごとに跳ねて読みにくくなるうえ、
       強調が「たまに出るから効く」という性質を失う。
       文全体を強調にするのは、叫んだとき（大きな声）だけにする。

    🔴 感嘆符だけで強調にしないこと。
       Whisper は叫び気味の配信では**ほぼ全部の文に「!」を付ける**。
       VTuber のコラボ配信の切り抜きで 34枚中ほぼ全部が強調になり、
       「ずっと強調表示されている」と言われた（2026-09-11）。
       強調は「その素材の中で声が大きい」で決める。感嘆符は、声が平均より
       少し大きい（半分の閾値）ときに背中を押す材料としてだけ使う。
       音量が測れない（wav が無い）ときだけ、感嘆符で決める。
    """
    if any(m in text for m in NOTE_MARKERS) or any(text.startswith(p) for p in NOTE_PREFIXES):
        return "note", "補足の言い回し", None

    shout = "！" in text or "!" in text
    if loud_delta is None:
        if shout:
            return "emphasis", "感嘆符", None
    else:
        if loud_delta >= opts["loud_db"]:
            return "emphasis", f"声が大きい（平均+{loud_delta:.1f}dB）", None
        if shout and loud_delta >= opts["loud_db"] * 0.5:
            return "emphasis", f"感嘆符と大きめの声（平均+{loud_delta:.1f}dB）", None

    # 語だけを目立たせる。長い語を優先する（「めちゃくちゃ」＞「めちゃ」）
    hits = [w for w in EMPHASIS_WORDS if w in text]
    if hits:
        word = max(hits, key=len)
        return "normal", f"強調語「{word}」", word

    return "normal", "", None


def _mark_breaths(
    words: list[dict[str, Any]],
    raw_words: list[dict[str, Any]],
    loudness: "Loudness | None",
    opts: dict[str, Any],
) -> None:
    """語のあとに息継ぎがあるか調べ、`break_after` を立てる。

    words は掃除済み（句読点なし）、raw_words は掃除前（「、」が残っている）。
    同じ並びで渡すこと。

    🔴 語の時刻の隙間だけで決めないこと（DEFAULTS の "breath_gap" 参照）。
       音が使えるなら、音で「声が止まっていた長さ」を測る。
       音が使えない（wav が無い、地の音が大きくて声と分けられない）ときは
       Whisper の「、」と、時刻の隙間があればそれを使う。
    """
    if len(words) < 2:
        return
    gap_hard = float(opts["breath_gap"])
    gap_soft = float(opts["breath_gap_soft"])
    drop = float(opts["voice_drop_db"])

    ceiling = None
    if loudness is not None:
        ceiling = loudness.ceiling(words[0]["src_start"], words[-1]["src_end"], drop)

    for i in range(len(words) - 1):
        w, nxt = words[i], words[i + 1]
        raw = (raw_words[i].get("text") or "").rstrip()
        has_comma = raw[-1:] in SOFT_BREAK

        # 時刻の隙間（Whisper がはっきり空けていればここに出る）
        gap = float(nxt["src_start"]) - float(w["src_end"])

        # 音で測った隙間。語の終わりから次の語の声が始まるまで
        if ceiling is not None:
            here = loudness.voiced_span(w["src_start"], w["src_end"], ceiling, drop)
            there = loudness.voiced_span(nxt["src_start"], nxt["src_end"], ceiling, drop)
            if here is not None and there is not None:
                gap = max(gap, there[0] - here[1])

        if gap >= gap_hard or (has_comma and (gap >= gap_soft or ceiling is None)):
            w["break_after"] = True


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
        # 息継ぎの印。掃除前の語（「、」つき）と並びを揃えて渡す
        raw_words = [w for w in g if _clean_word(w["text"]).strip()]
        _mark_breaths(unit_words, raw_words, loudness, opts)
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

        style, reason, highlight = classify(text.strip(), loud_delta, opts)

        probs = [w["probability"] for w in g if w["probability"] > 0]
        mean_prob = sum(probs) / len(probs) if probs else 1.0
        low_words = sum(1 for p in probs if p < opts["low_word_prob"])
        low_ratio = low_words / len(probs) if probs else 0.0

        needs_check = mean_prob < opts["min_mean_prob"] or (
            low_words >= opts["low_word_min"] and low_ratio >= opts["low_word_ratio"]
        )

        telops.append({
            "id": f"t{len(telops):04d}",
            "src_start": round(start, 3),
            "src_end": round(end, 3),
            "text": text,
            "style": style,
            "reason": reason,
            # 目立たせる語。位置は UI 側の雛形が持つのでここでは決めない
            "highlight": highlight,
            # 認識が怪しい箇所は、読まずに飛ばさず必ず目を通してほしい
            "needs_check": needs_check,
            "confidence": round(mean_prob, 3),
            "low_words": low_words,
            # 1画面ぶんへの再分割は Canvas 側が行う。
            # そのとき各画面の表示時刻を正確に出せるよう、単語の時刻をそのまま渡す。
            "words": unit_words,
        })

    return {
        "telops": telops,
        "options": opts,
        "baseline_db": round(baseline, 2) if baseline is not None else None,
    }
