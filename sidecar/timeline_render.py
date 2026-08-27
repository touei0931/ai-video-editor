"""複数の素材を並べたタイムラインを、1本の動画にする。

`media.export_cut_video` は **1本の素材を切り繋ぐ**ための道具で、
入力が1つであることを前提に組んである。こちらは親画面（NLE）用で、
**素材が何本あっても、どのレーンに置かれていても**書き出せる。

考え方:

- **メインのレーンは繋ぐ（concat）**。上に重ねるレーンは重ねる（overlay）。
  全部 overlay で済ませるほうが書くのは楽だが、overlay は
  **タイムライン全体のコマ数ぶん働く**。自動カットの結果は数十本のクリップになるので、
  60本を全部 overlay にすると 60 回ぶん全編を舐めることになり、書き出しが何倍にも延びる。
  繋ぐなら1コマは1回しか通らない。

- **空きは黒い映像で埋める**。concat は入力の数だけ隙間なく繋ぐので、
  空きを飛ばすと後ろのクリップが前に詰まり、**音とずれる**。

- **音は adelay で置いて、まとめて混ぜる**。音は重なるのが普通
  （メインの声＋差し込みの音＋BGM）なので、繋ぐのではなく置いて混ぜる。

🔴 **時刻は必ずコマ境界に丸めること。**
   丸めないと concat の繋ぎ目で1コマ増えたり減ったりし、**後ろへ行くほど音と絵がずれる**。
   ずれは書き出したものを最後まで見ないと気づけない。

🔴 **文字列を組む関数（build_timeline_graph）と、走らせる関数（export_timeline）を分けること。**
   組むほうだけなら ffmpeg が無くても試せる。ここは間違えても例外が出ず、
   「なんか絵がずれている」という形でしか表に出ないので、机上で検められる状態にしておく。
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Callable

ProgressFn = Callable[[float, str], None]

#: 繋ぎ目のフェード長。media.FADE_SECONDS と同じ理由（クリックノイズ対策）
FADE_SECONDS = 0.035

#: 音の無いタイムラインでも音声の流れは作る。無いと -map で落ちる
SILENT_RATE = 48000


def _q(t: float, fps: float) -> float:
    """コマ境界に丸める。"""
    return round(t * fps) / fps


def _ms(t: float) -> int:
    return int(round(t * 1000))


def _norm_video(head: str, tail: str, width: int, height: int, fps: float) -> str:
    """どの素材でも同じ大きさ・同じ形・同じコマ数にする。

    🔴 concat は入力の**大きさ・画素比・コマ数が全部揃っていること**を求める。
       揃っていないと "Input link parameters do not match" で止まる。
       縦動画と横動画を混ぜた時点で必ず踏む。
    🔴 引き伸ばさずに、余白で埋める（force_original_aspect_ratio=decrease + pad）。
       引き伸ばすと人の顔が横に潰れる。
    """
    return (
        head
        + f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        + f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,"
        + f"setsar=1,fps={fps:.5g},format=yuv420p"
        + tail
    )


def build_timeline_graph(spec: dict[str, Any]) -> dict[str, Any]:
    """タイムラインの中身から、ffmpeg に渡す入力とフィルタを組み立てる。

    spec:
        width, height, fps, duration
        clips: [{path, src_start, src_end, at, video, audio, z, gain_db}]
        telop_tracks: [concat リストのパス]   # 段ごとに1本
        music: {path, volume, loop} | None
        loudnorm: bool                        # 既定 True

    返すもの:
        inputs         : [{kind, path}] を並べた順。ffmpeg の -i の順と一致する
        filter_complex : そのまま -filter_complex_script に書ける文字列
        video_segments : メインのレーンを何本に分けたか（空き含む）
        audio_clips    : 音として混ぜた本数
    """
    width = int(spec["width"])
    height = int(spec["height"])
    fps = float(spec["fps"])
    duration = _q(float(spec["duration"]), fps)
    if duration <= 0:
        raise ValueError("タイムラインの長さが 0 です")

    clips = list(spec.get("clips") or [])
    if not clips:
        raise ValueError("並んでいるクリップがありません")

    # ── 素材ごとに入力を1つ ──
    #
    # 🔴 クリップごとに -i を足さないこと。
    #    同じ素材を10回切って並べたら10回開くことになり、
    #    メモリも起動時間も無駄に増える。同じファイルは1回だけ開いて、
    #    trim で何度でも切り出す。
    inputs: list[dict[str, str]] = []
    index_of: dict[str, int] = {}
    for c in clips:
        path = str(c["path"])
        if path not in index_of:
            index_of[path] = len(inputs)
            inputs.append({"kind": "media", "path": path})

    parts: list[str] = []

    # ────────────────────────────── 映像：メインのレーンを繋ぐ
    main = sorted(
        (c for c in clips if int(c.get("z", 0)) == 0 and c.get("video", True)),
        key=lambda c: float(c["at"]),
    )

    segments: list[str] = []
    cursor = 0.0
    n = 0

    def gap(length: float) -> None:
        nonlocal n
        if length <= 1.0 / fps / 2:
            return
        parts.append(
            f"color=c=black:s={width}x{height}:r={fps:.5g}:d={length:.4f},"
            f"setsar=1,format=yuv420p[v{n}];"
        )
        segments.append(f"[v{n}]")
        n += 1

    for c in main:
        at = _q(float(c["at"]), fps)
        s = _q(float(c["src_start"]), fps)
        e = _q(float(c["src_end"]), fps)
        if e - s <= 0:
            continue
        gap(at - cursor)
        i = index_of[str(c["path"])]
        parts.append(
            _norm_video(
                f"[{i}:v]trim=start={s:.4f}:end={e:.4f},setpts=PTS-STARTPTS,",
                f"[v{n}];",
                width,
                height,
                fps,
            )
        )
        segments.append(f"[v{n}]")
        n += 1
        cursor = max(cursor, at + (e - s))

    # 🔴 最後まで埋めること。
    #    メインが途中で終わっているのに上のレーンだけ続いていると、
    #    concat の出力がそこで終わり、**残りが黙って切り落とされる**。
    gap(duration - cursor)

    if not segments:
        gap(duration)

    if len(segments) == 1:
        parts.append(f"{segments[0]}null[vcat];")
    else:
        joined = "".join(segments)
        parts.append(f"{joined}concat=n={len(segments)}:v=1:a=0[vcat];")

    # ────────────────────────────── 映像：上に重ねるレーン
    #
    # 🔴 出す時間を enable で区切ること。
    #    setpts でずらしただけでは、始まる前は最初のコマが、
    #    終わったあとは最後のコマが**出しっぱなし**になる。
    over = sorted(
        (c for c in clips if int(c.get("z", 0)) > 0 and c.get("video", True)),
        key=lambda c: (int(c.get("z", 0)), float(c["at"])),
    )
    src = "[vcat]"
    for k, c in enumerate(over):
        at = _q(float(c["at"]), fps)
        s = _q(float(c["src_start"]), fps)
        e = _q(float(c["src_end"]), fps)
        if e - s <= 0:
            continue
        i = index_of[str(c["path"])]
        parts.append(
            _norm_video(
                f"[{i}:v]trim=start={s:.4f}:end={e:.4f},"
                f"setpts=PTS-STARTPTS+{at:.4f}/TB,",
                f"[o{k}];",
                width,
                height,
                fps,
            )
        )
        dst = f"[vlay{k}]"
        parts.append(
            f"{src}[o{k}]overlay=0:0:eof_action=pass:repeatlast=0:"
            f"enable='between(t,{at:.4f},{at + (e - s):.4f})'{dst};"
        )
        src = dst
    parts.append(f"{src}null[vbase];")

    # ────────────────────────────── 音
    #
    # 🔴 amix は既定で入力の数だけ音量を割る（normalize=1）。
    #    クリップを1本足しただけで全体の音が小さくなるので、必ず normalize=0 にする。
    # 🔴 dropout_transition=0 にしないと、片方が終わった瞬間にもう片方が持ち上がる。
    voices: list[str] = []
    for c in clips:
        if not c.get("audio", True):
            continue
        at = _q(float(c["at"]), fps)
        s = _q(float(c["src_start"]), fps)
        e = _q(float(c["src_end"]), fps)
        length = e - s
        if length <= 0:
            continue
        i = index_of[str(c["path"])]
        m = len(voices)
        fade = min(FADE_SECONDS, length / 4)
        chain = (
            f"[{i}:a]atrim=start={s:.4f}:end={e:.4f},asetpts=PTS-STARTPTS,"
            f"afade=t=in:st=0:d={fade:.4f},"
            f"afade=t=out:st={max(0.0, length - fade):.4f}:d={fade:.4f}"
        )
        gain = float(c.get("gain_db", 0.0) or 0.0)
        if abs(gain) > 0.01:
            chain += f",volume={gain:.2f}dB"
        if at > 0.0005:
            chain += f",adelay={_ms(at)}|{_ms(at)}:all=1"
        parts.append(chain + f"[a{m}];")
        voices.append(f"[a{m}]")

    if not voices:
        # 🔴 音の流れが無いと -map "[aout]" が落ちる。
        #    映像だけのタイムラインでも無音を作っておく。
        parts.append(
            f"anullsrc=channel_layout=stereo:sample_rate={SILENT_RATE},"
            f"atrim=0:{duration:.4f}[avoice];"
        )
    else:
        if len(voices) == 1:
            parts.append(f"{voices[0]}anull[amixed];")
        else:
            joined = "".join(voices)
            parts.append(
                f"{joined}amix=inputs={len(voices)}:normalize=0:"
                f"dropout_transition=0:duration=longest[amixed];"
            )
        # 🔴 loudnorm は BGM を混ぜる**前**に、声だけに掛けること。
        #    後に掛けると BGM の大きさに引きずられて声の大きさが変わる。
        if spec.get("loudnorm", True):
            parts.append("[amixed]loudnorm=I=-14:TP=-1.5:LRA=11[avoice];")
        else:
            parts.append("[amixed]anull[avoice];")

    # ────────────────────────────── BGM
    music = spec.get("music")
    if music and music.get("path"):
        inputs.append({"kind": "music", "path": str(music["path"])})
        mi = len(inputs) - 1
        gain = float(music.get("volume", 0.18))
        fade = min(3.0, max(0.5, duration * 0.05))
        loop = "aloop=loop=-1:size=2147483647," if music.get("loop", True) else ""
        parts.append(
            f"[{mi}:a]{loop}atrim=0:{duration:.4f},asetpts=N/SR/TB,"
            f"volume={gain:.3f},"
            f"afade=t=out:st={max(0.0, duration - fade):.4f}:d={fade:.4f}[amus];"
            f"[avoice][amus]amix=inputs=2:normalize=0:duration=first:"
            f"dropout_transition=0[aout];"
        )
    else:
        parts.append("[avoice]anull[aout];")

    # ────────────────────────────── テロップ
    #
    # 段ごとに1本の帯（concat デマクサのリスト）。作るのは media.write_telop_track。
    tracks = [t for t in (spec.get("telop_tracks") or []) if t]
    src = "[vbase]"
    for j, t in enumerate(tracks):
        inputs.append({"kind": "concat", "path": str(t)})
        ti = len(inputs) - 1
        parts.append(f"[{ti}:v]format=rgba,fps={fps:.5g},setpts=PTS-STARTPTS[t{j}];")
        dst = "[vout]" if j == len(tracks) - 1 else f"[vtel{j}]"
        parts.append(f"{src}[t{j}]overlay=0:0:eof_action=pass:repeatlast=0{dst};")
        src = dst
    if not tracks:
        parts.append("[vbase]null[vout];")

    # 末尾のセミコロンを残すと、ffmpeg が空のフィルタとして読んで落ちる
    graph = "".join(parts).rstrip(";")

    return {
        "inputs": inputs,
        "filter_complex": graph,
        "duration": duration,
        "video_segments": len(segments),
        "audio_clips": len(voices),
        "overlays": len(over),
        "telop_tracks": len(tracks),
    }


def export_timeline(
    spec: dict[str, Any],
    out_path: str,
    on_progress: ProgressFn | None = None,
    work_dir: str | None = None,
) -> dict[str, Any]:
    """タイムラインを書き出す。"""
    from .media import (
        _run_with_progress,
        available_decode_args,
        available_video_args,
        find_ffmpeg,
    )

    plan = build_timeline_graph(spec)

    ffmpeg = find_ffmpeg()
    pixels = max(1, int(spec["width"]) * int(spec["height"]))
    quality = "high" if pixels > 1920 * 1080 else "standard"
    vargs, encoder = available_video_args(ffmpeg, quality)

    if on_progress:
        on_progress(0.03, f"書き出しています（{encoder}）")

    decode = available_decode_args(ffmpeg)
    args: list[str] = []
    for item in plan["inputs"]:
        if item["kind"] == "concat":
            args += ["-f", "concat", "-safe", "0", "-i", item["path"]]
        elif item["kind"] == "media":
            args += [*decode, "-i", item["path"]]
        else:
            args += ["-i", item["path"]]

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    # 🔴 フィルタは必ずファイルで渡すこと。
    #    Windows の CreateProcess は 32,767 文字までで、
    #    クリップが増えると素直に超える（media.export_cut_video のコメント参照）。
    graph_dir = Path(work_dir) if work_dir else out.parent
    graph_dir.mkdir(parents=True, exist_ok=True)
    graph_path = graph_dir / "timeline_graph.txt"
    graph_path.write_text(plan["filter_complex"], encoding="utf-8")

    _run_with_progress(
        [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            *args,
            "-filter_complex_script", str(graph_path),
            "-map", "[vout]", "-map", "[aout]",
            # 🔴 尺を切ること。上に重ねたクリップや BGM が
            #    タイムラインより長いと、その分だけ尻が伸びる。
            "-t", f"{plan['duration']:.4f}",
            *vargs,
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart",
            str(out),
        ],
        total_seconds=plan["duration"],
        on_progress=on_progress,
        base=0.03,
        span=0.95,
        message="動画を書き出しています",
    )

    if on_progress:
        on_progress(1.0, "完了")

    return {
        "out_path": str(out),
        "encoder": encoder,
        "encoder_fallback": encoder in ("libopenh264", "mpeg4"),
        "quality": quality,
        "duration": plan["duration"],
        "video_segments": plan["video_segments"],
        "audio_clips": plan["audio_clips"],
        "overlays": plan["overlays"],
        "size_mb": round(os.path.getsize(out) / 1024 / 1024, 2),
    }
