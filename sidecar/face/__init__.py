"""顔検出 / 口唇ランドマーク — プラットフォーム差の閉じ込め先（§10.4）。

🔴 このファイルは「プラットフォーム分岐を書いてよい4ファイル」のひとつです。

🔴 Ultralytics YOLO は**使いません**（AGPL 汚染・§13.1）。MediaPipe を使います。

用途（③ズーム・画角）:
  - 話者追従の自動クロップ
  - 複数人時の話者アクティブ判定（口唇ランドマーク × 音声RMS の時系列相関・§7.3）

解析は 360p @ 3fps のプロキシに対して行う（§8.7①）。顔追従に元解像度は要らない。
"""

from __future__ import annotations

import sys
from typing import Protocol

_IS_MAC = sys.platform == "darwin"


class FaceDetector(Protocol):
    def detect(self, frame_path: str) -> list[dict]: ...


class _NotImplementedDetector:
    """Phase 0 のスタブ。実装は Phase 3。"""

    def __init__(self, delegate: str) -> None:
        self.delegate = delegate

    def detect(self, frame_path: str) -> list[dict]:
        raise NotImplementedError(f"顔検出は Phase 3 で実装します（delegate={self.delegate}）")


def make_detector() -> FaceDetector:
    """実行環境に応じた顔検出器を返す。Mac は Metal delegate で CPU を空ける。"""
    return _NotImplementedDetector("metal" if _IS_MAC else "gpu")


def describe_backend() -> str:
    """診断情報用（§10.5）。"""
    return "mediapipe+metal" if _IS_MAC else "mediapipe+gpu"
