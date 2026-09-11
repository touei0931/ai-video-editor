"""Qwen3-ASR による文字起こし。

日本語の自然な会話で最も誤りが少ないモデル（2026-02〜05 の公開ベンチマークで
CER 0.140。whisper-large-v3-turbo は 0.184、kotoba-whisper は 0.495）。

🔴 動かし方はプラットフォームで違う。呼び出し側はこのクラスしか見ない。
   - Windows / Linux: qwen-asr（torch。CUDA が要る）
   - Mac:             mlx-qwen3-asr（Apple の GPU。torch 不要）
   語の時刻は、別の「整列モデル（Qwen3-ForcedAligner-0.6B）」が出す。
   Whisper と違って**語と語の間が時刻に出る**ので、息継ぎが時刻から分かる。

🔴 出力の形は faster_whisper_backend と同じにすること（segments / words）。
   後段（clean / cut / telop）はどちらのバックエンドか知らない。
   - avg_logprob / no_speech_prob は出ないので 0.0 を入れる
     （clean.py は -2.0 以下の窓を落とす判定に使う。0.0 なら落とさない）
   - 語の確度も出ないので 1.0（「要確認」は付かなくなる）

🔴 長い音声は自分で区切って渡すこと。
   一度に渡すと進み具合が出せず、途中で止められない。整列モデルは
   一度に 5分までなので、それより短い区切りにする。区切る位置は
   固定の秒数ではなく、その付近で**いちばん静かな所**を選ぶ（語の途中で切らない）。
"""

from __future__ import annotations

import sys
import time
import wave
from typing import Any, Callable

ProgressFn = Callable[[float, str], None]
CancelFn = Callable[[], bool]

#: 画面に出す名前 → 本家の識別子
MODELS = {
    "qwen3-asr-1.7b": "Qwen/Qwen3-ASR-1.7B",
    "qwen3-asr-0.6b": "Qwen/Qwen3-ASR-0.6B",
}
ALIGNER = "Qwen/Qwen3-ForcedAligner-0.6B"

#: 一度にモデルへ渡す長さ（秒）と、区切りを探す幅
CHUNK_SECONDS = 90.0
CHUNK_SEARCH = 15.0

#: 文の終わり。ここで segment を切る
SENTENCE_END = "。！？!?"
#: 語に付け直す句読点
PUNCT = "、。，．！？!?"

#: segment を切る間の長さ（秒）。文末が無くてもこれだけ空けば別の segment
SEGMENT_GAP = 1.0

_LANG = {"ja": "Japanese", "en": "English", "zh": "Chinese", "ko": "Korean"}


def is_qwen_model(model: str) -> bool:
    return model in MODELS


def _read_wav(path: str) -> tuple[Any, int]:
    """16bit PCM の wav を float32 のモノラルで読む。"""
    import numpy as np

    with wave.open(path, "rb") as w:
        rate = w.getframerate()
        ch = w.getnchannels()
        if w.getsampwidth() != 2:
            raise ValueError("16bit の wav だけ受け付けます")
        raw = w.readframes(w.getnframes())
    x = np.frombuffer(raw, dtype="<i2").astype("float32") / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return x, rate


