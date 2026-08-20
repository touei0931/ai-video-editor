"""ffmpeg のエンコーダ/デコーダ引数 — プラットフォーム差の閉じ込め先（§10.4）。

🔴 このファイルは「プラットフォーム分岐を書いてよい4ファイル」のひとつです。

🔴 x264 / x265 は**絶対に使いません**（GPL 汚染。収益化時に致命的・§13.1）。
   エンコードはハードウェアエンコーダ、無ければ OpenH264 を使います。

エンコーダは環境によって使えたり使えなかったりする（GPU 無しの Windows、CI ランナー等）ので、
**候補を優先順に並べて、実際に動くものを選ぶ**方式にしています。
決め打ちにすると「NVIDIA が無い Windows ではプロキシが作れない」といった穴が空きます。
"""

from __future__ import annotations

import subprocess
import sys

_IS_MAC = sys.platform == "darwin"

# 候補の最後に置く保険。ffmpeg に必ず内蔵されていて、外部ライブラリもライセンス問題もない。
# 画質は劣るが「何も書き出せない」よりはるかにまし。
_LAST_RESORT = "mpeg4"


def platform_name() -> str:
    return "mac" if _IS_MAC else "windows"


# ── 書き出し用 ────────────────────────────────────────────────


def video_args(quality: str = "standard") -> list[str]:
    """第一候補のエンコード引数（実際に使えるかは available_video_args で確認する）。"""
    return video_candidates(quality)[0][1]


def video_candidates(quality: str = "standard") -> list[tuple[str, list[str]]]:
    """書き出しエンコーダの候補を優先順に返す。"""
    bitrate = "12M" if quality == "high" else "8M"
    cq = "19" if quality == "high" else "23"
    common = ["-pix_fmt", "yuv420p"]

    if _IS_MAC:
        return [
            ("h264_videotoolbox", ["-c:v", "h264_videotoolbox", "-b:v", bitrate, *common]),
            ("libopenh264", ["-c:v", "libopenh264", "-b:v", bitrate, *common]),
            (_LAST_RESORT, ["-c:v", _LAST_RESORT, "-b:v", bitrate, *common]),
        ]

    # Windows: NVIDIA だけでなく Intel(QSV) / AMD(AMF) も拾う。
    # ここを NVENC 決め打ちにすると、内蔵GPUだけの環境が全部ソフトウェアエンコードに落ちる。
    return [
        ("h264_nvenc", ["-c:v", "h264_nvenc", "-preset", "p5", "-cq", cq, *common]),
        ("h264_qsv", ["-c:v", "h264_qsv", "-global_quality", cq, *common]),
        ("h264_amf", ["-c:v", "h264_amf", "-quality", "balanced", "-b:v", bitrate, *common]),
        ("libopenh264", ["-c:v", "libopenh264", "-b:v", bitrate, *common]),
        (_LAST_RESORT, ["-c:v", _LAST_RESORT, "-b:v", bitrate, *common]),
    ]


# ── レビュー用プロキシ ────────────────────────────────────────


def proxy_args() -> list[str]:
    """第一候補のプロキシ用引数。"""
    return proxy_candidates()[0][1]


def proxy_candidates() -> list[tuple[str, list[str]]]:
    """レビュー用プロキシの候補を優先順に返す。

    要件は「全フレームが I フレームで、ループ再生の継ぎ目が引っかからないこと」（§3.3.3 / §8.5）。
    Mac では ProRes Proxy が最適（M2 のメディアエンジンが対応）。
    それ以外は intra-only 相当（-g 1）で代替する。
    """
    if _IS_MAC:
        return [
            ("prores_videotoolbox", ["-c:v", "prores_videotoolbox", "-profile:v", "0"]),
            ("h264_videotoolbox", ["-c:v", "h264_videotoolbox", "-g", "1", "-b:v", "6M"]),
            (_LAST_RESORT, ["-c:v", _LAST_RESORT, "-g", "1", "-b:v", "6M"]),
        ]

    return [
        ("h264_nvenc", ["-c:v", "h264_nvenc", "-preset", "p1", "-g", "1", "-cq", "28"]),
        ("h264_qsv", ["-c:v", "h264_qsv", "-g", "1", "-global_quality", "28"]),
        ("h264_amf", ["-c:v", "h264_amf", "-g", "1", "-b:v", "6M"]),
        ("libopenh264", ["-c:v", "libopenh264", "-g", "1", "-b:v", "6M"]),
        (_LAST_RESORT, ["-c:v", _LAST_RESORT, "-g", "1", "-b:v", "6M"]),
    ]


# ── レビュー用クリップ ────────────────────────────────────────


