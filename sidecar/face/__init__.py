"""顔検出 — プラットフォーム差の閉じ込め先（§10.4）。

🔴 このファイルは「プラットフォーム分岐を書いてよい4ファイル」のひとつです。

🔴 Ultralytics YOLO は**使いません**（AGPL 汚染・§13.1）。
   MediaPipe の BlazeFace（Apache-2.0）を使います。

用途（③ズーム・画角の自動化 = 引きと人物アップを自動で切り替える機能）:
  - 人物アップにするときの寄り先を決める
  - 複数人が映るときに、誰に寄るかを選ぶ

解析は 360p @ 3fps に落とした映像に対して行う（§8.7①）。
顔の位置を知るのに元解像度は要らないし、
20分素材を等倍で解析したら実用にならない。
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Protocol

_IS_MAC = sys.platform == "darwin"

MODEL_NAME = "blaze_face_short_range.tflite"


def model_path() -> Path:
    """同梱モデルの場所。scripts/fetch_models.py が置く。"""
    root = Path(__file__).resolve().parent.parent.parent
    candidate = root / "vendor" / "models" / MODEL_NAME
    if candidate.exists():
        return candidate

    # 配布時は実行ファイルの隣
    if getattr(sys, "frozen", False):
        packed = Path(sys.executable).parent / "models" / MODEL_NAME
        if packed.exists():
            return packed

    raise RuntimeError(
        f"顔検出モデルが見つかりません（{MODEL_NAME}）。"
        "python scripts/fetch_models.py を実行してください。"
    )


class FaceDetector(Protocol):
    """正規化座標（0〜1）で顔の矩形を返す。"""

    def detect(self, image: Any) -> list[dict[str, float]]: ...
    def close(self) -> None: ...


class _MediaPipeDetector:
    def __init__(self, delegate: str) -> None:
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision

        # GPU デリゲートは環境によって初期化に失敗する。
        # 失敗したら CPU に落とす（顔検出は CPU でも 360p なら十分速い）。
        base = None
        for want in ([delegate] if delegate != "cpu" else []) + ["cpu"]:
            try:
                base = mp_python.BaseOptions(
                    model_asset_path=str(model_path()),
                    delegate=(
                        mp_python.BaseOptions.Delegate.GPU
                        if want == "gpu"
                        else mp_python.BaseOptions.Delegate.CPU
                    ),
                )
                self._detector = vision.FaceDetector.create_from_options(
                    vision.FaceDetectorOptions(base_options=base, min_detection_confidence=0.4)
                )
                self.delegate = want
                return
            except Exception as e:  # noqa: BLE001
                print(f"face: {want} デリゲートを使えません（{e}）", file=sys.stderr, flush=True)
        raise RuntimeError("顔検出器を初期化できませんでした")

    def detect(self, image: Any) -> list[dict[str, float]]:
        """image は RGB の numpy 配列。"""
        import mediapipe as mp

        h, w = image.shape[:2]
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=image)
        result = self._detector.detect(mp_image)

        faces: list[dict[str, float]] = []
        for det in result.detections:
            box = det.bounding_box
            score = det.categories[0].score if det.categories else 0.0
            faces.append({
                "x": box.origin_x / w,
                "y": box.origin_y / h,
                "w": box.width / w,
                "h": box.height / h,
                "score": float(score),
            })
        return faces

    def close(self) -> None:
        try:
            self._detector.close()
        except Exception:  # noqa: BLE001
            pass


def make_detector() -> FaceDetector:
    """実行環境に応じた顔検出器を返す。

    🔴 プラットフォーム分岐はここだけ。呼び出し側は detect() しか見ない。

    Windows も Mac も CPU を使う。
    pip で配布される mediapipe は GPU デリゲートを含まずビルドされており
    （"GPU processing is disabled in build flags"）、
    どちらの環境でも結局 CPU に落ちる。
    毎回失敗のログを出させる意味がないので、最初から CPU にする。
    360p の顔検出なら CPU で十分間に合う（実測は framing.py のコメント参照）。
    """
    return _MediaPipeDetector("cpu")


def describe_backend() -> str:
    """診断情報用（§10.5）。"""
    return "mediapipe-blazeface+cpu(mac)" if _IS_MAC else "mediapipe-blazeface+cpu"
