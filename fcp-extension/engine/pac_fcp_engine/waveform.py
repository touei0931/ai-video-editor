"""音声の波形（タイムラインに描く山）を作る。

ffmpeg で 16kHz モノラルの生 PCM に落として、区間ごとの最大振幅を取るだけ。
波形は「どこで喋っていて、どこが無音か」が一目で分かればよいので、
点の数はタイムラインの横幅ぶん（既定 800 点）あれば足りる。
"""

from __future__ import annotations

import array
import subprocess
from pathlib import Path


class FFmpegMissing(RuntimeError):
    pass


def extract_wav(video: str, out_wav: str, ffmpeg: str = "ffmpeg", sample_rate: int = 16000) -> str:
    """解析用の 16kHz モノラル wav を作る。"""
    cmd = [
        ffmpeg, "-nostdin", "-y",
        "-i", video,
        "-vn", "-ac", "1", "-ar", str(sample_rate),
        "-c:a", "pcm_s16le",
        out_wav,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True)
    except FileNotFoundError as e:
        raise FFmpegMissing(f"ffmpeg が見つかりません: {ffmpeg}") from e
    if proc.returncode != 0:
        raise RuntimeError(f"音声の取り出しに失敗しました\n{proc.stderr[-2000:]}")
    return out_wav


def peaks_from_wav(wav_path: str, points: int = 800) -> list[float]:
    """wav から 0..1 の振幅列を作る。"""
    data = Path(wav_path).read_bytes()
    # 44 バイトの WAV ヘッダを飛ばす（pcm_s16le / ffmpeg 出力の標準的な形）
    body = data[44:]
    samples = array.array("h")
    samples.frombytes(body[: len(body) - (len(body) % 2)])
    return peaks_from_samples(samples, points)


def peaks_from_samples(samples, points: int = 800) -> list[float]:
    """16bit PCM の並びから、区間ごとの最大振幅（0..1）を作る。"""
    n = len(samples)
    if n == 0 or points <= 0:
        return []
    step = max(1, n // points)
    out: list[float] = []
    for i in range(0, n, step):
        chunk = samples[i : i + step]
        if not len(chunk):
            continue
        peak = max(abs(int(v)) for v in chunk)
        out.append(min(1.0, peak / 32768.0))
        if len(out) >= points:
            break
    return out
