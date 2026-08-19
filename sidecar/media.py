"""ffmpeg を叩く処理。

プラットフォーム差は ffmpeg/platform_args.py にのみ置く（§10.4）。
このファイルはどのOSでも同じことをする。
"""

from __future__ import annotations

import json
import os
import re
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


def probe_video_info(path: str) -> dict[str, Any]:
    """解像度・fps・尺をまとめて返す。ffprobe が無い環境もありうるので ffmpeg の出力から拾う。

    テロップの PNG は**この解像度ちょうどで描く**必要がある。
    ずれると overlay で拡大縮小され、縁取りの太さが変わって見た目が崩れる。

    🔴 回転情報（Display Matrix）を必ず見ること。
       iPhone の縦動画はストリーム自体は 1920x1080 のまま、
       「-90度回して表示せよ」という情報が付いている。
       ffmpeg は書き出し時にこれを自動で適用するので、
       出来上がる映像は 1080x1920 になる。
       ストリームの数値をそのまま信じると、横長のテロップを縦長の映像に重ねることになり、
       テロップがずれて画面から見切れる（実際に起きた）。
    """
    ffmpeg = find_ffmpeg()
    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", path],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    info: dict[str, Any] = {"width": 0, "height": 0, "fps": 30.0, "duration": 0.0, "rotation": 0}

    in_video = False
    for line in (result.stderr or "").splitlines():
        if "Duration:" in line:
            token = line.split("Duration:")[1].split(",")[0].strip()
            try:
                h, m, s = token.split(":")
                info["duration"] = int(h) * 3600 + int(m) * 60 + float(s)
            except ValueError:
                pass

        if "Stream #" in line:
            # 映像ストリームの行から次のストリームまでが、そのストリームの付随情報
            in_video = "Video:" in line
            if in_video and not info["width"]:
                # 「1920x1080」を拾う。SAR/DAR は「1280:1281」形式なので誤爆しない。
                size = re.search(r"\b(\d{2,5})x(\d{2,5})\b", line)
                if size:
                    info["width"] = int(size.group(1))
                    info["height"] = int(size.group(2))
                fps = re.search(r"([\d.]+) fps", line)
                if fps:
                    try:
                        info["fps"] = float(fps.group(1))
                    except ValueError:
                        pass
            continue

        if in_video and not info["rotation"]:
            # 「Display Matrix: rotation of -90.00 degrees」または「rotate : 90」
            rot = re.search(r"rotation of\s+(-?[\d.]+)", line) or re.search(r"rotate\s*:\s*(-?\d+)", line)
            if rot:
                try:
                    info["rotation"] = int(round(float(rot.group(1)))) % 360
                except ValueError:
                    pass

    if info["rotation"] in (90, 270):
        info["width"], info["height"] = info["height"], info["width"]

    return info


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


def png_size(path: str) -> tuple[int, int]:
    """PNG の縦横を読む。IHDR はファイル先頭の決まった位置にある。"""
    with open(path, "rb") as f:
        head = f.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"PNG ではありません: {path}")
    return int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big")


def _concat_path(path: str) -> str:
    """concat デマクサのファイル名として安全な形にする。

    concat デマクサはバックスラッシュをエスケープ文字として解釈するので、
    Windows のパスをそのまま書くと壊れる。ffmpeg は / を受け付けるので置き換える。
    """
    return str(path).replace("\\", "/").replace("'", r"'\''")


def write_telop_track(
    list_path: str,
    blank_png: str,
    telops: list[dict[str, Any]],
    total_duration: float,
) -> str:
    """テロップの表示スケジュールを concat デマクサ用のリストとして書く。

    🔴 テロップ1枚ごとに ffmpeg の入力を増やしてはいけない。
    20分素材ならテロップは数百枚になり、-i を数百個並べるのは現実的でない。
    concat デマクサなら、何枚あっても**入力は1本**で済む。

    透明な blank.png で隙間を埋め、全体が動画の尺と同じ長さになるようにする。
    尺を合わせておかないと、overlay が最後のテロップを最後まで出しっぱなしにする。
    """
    lines: list[str] = []
    cursor = 0.0

    def blank(seconds: float) -> None:
        if seconds > 0.001:
            lines.append(f"file '{_concat_path(blank_png)}'")
            lines.append(f"duration {seconds:.3f}")

    for t in sorted(telops, key=lambda x: x["out_start"]):
        start = max(cursor, float(t["out_start"]))
        end = max(start, float(t["out_end"]))
        if end - start < 0.02:
            continue
        blank(start - cursor)
        lines.append(f"file '{_concat_path(t['png'])}'")
        lines.append(f"duration {end - start:.3f}")
        cursor = end

    blank(max(0.2, total_duration - cursor))
    # 🔴 concat デマクサは**最後のエントリの duration を無視する**。
    #    もう一度同じファイルを書いておかないと、最後の表示が消えない。
    lines.append(f"file '{_concat_path(blank_png)}'")

    Path(list_path).parent.mkdir(parents=True, exist_ok=True)
    Path(list_path).write_text("\n".join(lines) + "\n", encoding="utf-8")
    return list_path


