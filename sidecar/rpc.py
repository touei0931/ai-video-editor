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
    """実行環境の情報。Mac 実機に投げる診断で最初に見る値（§10.5）。

    🔴 ffmpeg の解決結果を必ず載せること。
       ここに出していれば、配布物の中で1階層ずれていた事故を
       友達に届く前に CI で止められた（release-mac.yml の関門が見ている）。
    """
    from .face import DETECTOR_MODEL, LANDMARK_MODEL, model_path
    from .media import find_ffmpeg

    def resolve(fn) -> str:
        try:
            return str(fn())
        except RuntimeError as e:
            return f"見つからない: {e}"

    ffmpeg = resolve(find_ffmpeg)
    models = {
        "detector": resolve(lambda: model_path(DETECTOR_MODEL)),
        "landmark": resolve(lambda: model_path(LANDMARK_MODEL)),
    }

    return {
        "platform": platform_name(),
        "python": sys.version.split()[0],
        "machine": platform.machine(),
        "frozen": getattr(sys, "frozen", False),
        "ffmpeg": ffmpeg,
        "face_models": models,
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


def _make_clip(params: dict[str, Any], **_kw) -> dict[str, Any]:
    """レビュー用クリップを1本だけ作る（後から確認したくなったとき用）。

    解析時に作るのは「人間が1件ずつ見る候補」だけ（heavy.py 参照）。
    自動でカットした箇所・自動で見送った箇所には、その時点でクリップが無い。
    しかし「自動でこう決めました」とだけ言われて中身を見られないのは、
    結局その判断を信じるしかないということになる。
    そこで必要になった1本だけをその場で作る。

    🔴 これはワーカーに回さず親プロセスで実行する。
       中身は ffmpeg を1回呼ぶだけ（実測 0.24 秒）で、
       Python の子プロセスを起こすほうが処理そのものより時間がかかる。
    """
    from .media import make_review_clip

    video_path = params.get("video_path")
    out_path = params.get("out_path")
    if not video_path or not out_path:
        raise ValueError("video_path と out_path が必要です")

    from pathlib import Path as _Path

    _Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    return make_review_clip(
        video_path,
        out_path,
        float(params["src_start"]),
        float(params["src_end"]),
    )


def _heavy(method: str):
    """重い処理は別プロセスへ回す（worker.py の冒頭に理由を書いてある）。"""

    def handler(params: dict[str, Any], on_progress: ProgressFn, is_cancelled: CancelFn) -> dict:
        from .worker import run_in_subprocess

        return run_in_subprocess(method, params, on_progress, is_cancelled)

    return handler


HANDLERS: dict[str, Callable[..., Any]] = {
    "ping": _ping,
    "env": _env,
    "sleep": _sleep,
    "transcribe": _transcribe,
    "make_clip": _make_clip,
    "analyze": _heavy("analyze"),
    "redetect": _heavy("redetect"),
    "build_telops": _heavy("build_telops"),
    "plan_framing": _heavy("plan_framing"),
    "export": _heavy("export"),
    "export_timeline": _heavy("export_timeline"),
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
