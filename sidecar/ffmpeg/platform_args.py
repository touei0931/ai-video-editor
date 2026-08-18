"""ffmpeg のエンコーダ/デコーダ引数 — プラットフォーム差の閉じ込め先（§10.4）。

🔴 このファイルは「プラットフォーム分岐を書いてよい4ファイル」のひとつです。

🔴 x264 / x265 は**絶対に使いません**（GPL 汚染。収益化時に致命的・§13.1）。
   エンコードは必ずハードウェアエンコーダか OpenH264 を使います。
"""

from __future__ import annotations

import sys

_IS_MAC = sys.platform == "darwin"


def platform_name() -> str:
    return "mac" if _IS_MAC else "windows"


def video_args(quality: str = "standard") -> list[str]:
    """書き出し用のビデオエンコード引数。

    Mac: VideoToolbox（メディアエンジン）／Windows: NVENC。
    GPU が無い Windows 環境は OpenH264 にフォールバックする（§13.6）。
    """
    if _IS_MAC:
        bitrate = "12M" if quality == "high" else "8M"
        return ["-c:v", "h264_videotoolbox", "-b:v", bitrate, "-pix_fmt", "yuv420p"]

    cq = "19" if quality == "high" else "23"
    return ["-c:v", "h264_nvenc", "-preset", "p5", "-cq", cq, "-pix_fmt", "yuv420p"]


def fallback_video_args(quality: str = "standard") -> list[str]:
    """ハードウェアエンコーダが使えない場合のフォールバック（Windows 用）。

    Mac には出番がない。Apple Silicon なら VideoToolbox は必ず使えるので、
    macOS 版の ffmpeg は libopenh264 を積まずにビルドしている
    （外部ライブラリ依存ゼロ = Homebrew の dylib に依存せず、そのまま配布できる）。
    """
    bitrate = "12M" if quality == "high" else "8M"
    return ["-c:v", "libopenh264", "-b:v", bitrate, "-pix_fmt", "yuv420p"]


def available_video_args(ffmpeg: str, quality: str = "standard") -> tuple[list[str], str]:
    """実際に使えるエンコーダを選ぶ。使えなければフォールバックする（§13.6）。

    Mac の VideoToolbox は実機なら必ず使えるが、Windows は GPU 無し環境がありうる
    （CI ランナーもそう）。その場合は libopenh264 に落ちる。

    戻り値は (ffmpeg 引数, 選んだエンコーダ名)。
    """
    import subprocess

    preferred = video_args(quality)
    encoder = preferred[preferred.index("-c:v") + 1]

    # プローブ解像度は小さすぎてはいけない。
    # NVENC には最小サイズの制約があり、64x64 では「使えない」と誤判定して
    # ハードウェアエンコーダがあるのに libopenh264 に落ちてしまう。
    probe = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error",
         "-f", "lavfi", "-i", "color=c=black:s=320x240:d=0.2",
         "-c:v", encoder, "-f", "null", "-"],
        capture_output=True, text=True,
    )
    if probe.returncode == 0:
        return preferred, encoder

    fallback = fallback_video_args(quality)
    return fallback, fallback[fallback.index("-c:v") + 1]


def proxy_args() -> list[str]:
    """レビュー用プロキシ。

    Mac は ProRes Proxy（全フレーム I フレーム）にする。
    レビューUIの短尺ループで継ぎ目が引っかからないことが体感を決める（§3.3.3 / §8.5）。
    """
    if _IS_MAC:
        return ["-c:v", "prores_videotoolbox", "-profile:v", "0"]
    return ["-c:v", "h264_nvenc", "-preset", "p1", "-g", "1", "-cq", "28"]


def decode_args() -> list[str]:
    """ハードウェアデコード指定。CPU を使わないことが M2 Air では最優先（§8.2）。"""
    if _IS_MAC:
        return ["-hwaccel", "videotoolbox"]
    return ["-hwaccel", "cuda"]