def review_clip_candidates() -> list[tuple[str, list[str]]]:
    """レビュー画面で `<video>` に流す短尺クリップの候補を優先順に返す。

    🔴 プロキシ用（proxy_candidates）を流用してはいけない。
       あちらの Mac 第一候補は ProRes だが、**Chromium は ProRes を再生できない**。
       MP4 コンテナにも正しく入らない。ここは H.264 に限る必要がある。

    🔴 mpeg4（MPEG-4 Part 2）も入れない。Chromium が再生できないので、
       最後の砦として置くと「ファイルはあるのに真っ黒」という分かりにくい壊れ方になる。
       使えるものが無いなら、失敗として上へ返すほうがよい。

    GOP を短くするのは、繋ぎ目まで巻き戻す操作（R キー）を待たせないため。
    """
    if _IS_MAC:
        # Apple Silicon では VideoToolbox が必ず使える。
        # 同梱の ffmpeg は外部ライブラリを一切リンクしないので libopenh264 は無い。
        return [
            ("h264_videotoolbox", ["-c:v", "h264_videotoolbox", "-b:v", "2M", "-g", "15"]),
        ]

    return [
        ("h264_nvenc", ["-c:v", "h264_nvenc", "-preset", "p1", "-b:v", "2M", "-g", "15"]),
        ("h264_qsv", ["-c:v", "h264_qsv", "-b:v", "2M", "-g", "15"]),
        ("h264_amf", ["-c:v", "h264_amf", "-b:v", "2M", "-g", "15"]),
        ("libopenh264", ["-c:v", "libopenh264", "-b:v", "2M", "-g", "15"]),
    ]


def available_review_clip_args(ffmpeg: str) -> tuple[list[str], str]:
    """レビュー用クリップに実際に使えるエンコーダを選ぶ。"""
    return _first_available(ffmpeg, review_clip_candidates())


# ── 実際に使えるものを選ぶ ────────────────────────────────────


def _probe(ffmpeg: str, args: list[str]) -> bool:
    """短いダミー映像を実際にエンコードしてみて、通るかどうかを確かめる。

    プローブ解像度を小さくしすぎないこと。NVENC には最小サイズの制約があり、
    64x64 だと「使えない」と誤判定してハードウェアエンコーダを取りこぼす。
    """
    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error",
         "-f", "lavfi", "-i", "color=c=black:s=320x240:d=0.2",
         *args, "-f", "null", "-"],
        capture_output=True, text=True,
    )
    return result.returncode == 0


def _first_available(
    ffmpeg: str, candidates: list[tuple[str, list[str]]]
) -> tuple[list[str], str]:
    for name, args in candidates:
        if _probe(ffmpeg, args):
            return args, name
    raise RuntimeError(
        "使えるエンコーダがありません。同梱の ffmpeg の構成を確認してください "
        "（python scripts/verify_ffmpeg.py）"
    )


def available_video_args(ffmpeg: str, quality: str = "standard") -> tuple[list[str], str]:
    """書き出しに実際に使えるエンコーダを選ぶ。戻り値は (引数, エンコーダ名)。"""
    return _first_available(ffmpeg, video_candidates(quality))


def available_proxy_args(ffmpeg: str) -> tuple[list[str], str]:
    """プロキシ生成に実際に使えるエンコーダを選ぶ。戻り値は (引数, エンコーダ名)。"""
    return _first_available(ffmpeg, proxy_candidates())


# ── デコード ──────────────────────────────────────────────────


def decode_args() -> list[str]:
    """ハードウェアデコード指定。CPU を使わないことが M2 Air では最優先（§8.2）。"""
    if _IS_MAC:
        return ["-hwaccel", "videotoolbox"]
    return ["-hwaccel", "cuda"]


def available_decode_args(ffmpeg: str) -> list[str]:
    """実際に使えるハードウェアデコード指定を返す。使えなければ空。

    🔴 決め打ちで付けてはいけない。
       Windows で -hwaccel cuda を無条件に付けると、NVIDIA の載っていない機械で
       すべての ffmpeg 呼び出しが失敗する。「使えるなら使う」でなければならない。

    🔴 逆に、付け忘れてもいけない。
       ここが空のままだと、音声抽出・レビュー用クリップ・顔検出・書き出しの
       全デコードが CPU に落ちる。ファンレスの MacBook Air で最も避けたい状態で、
       実際にこの関数が誰からも呼ばれておらず、その状態で動いていた。
    """
    global _decode_cache
    if _decode_cache is None:
        args = decode_args()
        _decode_cache = args if _probe_decode(ffmpeg, args) else []
    return list(_decode_cache)


_decode_cache: list[str] | None = None


def _probe_decode(ffmpeg: str, args: list[str]) -> bool:
    """短いダミー映像を実際にデコードしてみる。"""
    try:
        made = subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error",
             "-f", "lavfi", "-i", "testsrc=s=320x240:d=0.2",
             "-c:v", "mpeg4", "-f", "mpeg", "-"],
            capture_output=True,
        )
        if made.returncode != 0 or not made.stdout:
            return False
        result = subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", *args,
             "-f", "mpeg", "-i", "pipe:0", "-f", "null", "-"],
            input=made.stdout, capture_output=True,
        )
        return result.returncode == 0
    except Exception:  # noqa: BLE001
        return False