def chunk_bounds(samples: Any, rate: int, chunk_sec: float = CHUNK_SECONDS,
                 search_sec: float = CHUNK_SEARCH) -> list[tuple[int, int]]:
    """区切る位置（サンプル番号）。目標の付近でいちばん静かな 100ms を選ぶ。"""
    import numpy as np

    n = len(samples)
    if n <= int(chunk_sec * rate):
        return [(0, n)]
    frame = max(1, int(rate * 0.1))
    count = n // frame
    energy = np.square(samples[: count * frame].reshape(count, frame)).mean(axis=1)

    bounds: list[tuple[int, int]] = []
    start = 0
    while n - start > int(chunk_sec * rate):
        target = start + int(chunk_sec * rate)
        lo = max(start + int(rate), target - int(search_sec * rate)) // frame
        hi = min(count - 1, (target + int(search_sec * rate)) // frame)
        cut = (lo + int(np.argmin(energy[lo:hi + 1]))) * frame if hi > lo else target
        bounds.append((start, cut))
        start = cut
    bounds.append((start, n))
    return bounds


def attach_punctuation(text: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """整列モデルは句読点を語に含めない。本文から句読点を拾って、直前の語に付ける。

    Whisper は「ですね、」のように語の末尾に句読点を持つ。後段の telop.py は
    それを見て息継ぎ（「、」）や文末を判断するので、同じ形にそろえる。
    """
    out = [dict(it) for it in items]
    pos = 0
    for it in out:
        word = it["text"]
        idx = text.find(word, pos)
        if idx < 0:
            continue
        pos = idx + len(word)
        tail = ""
        while pos < len(text) and text[pos] in PUNCT:
            tail += text[pos]
            pos += 1
        if tail:
            it["text"] = word + tail
    return out


def to_segments(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """語の並びを、文末と長い間で segment に分ける。"""
    segments: list[dict[str, Any]] = []
    buf: list[dict[str, Any]] = []

    def flush() -> None:
        if not buf:
            return
        segments.append({
            "src_start": round(buf[0]["src_start"], 3),
            "src_end": round(buf[-1]["src_end"], 3),
            "text": "".join(w["text"] for w in buf),
            "avg_logprob": 0.0,
            "no_speech_prob": 0.0,
            "words": list(buf),
        })
        buf.clear()

    for i, w in enumerate(words):
        buf.append(w)
        nxt = words[i + 1] if i + 1 < len(words) else None
        ends = w["text"].rstrip()[-1:] in SENTENCE_END
        gap = (nxt["src_start"] - w["src_end"]) if nxt else 0.0
        if ends or gap >= SEGMENT_GAP or nxt is None:
            flush()
    return segments


class QwenAsr:
    def __init__(self) -> None:
        self._engine: Any = None
        self._engine_model: str | None = None
        self.device = "mlx" if sys.platform == "darwin" else "cuda"
        self.backend = "mlx-qwen3-asr" if sys.platform == "darwin" else "qwen-asr"

    # ── モデルの読み込み ──

    def _load(self, model: str) -> Any:
        repo = MODELS[model]
        if self._engine is not None and self._engine_model == model:
            return self._engine
        if sys.platform == "darwin":
            from mlx_qwen3_asr import Session

            self._engine = Session(model=repo)
        else:
            import torch
            from qwen_asr import Qwen3ASRModel

            if not torch.cuda.is_available():
                raise RuntimeError(
                    "Qwen3-ASR は NVIDIA の GPU（CUDA）が要ります。"
                    "無い場合は「高い（large-v3-turbo）」を選んでください"
                )
            self._engine = Qwen3ASRModel.from_pretrained(
                repo, dtype=torch.bfloat16, device_map="cuda:0",
                forced_aligner=ALIGNER,
                forced_aligner_kwargs=dict(dtype=torch.bfloat16, device_map="cuda:0"),
            )
        self._engine_model = model
        return self._engine

    # ── 1区切りぶん ──

    def _run_chunk(self, engine: Any, samples: Any, rate: int, language: str) -> tuple[str, list[dict[str, Any]]]:
        """(本文, 語の並び[{text, src_start, src_end}]) を返す。時刻は区切りの先頭から。"""
        lang = _LANG.get(language, "Japanese")
        if sys.platform == "darwin":
            r = engine.transcribe((samples, rate), language=lang, return_timestamps=True)
            items = [{"text": s["text"], "src_start": float(s["start"]), "src_end": float(s["end"])}
                     for s in (r.segments or [])]
            return r.text, items
        r = engine.transcribe((samples, rate), language=lang, return_time_stamps=True)[0]
        items = [{"text": it.text, "src_start": float(it.start_time), "src_end": float(it.end_time)}
                 for it in (r.time_stamps or [])]
        return r.text, items

    # ── 本体 ──

    def transcribe(
        self,
        audio_path: str,
        model: str = "qwen3-asr-1.7b",
        language: str = "ja",
        on_progress: ProgressFn | None = None,
        is_cancelled: CancelFn | None = None,
    ) -> dict:
        started = time.perf_counter()
        if on_progress:
            on_progress(0.0, f"モデルを準備中: {model}（初回のみダウンロードします）")
        engine = self._load(model)
        load_seconds = time.perf_counter() - started

        samples, rate = _read_wav(audio_path)
        duration = len(samples) / rate
        bounds = chunk_bounds(samples, rate)

        if on_progress:
            on_progress(0.05, "文字起こし中")

        segments: list[dict[str, Any]] = []
        for a, b in bounds:
            if is_cancelled and is_cancelled():
                return {"cancelled": True, "segments": segments}
            text, items = self._run_chunk(engine, samples[a:b], rate, language)
            offset = a / rate
            words = attach_punctuation(text, items)
            for w in words:
                w["src_start"] = round(w["src_start"] + offset, 3)
                w["src_end"] = round(w["src_end"] + offset, 3)
                w["probability"] = 1.0
            for seg in to_segments(words):
                seg["id"] = f"s{len(segments):04d}"
                segments.append(seg)
            if on_progress and duration > 0:
                on_progress(min(0.99, 0.05 + 0.94 * (b / rate / duration)), "文字起こし中")

        elapsed = time.perf_counter() - started
        if on_progress:
            on_progress(1.0, "完了")
        return {
            "cancelled": False,
            "backend": self.backend,
            "device": self.device,
            "model": model,
            "language": language,
            "duration": round(duration, 3),
            "load_seconds": round(load_seconds, 2),
            "elapsed_seconds": round(elapsed, 2),
            "realtime_factor": round(duration / elapsed, 2) if elapsed > 0 else None,
            "segments": segments,
        }
