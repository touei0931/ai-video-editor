"""子プロセスで実行される重い処理。

ここに書いたものは**別プロセスで動く**（worker.py 参照）。
親プロセスには推論ライブラリを読み込ませないので、
親は軽いまま保たれ、クラッシュしても RPC ループは生き残る。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable  # noqa: F401

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


def _analyze(params: dict[str, Any], on_progress: ProgressFn) -> dict[str, Any]:
    """動画を解析してカット候補を作る（①カットの中核）。

    動画 → 音声抽出 → 文字起こし → カット候補検出 → analysis.json
    """
    from .cut import detect_candidates
    from .media import extract_audio, probe_duration, write_json

    video_path = params.get("video_path")
    if not video_path:
        raise ValueError("video_path が必要です")

    work_dir = Path(params.get("work_dir") or Path(video_path).parent / ".ai-video-editor")
    work_dir.mkdir(parents=True, exist_ok=True)

    duration = probe_duration(video_path)
    wav = extract_audio(video_path, str(work_dir / "audio.wav"), on_progress)

    # 文字起こしの進捗を全体の 5%〜85% に割り当てる
    def asr_progress(v: float, m: str = "") -> None:
        on_progress(0.05 + v * 0.8, m)

    transcript = _get_asr().transcribe(
        wav,
        model=params.get("model", "base"),
        language=params.get("language", "ja"),
        on_progress=asr_progress,
        is_cancelled=None,
    )
    transcript["duration"] = transcript.get("duration") or duration

    on_progress(0.88, "カット候補を検出しています")
    analysis = detect_candidates(transcript, params.get("options"))
    analysis["video_path"] = video_path
    analysis["transcript"] = {
        "backend": transcript.get("backend"),
        "device": transcript.get("device"),
        "model": transcript.get("model"),
        "elapsed_seconds": transcript.get("elapsed_seconds"),
        "realtime_factor": transcript.get("realtime_factor"),
        "text": "".join(s["text"] for s in transcript.get("segments", [])),
    }

    write_json(str(work_dir / "transcript.json"), transcript)
    analysis_path = write_json(str(work_dir / "analysis.json"), analysis)

    on_progress(1.0, "完了")

    kinds: dict[str, int] = {}
    for c in analysis["candidates"]:
        kinds[c["kind"]] = kinds.get(c["kind"], 0) + 1

    return {
        "cancelled": False,
        "analysis_path": analysis_path,
        "video_path": video_path,
        "duration": analysis["duration"],
        "candidate_count": len(analysis["candidates"]),
        "kinds": kinds,
        "transcript": analysis["transcript"],
        "candidates": analysis["candidates"],
    }


def _export(params: dict[str, Any], on_progress: ProgressFn) -> dict[str, Any]:
    """承認されたカットを適用して書き出す。"""
    from .cut import keep_ranges
    from .media import export_cut_video

    video_path = params["video_path"]
    out_path = params["out_path"]
    duration = float(params["duration"])
    cuts = [(float(c["src_start"]), float(c["src_end"])) for c in params.get("cuts", [])]

    keeps = keep_ranges(duration, cuts)
    result = export_cut_video(video_path, out_path, keeps, on_progress)
    result["cancelled"] = False
    result["original_seconds"] = round(duration, 2)
    result["cut_count"] = len(cuts)
    return result


HEAVY_HANDLERS: dict[str, Callable[..., Any]] = {
    "transcribe": _transcribe,
    "analyze": _analyze,
    "export": _export,
}


def dispatch_heavy(method: str, params: dict[str, Any], on_progress: ProgressFn) -> Any:
    handler = HEAVY_HANDLERS.get(method)
    if handler is None:
        raise ValueError(f"重い処理として未知のメソッドです: {method}")
    return handler(params, on_progress)
