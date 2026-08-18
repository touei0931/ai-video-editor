"""RPC メソッドのディスパッチ。

大きなデータ（analysis.json / PNG）は stdout に流さず、**ファイルパスを返す**（§4.4）。
文字起こし結果もセグメント数が多いとログが読めなくなるので、
本番ではファイルに書いてパスを返す方針にする。
"""

from __future__ import annotations

import platform
import sys
import time
from typing import Any, Callable

from .asr import describe_backend as describe_asr
from .face import describe_backend as describe_face
from .ffmpeg.platform_args import platform_name, video_args

ProgressFn = Callable[[float, str], None]
CancelFn = Callable[[], bool]


def _ping(params: dict[str, Any], **_kw) -> dict[str, Any]:
    """疎通確認。Electron 側から送った値をそのまま返す。"""
    return {"pong": True, "echo": params.get("message", "")}


def _env(_params: dict[str, Any], **_kw) -> dict[str, Any]:
    """実行環境の情報。Mac 実機に投げる診断で最初に見る値（§10.5）。"""
    return {
        "platform": platform_name(),
        "python": sys.version.split()[0],
        "machine": platform.machine(),
        "frozen": getattr(sys, "frozen", False),
        "asr_backend": describe_asr(),
        "face_backend": describe_face(),
        "encoder_args": video_args(),
    }


def _sleep(params: dict[str, Any], on_progress: ProgressFn, is_cancelled: CancelFn) -> dict:
    """進捗通知とキャンセルの動作確認用（テスト専用）。"""
    seconds = float(params.get("seconds", 3))
    steps = int(params.get("steps", 30))
    for i in range(steps):
        if is_cancelled():
            return {"cancelled": True, "completed_steps": i}
        time.sleep(seconds / steps)
        on_progress((i + 1) / steps, f"{i + 1}/{steps}")
    return {"cancelled": False, "completed_steps": steps}


def _transcribe(params: dict[str, Any], on_progress: ProgressFn, is_cancelled: CancelFn) -> dict:
    """文字起こし。

    🔴 実処理は**別プロセス**で走らせる（worker.py 参照）。
    スレッドで走らせると CTranslate2 が Windows でデッドロックする。
    """
    from .worker import run_in_subprocess

    return run_in_subprocess("transcribe", params, on_progress, is_cancelled)


HANDLERS: dict[str, Callable[..., Any]] = {
    "ping": _ping,
    "env": _env,
    "sleep": _sleep,
    "transcribe": _transcribe,
}


def dispatch(
    method: str,
    params: dict[str, Any],
    on_progress: ProgressFn,
    is_cancelled: CancelFn,
) -> Any:
    handler = HANDLERS.get(method)
    if handler is None:
        raise ValueError(f"未知のメソッドです: {method}")
    return handler(params, on_progress=on_progress, is_cancelled=is_cancelled)
