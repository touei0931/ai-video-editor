"""顔検出モデルを取得する（③ズーム・画角の自動化で使う）。

MediaPipe 1.0 は旧 solutions API を廃止しており、
Tasks API はモデルファイル（.tflite）を別途必要とする。

ライセンス（§13.1）:
  BlazeFace（blaze_face_short_range）は **Apache-2.0**。商用利用・再配布可。
  🔴 Ultralytics YOLO は AGPL なので使わない。

置き場所は vendor/models/（.gitignore 済み。ffmpeg と同じ扱い）。
"""

from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _console import enable_utf8  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "vendor" / "models"

MODELS = [
    {
        "name": "face_landmarker.task",
        "url": (
            "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
            "face_landmarker/float16/1/face_landmarker.task"
        ),
        "license": "Apache-2.0",
        "note": "顔のランドマーク＋表情係数。口の動きから「今喋っている人」を選ぶのに使う",
    },
    {
        "name": "blaze_face_short_range.tflite",
        "url": (
            "https://storage.googleapis.com/mediapipe-models/face_detector/"
            "blaze_face_short_range/float16/1/blaze_face_short_range.tflite"
        ),
        "license": "Apache-2.0",
        "note": "顔検出。2m以内の顔向け。話者追従のクロップに使う",
    },
]


def main() -> int:
    enable_utf8()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    for model in MODELS:
        target = OUT_DIR / model["name"]
        if target.exists():
            print(f"すでにあります: {target.name}（{target.stat().st_size // 1024}KB）")
            continue

        print(f"取得中: {model['name']}  [{model['license']}]")
        try:
            with urllib.request.urlopen(model["url"], timeout=120) as res:
                data = res.read()
        except Exception as e:  # noqa: BLE001
            print(f"  失敗: {e}", file=sys.stderr)
            return 1

        target.write_bytes(data)
        digest = hashlib.sha256(data).hexdigest()[:16]
        print(f"  保存: {target}  {len(data) // 1024}KB  sha256:{digest}…")

    print("\nfetch_models: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
