"""RPC メソッドのディスパッチ。

Phase 0 時点では疎通確認用の最小メソッドのみ。
解析パイプライン（ASR / VAD / 韻律 / 顔検出 / LLM判断）は Phase 1 以降で足す。
"""

from __future__ import annotations

import platform
import sys
from typing import Any, Callable

from .asr import describe_backend as describe_asr
from .face import describe_backend as describe_face
from .ffmpeg.platform_args import platform_name, video_args


def _ping(params: dict[str, Any]) -> dict[str, Any]:
    """疎通確認。Electron 側から送った値をそのまま返す。"""
    return {"pong": True, "echo": params.get("message", "")}


def _env(_params: dict[str, Any]) -> dict[str, Any]:
    """実行環境の情報。Mac 実機に投げる診断で最初に見る値（§10.5）。"""
    return {
        "platform": platform_name(),
        "python": sys.version.split()[0],
        "machine": platform.machine(),
        "asr_backend": describe_asr(),
        "face_backend": describe_face(),
        "encoder_args": video_args(),
    }


HANDLERS: dict[str, Callable[[dict[str, Any]], Any]] = {
    "ping": _ping,
    "env": _env,
}


def dispatch(method: str, params: dict[str, Any]) -> Any:
    handler = HANDLERS.get(method)
    if handler is None:
        raise ValueError(f"未知のメソッドです: {method}")
    return handler(params)
