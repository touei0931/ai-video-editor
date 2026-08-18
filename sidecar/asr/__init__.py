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

import os
import sys
from pathlib import Path
from typing import Protocol

_IS_MAC = sys.platform == "darwin"
_IS_WINDOWS = sys.platform == "win32"


def _enable_cuda_libraries() -> list[str]:
    """CUDA の DLL を見つけられるようにする（Windows）。

    🔴 CTranslate2 は CUDA を使うのに cuBLAS と cuDNN の DLL を要求するが、
       NVIDIA GPU があってもこれらが入っているとは限らないし、
       pip で入れても**既定の DLL 探索パスには入らない**。
       その結果 `cublas64_12.dll is not found` で静かに CPU に落ちる。
       CPU に落ちると large-v3-turbo は実用にならない速度になるので、
       「気づかず遅い」が一番まずい。

    pip の nvidia-* パッケージが入っていればその bin を探索対象に加える。
    無ければ何もしない（CPU で動く）。

    CTranslate2 4.5 以降は cuDNN 9 が必要。
    """
    if not _IS_WINDOWS:
        return []

    added: list[str] = []
    try:
        import nvidia  # noqa: F401
    except ImportError:
        return added

    for base in getattr(sys.modules["nvidia"], "__path__", []):
        for sub in ("cublas", "cudnn", "cuda_nvrtc"):
            for leaf in ("bin", "lib"):
                path = Path(base) / sub / leaf
                if not path.is_dir():
                    continue
                try:
                    os.add_dll_directory(str(path))
                    added.append(str(path))
                except OSError:
                    pass

    # ctranslate2 は LoadLibrary を素の名前で呼ぶ経路もあるので PATH にも通す
    if added:
        os.environ["PATH"] = os.pathsep.join(added) + os.pathsep + os.environ.get("PATH", "")
    return added


CUDA_LIB_DIRS = _enable_cuda_libraries()


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

    Mac も当面 faster-whisper（CPU）を使う。
    faster-whisper は Apple Silicon でも動くので、**まず動く状態を作れる**。
    pywhispercpp + CoreML/ANE への移行は「動くための前提」ではなく
    **高速化とファンレス対策**（§8.2）として後から入れる。
    こうしておくと、CoreML のビルドで詰まってもプロジェクトが止まらない。
    """
    from .faster_whisper_backend import FasterWhisperAsr

    if _IS_MAC:
        # Apple Silicon では CUDA を探しに行かせない
        return FasterWhisperAsr(device="cpu")

    return FasterWhisperAsr()


def describe_backend() -> str:
    """診断情報用（§10.5）。"""
    if _IS_MAC:
        return "faster-whisper+cpu"
    return f"faster-whisper+cuda(libs={len(CUDA_LIB_DIRS)})"
