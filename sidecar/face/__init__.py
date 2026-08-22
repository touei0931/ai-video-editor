"""顔検出 — プラットフォーム差の閉じ込め先（§10.4）。

🔴 このファイルは「プラットフォーム分岐を書いてよい4ファイル」のひとつです。

🔴 Ultralytics YOLO は**使いません**（AGPL 汚染・§13.1）。
   MediaPipe（Apache-2.0）を使います。

用途（③ズーム・画角の自動化 = 引きと人物アップを自動で切り替える機能）:
  - 人物アップにするときの寄り先を決める
  - 複数人が映るときに、**誰が喋っているか**を選ぶ

🔴 検出と口の計測で別のモデルを使う。
   実測（子どもが動き回る家庭内の動画・40枚）:
     BlazeFace       … 顔を見つけられたのが 26%
     FaceLandmarker  … 同じ映像で 5%
   FaceLandmarker は顔がはっきり大きく写っていないと拾わない。
   一方 BlazeFace は矩形しか返さないので、口の動きが分からない。
   そこで **見つけるのは BlazeFace、口を測るのは FaceLandmarker**（顔の切り抜きに対して）
   という役割分担にする。

解析は縮小した映像に対して行う（§8.7①）。顔の位置を知るのに元解像度は要らない。
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Protocol

_IS_MAC = sys.platform == "darwin"

DETECTOR_MODEL = "blaze_face_short_range.tflite"
LANDMARK_MODEL = "face_landmarker.task"


def model_path(name: str) -> Path:
    """同梱モデルの場所。scripts/fetch_models.py が置く。

    🔴 配布時の候補を先に見ること。開発時の vendor/ を先に見ると、
       「配布物の中でだけ場所がずれている」を手元でもCIでも踏めなくなる。
       ffmpeg で実際にそれをやって、友達の Mac で落ちた（media.py 参照）。
    """
    if getattr(sys, "frozen", False):
        # extraResources で vendor/models → Resources/sidecar/models に置かれる。
        # 実行ファイルは Resources/sidecar/sidecar なので、その隣の models/。
        packed = Path(sys.executable).resolve().parent / "models" / name
        if packed.exists():
            return packed
        raise RuntimeError(
            "顔を見つけるための部品がアプリの中に見つかりません。"
            "アプリを入れ直してください。"
        )

    root = Path(__file__).resolve().parent.parent.parent
    candidate = root / "vendor" / "models" / name
    if candidate.exists():
        return candidate

    raise RuntimeError(
        f"顔のモデルが見つかりません（{name}）。"
        "python scripts/fetch_models.py を実行してください。"
    )


class FaceDetector(Protocol):
    """正規化座標（0〜1）で顔の矩形を返す。"""

    def detect(self, image: Any) -> list[dict[str, float]]: ...
    def close(self) -> None: ...


class MouthReader(Protocol):
    """顔を切り抜いた画像から、口の開き具合（0〜1）を返す。

    複数人が映っているとき、**大きく映っている人＝喋っている人ではない**。
    実際に「喋っていない方の人にアップした」という不具合が出た。
    誰が喋っているかは、口が動いているかでしか分からない。
    """

    def openness(self, face_image: Any) -> float | None: ...
    def close(self) -> None: ...


class _BlazeFaceDetector:
    def __init__(self, min_confidence: float = 0.4) -> None:
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision

        self._detector = vision.FaceDetector.create_from_options(
            vision.FaceDetectorOptions(
                base_options=mp_python.BaseOptions(
                    model_asset_path=str(model_path(DETECTOR_MODEL)),
                    delegate=mp_python.BaseOptions.Delegate.CPU,
                ),
                min_detection_confidence=min_confidence,
            )
        )

    def detect(self, image: Any) -> list[dict[str, float]]:
        """image は RGB の numpy 配列。"""
        import mediapipe as mp

        h, w = image.shape[:2]
        result = self._detector.detect(
            mp.Image(image_format=mp.ImageFormat.SRGB, data=image)
        )

        faces: list[dict[str, float]] = []
        for det in result.detections:
            box = det.bounding_box
            score = det.categories[0].score if det.categories else 0.0
            faces.append({
                "x": max(0.0, box.origin_x / w),
                "y": max(0.0, box.origin_y / h),
                "w": min(1.0, box.width / w),
                "h": min(1.0, box.height / h),
                "score": float(score),
            })
        return faces

    def close(self) -> None:
        try:
            self._detector.close()
        except Exception:  # noqa: BLE001
            pass


#: 口の開き具合として読む表情係数。顎の開き。喋っていると上下する。
_JAW_OPEN = "jawOpen"


class _LandmarkMouthReader:
    def __init__(self) -> None:
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision

        self._detector = vision.FaceLandmarker.create_from_options(
            vision.FaceLandmarkerOptions(
                base_options=mp_python.BaseOptions(
                    model_asset_path=str(model_path(LANDMARK_MODEL)),
                    delegate=mp_python.BaseOptions.Delegate.CPU,
                ),
                num_faces=1,
                output_face_blendshapes=True,
                min_face_detection_confidence=0.3,
            )
        )

    def openness(self, face_image: Any) -> float | None:
        """顔だけを切り抜いて拡大した画像を渡すこと。

        画面全体を渡すと、顔が小さすぎて検出できない（冒頭のコメント参照）。
        """
        import mediapipe as mp

        result = self._detector.detect(
            mp.Image(image_format=mp.ImageFormat.SRGB, data=face_image)
        )
        if not result.face_blendshapes:
            return None
        for shape in result.face_blendshapes[0]:
            if shape.category_name == _JAW_OPEN:
                return float(shape.score)
        return None

    def close(self) -> None:
        try:
            self._detector.close()
        except Exception:  # noqa: BLE001
            pass


def make_detector() -> FaceDetector:
    """顔を見つける器を返す。

    🔴 プラットフォーム分岐はここだけ。呼び出し側は detect() しか見ない。

    Windows も Mac も CPU を使う。
    pip で配布される mediapipe は GPU デリゲートを含まずビルドされており
    （"GPU processing is disabled in build flags"）、どちらの環境でも結局 CPU に落ちる。
    毎回失敗のログを出させる意味がない。縮小した映像なら CPU で十分間に合う。
    """
    return _BlazeFaceDetector()


def make_mouth_reader() -> MouthReader:
    """口の動きを測る器を返す。複数人が映るときにだけ使う。"""
    return _LandmarkMouthReader()


def describe_backend() -> str:
    """診断情報用（§10.5）。"""
    suffix = "+cpu(mac)" if _IS_MAC else "+cpu"
    return f"mediapipe-blazeface/facelandmarker{suffix}"
