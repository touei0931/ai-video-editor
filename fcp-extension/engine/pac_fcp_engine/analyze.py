"""素材1本を解析して、パネルが読む JSON を作る。

流れ:
    動画 → ffmpeg で wav → 文字起こし → 幻聴の除去
        → カット候補（無音 / フィラー / 言い直し）
        → テロップ候補（通常 / 強調）
        → パネル用 JSON

中身は PAC 本体（sidecar/）のものを import して使う。
文字起こしの VAD 設定（閾値 0.2・前後 600ms）や幻聴の落とし方は
PAC 側で実測して詰めたものなので、ここで作り直すと必ず質が落ちる。
**PAC には手を入れない（読むだけ）。**
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any, Callable

from . import repo  # noqa: F401  (sidecar を import できるようにする副作用)
from .mapping import cut_text_from_transcript, map_cuts, map_telops, project_state
from .waveform import extract_wav, peaks_from_wav

Progress = Callable[[str, float], None]


def _noop(_stage: str, _ratio: float) -> None:
    pass


def analyze(
    video: str,
    *,
    model: str = "large-v3-turbo",
    language: str = "ja",
    ffmpeg: str = "ffmpeg",
    waveform_points: int = 800,
    options: dict[str, Any] | None = None,
    progress: Progress = _noop,
) -> dict[str, Any]:
    """動画を解析してパネル用の状態を返す。"""
    from sidecar import clean as pac_clean
    from sidecar import cut as pac_cut
    from sidecar import telop as pac_telop
    from sidecar.asr import make_asr

    options = options or {}
    video_path = str(Path(video).resolve())

    with tempfile.TemporaryDirectory(prefix="pac-fcp-") as tmp:
        wav = str(Path(tmp) / "audio.wav")

        progress("音声を取り出しています", 0.05)
        extract_wav(video_path, wav, ffmpeg=ffmpeg)

        progress("波形を作っています", 0.15)
        waveform = peaks_from_wav(wav, points=waveform_points)

        progress("文字起こしをしています", 0.25)
        asr = make_asr()
        transcript = asr.transcribe(
            wav,
            model=model,
            language=language,
            # 文字起こしが全体の 25%〜85% を占めるので、その幅に押し込む
            on_progress=lambda ratio, note="": progress(note or "文字起こし中", 0.25 + 0.6 * ratio),
        )

        progress("認識結果を整えています", 0.85)
        # 破壊的に transcript を書き換え、何を落としたかを返す
        cleaned = pac_clean.clean_transcript(transcript)

        progress("カット候補を探しています", 0.9)
        analysis = pac_cut.detect_candidates(transcript, options.get("cut"))
        candidates = cut_text_from_transcript(list(analysis.get("candidates", [])), transcript)

        progress("テロップを作っています", 0.95)
        units = pac_telop.build_units(transcript, wav_path=wav, options=options.get("telop"))

        progress("完了", 1.0)
        state = project_state(
            duration=float(transcript.get("duration") or 0),
            waveform=waveform,
            cuts=map_cuts(candidates),
            telops=map_telops(units.get("telops", [])),
            media_path=video_path,
        )
        # 何が落ちたかは残しておく（テロップが少ないときの原因が分かるように）
        state["report"] = {
            "droppedSegments": cleaned.get("dropped", 0),
            "speechRatio": cleaned.get("speech_ratio", 0),
            "wordCount": analysis.get("word_count", 0),
        }
        return state
