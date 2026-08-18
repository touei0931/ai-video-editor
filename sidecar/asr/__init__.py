"""ASR（文字起こし）バックエンド — プラットフォーム差の閉じ込め先（§10.4）。

🔴 このファイルは「プラットフォーム分岐を書いてよい4ファイル」のひとつです。
   呼び出し側は make_asr() が返すオブジェクトだけを見ること。

構成（§7.2）:
  - Windows: faster-whisper（CUDA）
  - Mac:     pywhispercpp + CoreML/Metal（ANE を使い CPU を空ける・§8.2）

精度設計は2パス（§9.2）:
  turbo で全体を処理し、低信頼度セグメントだけ large-v3 で再認識する。
"""

from __future__ import annotations

import sys
from typing import Protocol

_IS_MAC = sys.platform == "darwin"


class Asr(Protocol):
    """ASR バックエンドの共通インタフェース。"""

    def transcribe(self, audio_path: str, model: str = "large-v3-turbo") -> dict: ...


class _NotImplementedAsr:
    """まだ実装していないバックエンド用のスタブ。"""

    def __init__(self, backend: str) -> None:
        self.backend = backend

    def transcribe(self, audio_path: str, model: str = "large-v3-turbo", **kwargs) -> dict:
        raise NotImplementedError(
            f"{self.backend} はまだ実装していません（T5 で対応する）"
        )


def make_asr() -> Asr:
    """実行環境に応じた ASR バックエンドを返す。

    🔴 プラットフォーム分岐はここだけ。呼び出し側は戻り値の transcribe() しか見ない。
    """
    if _IS_MAC:
        # Mac は CPU を空けるため CoreML/ANE を使う（ファンレス対策・§8.2）。T5 で実装。
        return _NotImplementedAsr("pywhispercpp+coreml")

    from .faster_whisper_backend import FasterWhisperAsr

    return FasterWhisperAsr()


def describe_backend() -> str:
    """診断情報用（§10.5）。"""
    return "pywhispercpp+coreml" if _IS_MAC else "faster-whisper+cuda"
