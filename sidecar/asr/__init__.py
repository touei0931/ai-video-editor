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
    """Phase 0 のスタブ。実装は Phase 1（T4/T5 で疎通だけ確認する）。"""

    def __init__(self, backend: str) -> None:
        self.backend = backend

    def transcribe(self, audio_path: str, model: str = "large-v3-turbo") -> dict:
        raise NotImplementedError(
            f"ASR は Phase 1 で実装します（backend={self.backend}, model={model}）"
        )


def make_asr() -> Asr:
    """実行環境に応じた ASR バックエンドを返す。"""
    return _NotImplementedAsr("pywhispercpp+coreml" if _IS_MAC else "faster-whisper+cuda")


def describe_backend() -> str:
    """診断情報用（§10.5）。"""
    return "pywhispercpp+coreml" if _IS_MAC else "faster-whisper+cuda"
