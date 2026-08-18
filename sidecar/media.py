"""ffmpeg を叩く処理。

プラットフォーム差は ffmpeg/platform_args.py にのみ置く（§10.4）。
このファイルはどのOSでも同じことをする。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable

from .ffmpeg.platform_args import available_video_args

ProgressFn = Callable[[float, str], None]


def find_ffmpeg() -> str:
    """同梱の LGPL ビルドを優先する。"""
    root = Path(__file__).resolve().parent.parent
    for name in ("ffmpeg.exe", "ffmpeg"):
        candidate = root / "vendor" / "ffmpeg" / name
        if candidate.exists():
            return str(candidate)

    # 配布時は実行ファイルの隣に置かれる
    if getattr(sys, "frozen", False):
        for name in ("ffmpeg.exe", "ffmpeg"):
            candidate = Path(sys.executable).parent / name
            if candidate.exists():
                return str(candidate)

    found = shutil.which("ffmpeg")
    if found:
        return found

    raise RuntimeError(
        "ffmpeg が見つかりません。python scripts/fetch_ffmpeg.py を実行してください。"
    )


def _run(cmd: list[str]) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg が失敗しました:\n{(result.stderr or '')[-1500:]}")
    return result.stdout or ""


def probe_duration(path: str) -> float:
    """尺を秒で返す。ffprobe が無い環境もありうるので ffmpeg の出力から拾う。"""
    ffmpeg = find_ffmpeg()
    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", path],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    for line in (result.stderr or "").splitlines():
        if "Duration:" in line:
            token = line.split("Duration:")[1].split(",")[0].strip()
            h, m, s = token.split(":")
            return int(h) * 3600 + int(m) * 60 + float(s)
    return 0.0


def extract_audio(video_path: str, out_wav: str, on_progress: ProgressFn | None = None) -> str:
    """文字起こし用の音声を取り出す。

    16kHz モノラルにするのは Whisper が内部でそうするから。
    先に落としておけば精度は変わらず I/O だけ減る（§8.7①）。
    """
    if on_progress:
        on_progress(0.02, "音声を取り出しています")

    Path(out_wav).parent.mkdir(parents=True, exist_ok=True)
    _run([
        find_ffmpeg(), "-y", "-hide_banner", "-loglevel", "error",
        "-i", video_path,
        "-vn", "-ac", "1", "-ar", "16000",
        "-c:a", "pcm_s16le",
        out_wav,
    ])
    return out_wav


def export_cut_video(
    video_path: str,
    out_path: str,
    keeps: list[tuple[float, float]],
    on_progress: ProgressFn | None = None,
) -> dict[str, Any]:
    """残す区間だけを繋いで書き出す。

    trim/atrim + concat フィルタで1パスで行う。
    区間ごとに一時ファイルを作って結合する方式は、
    区間数が増えるとファイル I/O とコンテナのオーバーヘッドで遅くなるうえ、
    境界でフレームがずれやすい。
    """
    if not keeps:
        raise ValueError("残す区間がありません（全部カットされています）")

    ffmpeg = find_ffmpeg()
    vargs, encoder = available_video_args(ffmpeg)

    if on_progress:
        on_progress(0.05, f"書き出しています（{encoder}）")

    parts: list[str] = []
    for i, (start, end) in enumerate(keeps):
        parts.append(
            f"[0:v]trim=start={start}:end={end},setpts=PTS-STARTPTS[v{i}];"
            f"[0:a]atrim=start={start}:end={end},asetpts=PTS-STARTPTS[a{i}];"
        )
    concat_inputs = "".join(f"[v{i}][a{i}]" for i in range(len(keeps)))
    filter_complex = "".join(parts) + f"{concat_inputs}concat=n={len(keeps)}:v=1:a=1[vout][aout]"

    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    _run([
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-i", video_path,
        "-filter_complex", filter_complex,
        "-map", "[vout]", "-map", "[aout]",
        *vargs,
        "-c:a", "aac", "-b:a", "192k",
        out_path,
    ])

    kept = sum(e - s for s, e in keeps)
    if on_progress:
        on_progress(1.0, "完了")

    return {
        "out_path": out_path,
        "encoder": encoder,
        "kept_seconds": round(kept, 2),
        "segments": len(keeps),
        "size_mb": round(os.path.getsize(out_path) / 1024 / 1024, 2),
    }


def write_json(path: str, data: Any) -> str:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return path
