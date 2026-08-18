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
    """ハードウェアエンコーダが使えない場合のフォールバック（LGPL・特許的にも安全）。"""
    bitrate = "12M" if quality == "high" else "8M"
    return ["-c:v", "libopenh264", "-b:v", bitrate, "-pix_fmt", "yuv420p"]


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
