"""子プロセスで実行される重い処理。

ここに書いたものは**別プロセスで動く**（worker.py 参照）。
親プロセスには推論ライブラリを読み込ませないので、
親は軽いまま保たれ、クラッシュしても RPC ループは生き残る。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

from .asr import make_asr

ProgressFn = Callable[[float, str], None]

_asr = None


def _get_asr():
    global _asr
    if _asr is None:
        _asr = make_asr()
    return _asr


def _transcribe(params: dict[str, Any], on_progress: ProgressFn) -> dict[str, Any]:
    audio_path = params.get("audio_path")
    if not audio_path:
        raise ValueError("audio_path が必要です")

    result = _get_asr().transcribe(
        audio_path,
        model=params.get("model", "large-v3-turbo"),
        language=params.get("language", "ja"),
        on_progress=on_progress,
        # キャンセルはプロセスごと終了させるので、ここでは見ない
        is_cancelled=None,
    )

    # セグメントは量が多いのでファイルに落とし、応答にはパスと要約だけ返す（§4.4）
    out_path = params.get("out_path")
    if out_path:
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        Path(out_path).write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    segments = result.get("segments", [])
    return {
        "cancelled": False,
        "out_path": out_path,
        "backend": result.get("backend"),
        "device": result.get("device"),
        "model": result.get("model"),
        "duration": result.get("duration"),
        "elapsed_seconds": result.get("elapsed_seconds"),
        "realtime_factor": result.get("realtime_factor"),
        "segment_count": len(segments),
        "text": "".join(s["text"] for s in segments),
    }


HEAVY_HANDLERS: dict[str, Callable[..., Any]] = {
    "transcribe": _transcribe,
}


def dispatch_heavy(method: str, params: dict[str, Any], on_progress: ProgressFn) -> Any:
    handler = HEAVY_HANDLERS.get(method)
    if handler is None:
        raise ValueError(f"重い処理として未知のメソッドです: {method}")
    return handler(params, on_progress)