def export_cut_video(
    video_path: str,
    out_path: str,
    keeps: list[tuple[float, float]],
    telop_track: str | None = None,
    fps: float = 30.0,
    on_progress: ProgressFn | None = None,
) -> dict[str, Any]:
    """残す区間だけを繋いで書き出す。テロップがあれば同じパスで焼き込む。

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

    inputs = ["-i", video_path]
    if telop_track:
        inputs += ["-f", "concat", "-safe", "0", "-i", telop_track]
        filter_complex = (
            "".join(parts)
            + f"{concat_inputs}concat=n={len(keeps)}:v=1:a=1[vcat][aout];"
            # 静止画のままだとタイムスタンプが疎なので、動画と同じ fps に揃える
            f"[1:v]format=rgba,fps={fps:.5g},setpts=PTS-STARTPTS[ov];"
            # repeatlast=0 にしないと、テロップ列が尽きた後も最後の1枚が残り続ける
            "[vcat][ov]overlay=0:0:eof_action=pass:repeatlast=0[vout]"
        )
    else:
        filter_complex = (
            "".join(parts) + f"{concat_inputs}concat=n={len(keeps)}:v=1:a=1[vout][aout]"
        )

    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    _run([
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        *inputs,
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


#: レビュー用クリップで、カット前後をそれぞれ何秒ぶん見せるか。
#: 短いと「無音だったか」しか分からない。前後の話が聞こえる長さが要る。
REVIEW_CONTEXT = 2.5


def make_review_clip(
    video_path: str,
    out_path: str,
    cut_start: float,
    cut_end: float,
    context: float = REVIEW_CONTEXT,
    height: int = 480,
) -> dict[str, Any]:
    """レビュー用の短尺クリップを作る（§3.3.3 / §8.5）。

    🔴 「切る部分」ではなく「**切って繋いだ結果**」を作るのが要点。
    人間が判断すべきは「そこが無音か」ではなく「繋ぎが自然か」なので、
    カット前後を実際に繋いだものを聞かせないと判断できない。

    🔴 頭出しは必ず入力側の -ss / -t で行うこと。
    `-i 動画` のあとに trim フィルタで切り出す書き方だと、
    ffmpeg は**毎回ファイルの先頭からデコードする**。
    20分素材の後半にある候補では1件あたり十数分かかり、
    候補が100件あれば実用にならない。
    入力側の -ss なら該当箇所へ直接シークするので、位置によらず一定時間で済む。

    繋ぎ目の位置（クリップ先頭から何秒か）を返す。UI 側で目印を出すのに使う。
    """
    ffmpeg = find_ffmpeg()
    before_start = max(0.0, cut_start - context)
    before_len = round(cut_start - before_start, 3)
    after_len = round(context, 3)

    # 素材の端すぎて前後どちらかが取れないことがある。取れる側だけで作る。
    segments: list[tuple[float, float]] = []
    if before_len > 0.05:
        segments.append((before_start, before_len))
    if after_len > 0.05:
        segments.append((cut_end, after_len))
    if not segments:
        raise ValueError("プレビューを作れる長さがありません")

    cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error"]
    for start, length in segments:
        cmd += ["-ss", f"{start:.3f}", "-t", f"{length:.3f}", "-i", video_path]

    filters: list[str] = []
    for i in range(len(segments)):
        filters.append(f"[{i}:v]setpts=PTS-STARTPTS[v{i}]")
        filters.append(f"[{i}:a]asetpts=PTS-STARTPTS[a{i}]")

    if len(segments) > 1:
        joined = "".join(f"[v{i}][a{i}]" for i in range(len(segments)))
        filters.append(f"{joined}concat=n={len(segments)}:v=1:a=1[vcat][aout]")
        vsrc = "[vcat]"
    else:
        filters.append("[a0]anull[aout]")
        vsrc = "[v0]"

    # レビュー用なので解像度は落とす。滑らかさのほうが大事。
    # 🔴 scale は filter_complex の中に入れること。
    #    filter_complex の出力ラベルに対して -vf は使えず "Invalid argument" になる。
    filters.append(f"{vsrc}scale=-2:{height}[vout]")

    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    _run(cmd + [
        "-filter_complex", ";".join(filters),
        "-map", "[vout]", "-map", "[aout]",
        # GOP を短くするのは、繋ぎ目まで巻き戻す操作（R キー）を待たせないため。
        # ループの先頭は必ずキーフレームなので、ループ自体には効かない。
        "-c:v", "libopenh264", "-b:v", "2M", "-g", "15",
        "-c:a", "aac", "-b:a", "128k",
        "-pix_fmt", "yuv420p",
        out_path,
    ])

    return {
        "path": out_path,
        # 繋ぎ目 = 前半の長さ。ここでカットが起きている。
        "join_at": before_len if len(segments) > 1 else 0.0,
        "duration": round(sum(length for _, length in segments), 3),
    }


def write_json(path: str, data: Any) -> str:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return path
