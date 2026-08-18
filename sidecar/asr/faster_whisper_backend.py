"""faster-whisper による文字起こし（Windows 側の実装）。

Mac 側は pywhispercpp + CoreML を使う（§7.2 / §8.2）。
バックエンドの選択は asr/__init__.py の make_asr() だけが知る。

精度設計は2パス（§9.2）:
  turbo で全体を処理し、低信頼度セグメントだけ large-v3 で再認識する。
  Phase 0 では1パスのみ実装し、2パスは Phase 2 で足す。
"""

from __future__ import annotations

import os
import sys
import time
from typing import Callable

# 単語レベルのタイムスタンプは①カットに必須（無音・フィラーの境界を出すため）
WORD_TIMESTAMPS = True

ProgressFn = Callable[[float, str], None]
CancelFn = Callable[[], bool]


class FasterWhisperAsr:
    """
    CUDA が使えれば使い、駄目なら CPU に落ちる。

    CTranslate2 は CUDA を使うのに cuBLAS / cuDNN の DLL を要求するが、
    NVIDIA GPU があってもこれらが入っているとは限らない
    （実際に `cublas64_12.dll is not found` で落ちた）。
    しかも失敗するのはモデル読み込み時ではなく**最初の推論時**なので、
    読み込みだけで判定してはいけない。
    """

    def __init__(self, device: str | None = None, compute_type: str | None = None) -> None:
        # ASR_DEVICE=cpu で CUDA を試さずに CPU 固定できる。
        # CUDA 環境の不備は切り分けが難しいので、逃げ道を用意しておく。
        self.requested_device = device or os.environ.get("ASR_DEVICE", "auto")
        self.compute_type = compute_type
        self._model = None
        self._model_name: str | None = None
        self.device: str | None = None

    def _build(self, model_name: str, device: str):
        from faster_whisper import WhisperModel

        compute = self.compute_type or ("float16" if device == "cuda" else "int8")
        model = WhisperModel(model_name, device=device, compute_type=compute)
        self._model = model
        self._model_name = model_name
        self.device = device
        return model

    def _load(self, model_name: str):
        # モデルは重いので使い回す。切り替わったときだけ読み直す。
        if self._model is not None and self._model_name == model_name:
            return self._model

        if self.requested_device in ("cpu", "cuda"):
            return self._build(model_name, self.requested_device)

        try:
            return self._build(model_name, "cuda")
        except Exception as e:  # noqa: BLE001
            print(f"asr: CUDA を使えないため CPU で動かします（{e}）", file=sys.stderr, flush=True)
            return self._build(model_name, "cpu")

    def _fallback_to_cpu(self, model_name: str, reason: str):
        print(f"asr: CUDA での推論に失敗したため CPU に切り替えます（{reason}）",
              file=sys.stderr, flush=True)
        self._model = None
        self._model_name = None
        return self._build(model_name, "cpu")

    def transcribe(
        self,
        audio_path: str,
        model: str = "large-v3-turbo",
        language: str = "ja",
        on_progress: ProgressFn | None = None,
        is_cancelled: CancelFn | None = None,
    ) -> dict:
        started = time.perf_counter()

        if on_progress:
            on_progress(0.0, f"モデルを読み込み中: {model}")
        whisper = self._load(model)
        load_seconds = time.perf_counter() - started

        if on_progress:
            on_progress(0.05, "文字起こし中")

        def start(model_obj):
            return model_obj.transcribe(
                audio_path,
                language=language,
                word_timestamps=WORD_TIMESTAMPS,
                vad_filter=False,  # VAD は Silero で別途かける（§11.1）
            )

        segments_iter, info = start(whisper)

        duration = info.duration or 0.0
        segments: list[dict] = []

        # faster-whisper は遅延評価なので、ここで初めて実際の推論が走る。
        # 1セグメントずつ取り出せるため、進捗を出せるしキャンセルも効く。
        # CUDA の DLL 不足はこのタイミングで初めて露見するので、ここでも CPU に落とせるようにする。
        try:
            first = next(iter(segments_iter), None)
        except Exception as e:  # noqa: BLE001
            if self.device != "cpu":
                whisper = self._fallback_to_cpu(model, str(e))
                segments_iter, info = start(whisper)
                duration = info.duration or 0.0
                first = next(iter(segments_iter), None)
            else:
                raise

        def all_segments():
            if first is not None:
                yield first
            yield from segments_iter

        for seg in all_segments():
            if is_cancelled and is_cancelled():
                return {"cancelled": True, "segments": segments}

            segments.append({
                "id": f"s{len(segments):04d}",
                "src_start": round(seg.start, 3),
                "src_end": round(seg.end, 3),
                "text": seg.text.strip(),
                "avg_logprob": round(seg.avg_logprob, 4),
                "no_speech_prob": round(seg.no_speech_prob, 4),
                "words": [
                    {
                        "src_start": round(w.start, 3),
                        "src_end": round(w.end, 3),
                        "text": w.word,
                        "probability": round(w.probability, 4),
                    }
                    for w in (seg.words or [])
                ],
            })

            if on_progress and duration > 0:
                on_progress(min(0.99, 0.05 + 0.94 * (seg.end / duration)), "文字起こし中")

        elapsed = time.perf_counter() - started
        if on_progress:
            on_progress(1.0, "完了")

        return {
            "cancelled": False,
            "backend": "faster-whisper",
            "device": self.device,
            "model": model,
            "language": info.language,
            "duration": round(duration, 3),
            "load_seconds": round(load_seconds, 2),
            "elapsed_seconds": round(elapsed, 2),
            "realtime_factor": round(duration / elapsed, 2) if elapsed > 0 else None,
            "segments": segments,
        }
