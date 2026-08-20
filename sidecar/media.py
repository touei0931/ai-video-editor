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

from .ffmpeg.platform_args import (
    available_decode_args,
    available_review_clip_args,
    available_video_args,
)

#: エンコーダの判定は ffmpeg を実際に走らせるので、一度だけにする。
#: レビュー用クリップは候補の数だけ作るため、毎回調べると回数ぶん無駄が乗る。
_clip_encoder_cache: tuple[list[str], str] | None = None


def _clip_encoder(ffmpeg: str) -> tuple[list[str], str]:
    global _clip_encoder_cache
    if _clip_encoder_cache is None:
        _clip_encoder_cache = available_review_clip_args(ffmpeg)
    return _clip_encoder_cache

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


def _ffmpeg_error(stderr: str) -> RuntimeError:
    """ffmpeg の失敗を、画面に出してよい形にする。

    🔴 英語のログをそのまま画面に出さない。
       以前は stderr の末尾1500文字をそのままエラー本文にしていた。
       友達には読めないうえ、次に何をすればいいかも分からない。
       原因の切り分けに要る全文は stderr に流し、Electron 側が記録に残す。
    """
    text = stderr or ""
    print(text[-4000:], file=sys.stderr, flush=True)

    lowered = text.lower()
    if "no such file" in lowered or "does not exist" in lowered:
        return RuntimeError("元の動画が見つかりません。移動や削除をしていないか確認してください。")
    if "no space left" in lowered or "disk full" in lowered:
        return RuntimeError("保存先の空き容量が足りません。空きを作ってからもう一度お試しください。")
    if "permission denied" in lowered:
        return RuntimeError("保存先に書き込めません。別の場所を選んでください。")
    if "invalid data" in lowered or "moov atom not found" in lowered:
        return RuntimeError("動画ファイルが壊れているようです。別の動画でお試しください。")
    return RuntimeError("動画の処理に失敗しました。もう一度お試しください。")


def _run(cmd: list[str]) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        raise _ffmpeg_error(result.stderr or "")
    return result.stdout or ""


#: 実行中の ffmpeg の PID を親へ知らせるための差し込み口。
#: worker.py がここに関数を入れる。中断のときに ffmpeg まで確実に止めるために使う。
on_ffmpeg_pid: Callable[[int], None] | None = None


def _run_with_progress(
    cmd: list[str],
    total_seconds: float,
    on_progress: ProgressFn | None,
    base: float,
    span: float,
    message: str,
) -> None:
    """ffmpeg を進捗つきで走らせる。

    🔴 -progress で進捗を出させること。
       以前は subprocess.run で完了まで待っており、画面の進捗は 5% で固まったまま
       数分〜十数分動かなかった。友達は「壊れた」と判断して強制終了する。

    🔴 中断のためにも要る。
       ワーカーのキャンセル判定は「子から次の行が届いたとき」にしか働かない。
       出力が無い区間は、キャンセルを押しても効かない。
       進捗行が流れていれば、その隙間が消える。

    🔴 stderr は stdout にまとめる。
       別のパイプにして読まないでいると、ffmpeg がエラー行を出し続けたときに
       64KB のパイプが埋まって**書き込みでブロックし、永久に固まる**。
       読まないパイプは作らない。
    """
    proc = subprocess.Popen(
        [*cmd, "-progress", "pipe:1", "-nostats"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    if on_ffmpeg_pid:
        on_ffmpeg_pid(proc.pid)

    tail: list[str] = []
    assert proc.stdout
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        if line.startswith("out_time_ms="):
            try:
                done = int(line.split("=", 1)[1]) / 1_000_000
            except ValueError:
                continue
            if on_progress and total_seconds > 0:
                ratio = max(0.0, min(1.0, done / total_seconds))
                on_progress(base + span * ratio, message)
        elif not line.startswith(
            ("frame=", "fps=", "bitrate=", "total_size=", "out_time=", "dup_frames=",
             "drop_frames=", "speed=", "progress=", "stream_")
        ):
            # 進捗以外＝エラー出力。末尾だけ残す
            tail.append(line)
            if len(tail) > 40:
                tail.pop(0)

    code = proc.wait()
    if code != 0:
        raise _ffmpeg_error("\n".join(tail))


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

    🔴 重なっているテロップは、**前を切り上げて**次を定刻に出すこと。
    この帯は1本しかないので、重なりをそのまま並べると後ろへずれていく。
    テロップの開始時刻は声が出た時刻なので、ずらすと声と文字が合わなくなる。
    しかも1枚ずれると以降が芋づる式にずれるため、後半ほど大きく狂う。
    """
    lines: list[str] = []
    cursor = 0.0

    def blank(seconds: float) -> None:
        if seconds > 0.001:
            lines.append(f"file '{_concat_path(blank_png)}'")
            lines.append(f"duration {seconds:.3f}")

    ordered = sorted(telops, key=lambda x: float(x["out_start"]))
    for i, t in enumerate(ordered):
        start = max(cursor, float(t["out_start"]))
        end = max(start, float(t["out_end"]))
        # 次が始まる時刻で必ず打ち切る（次を待たせない）
        if i + 1 < len(ordered):
            end = min(end, float(ordered[i + 1]["out_start"]))
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


def _crop_box(rect: dict[str, float], width: int, height: int) -> tuple[int, int, int, int]:
    """正規化座標の矩形を、実際の画素の切り出し範囲にする。

    幅・高さは必ず偶数にする。奇数だと yuv420p にできず ffmpeg が落ちる。
    """
    cw = max(16, int(round(rect["w"] * width / 2)) * 2)
    ch = max(16, int(round(rect["h"] * height / 2)) * 2)
    cw, ch = min(cw, width), min(ch, height)
    cx = max(0, min(width - cw, int(round(rect["x"] * width))))
    cy = max(0, min(height - ch, int(round(rect["y"] * height))))
    return cw, ch, cx, cy


def _split_by_framing(
    keeps: list[tuple[float, float]],
    framing: list[dict[str, Any]],
) -> list[tuple[float, float, dict[str, float] | None]]:
    """残す区間を画角の切り替わりでさらに分ける。

    画角の区間は元素材の時刻で来るので、残す区間との重なりを取る。
    重なりが極端に短い断片は、ジャンプカットを増やすだけなので前に吸収させる。
    """
    if not framing:
        return [(s, e, None) for s, e in keeps]

    pieces: list[tuple[float, float, dict[str, float] | None]] = []
    for ks, ke in keeps:
        cursor = ks
        for seg in sorted(framing, key=lambda x: float(x["src_start"])):
            fs, fe = float(seg["src_start"]), float(seg["src_end"])
            start, end = max(cursor, fs), min(ke, fe)
            if end - start <= 0.04:
                continue
            if start - cursor > 0.04:
                pieces.append((round(cursor, 3), round(start, 3), None))
            rect = seg.get("rect")
            wide = not rect or (rect["w"] >= 0.999 and rect["h"] >= 0.999)
            pieces.append((round(start, 3), round(end, 3), None if wide else rect))
            cursor = end
        if ke - cursor > 0.04:
            pieces.append((round(cursor, 3), round(ke, 3), None))

    return pieces or [(s, e, None) for s, e in keeps]


def export_cut_video(
    video_path: str,
    out_path: str,
    keeps: list[tuple[float, float]],
    telop_track: str | None = None,
    fps: float = 30.0,
    framing: list[dict[str, Any]] | None = None,
    on_progress: ProgressFn | None = None,
    work_dir: str | None = None,
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
    # 解像度に見合ったビットレートを選ぶ。1080p 用の固定値のままだと 4K で破綻する。
    info = probe_video_info(video_path)
    pixels = max(1, info["width"] * info["height"])
    quality = "high" if pixels > 1920 * 1080 else "standard"
    vargs, encoder = available_video_args(ffmpeg, quality)

    if on_progress:
        on_progress(0.05, f"書き出しています（{encoder}）")

    width, height = info["width"], info["height"]

    # ── 音声は残す区間ごと ──
    #
    # 🔴 繋ぎ目に短いフェードを入れる。
    #    波形が0を跨がない位置で切ると「プチッ」というクリックノイズが乗る。
    #    20分素材で100箇所カットすれば100回鳴るし、
    #    書き出したあとに直すのは全繋ぎ目を手で探す作業になる。
    #
    #    クロスフェード（重ねる方式）にはしない。重ねると尺が縮み、
    #    テロップの時刻対応（§11.2）が狂うため。
    #    各区間の端を数フレームだけ絞れば、尺を変えずにクリックは消える。
    #
    # 🔴 音声は**画角の切り替えでは分割しない**。
    #    画角が変わっても音は切れていないので、そこでフェードを入れると
    #    喋っている途中で音量が凹む。
    parts: list[str] = []
    for i, (start, end) in enumerate(keeps):
        length = end - start
        fade = min(FADE_SECONDS, length / 4)
        parts.append(
            f"[0:a]atrim=start={start}:end={end},asetpts=PTS-STARTPTS,"
            f"afade=t=in:st=0:d={fade:.4f},"
            f"afade=t=out:st={max(0.0, length - fade):.4f}:d={fade:.4f}[a{i}];"
        )
    audio_inputs = "".join(f"[a{i}]" for i in range(len(keeps)))

    # ── 映像は「残す区間 × 画角」で分ける ──
    #
    # ③ズーム・画角の自動化（引きと人物アップの切り替え）はここで効く。
    # 寄りはゆっくり動かさず、切り替える。切り出した後は必ず元の大きさに戻す。
    # 戻さないと区間ごとに解像度が変わって concat できない。
    pieces = _split_by_framing(keeps, framing or [])
    for i, (start, end, rect) in enumerate(pieces):
        chain = f"[0:v]trim=start={start}:end={end},setpts=PTS-STARTPTS"
        if rect is not None:
            cw, ch, cx, cy = _crop_box(rect, width, height)
            if (cw, ch) != (width, height):
                chain += f",crop={cw}:{ch}:{cx}:{cy},scale={width}:{height},setsar=1"
        parts.append(chain + f"[v{i}];")
    video_inputs = "".join(f"[v{i}]" for i in range(len(pieces)))

    # 🔴 音量の正規化は filter_complex の中に入れること。
    #    -af は filter_complex の出力ラベルには適用できず "Invalid argument" になる
    #    （-vf でも同じ罠を踏んでいる。make_review_clip のコメント参照）。
    #
    #    配信基準の -14 LUFS へ揃える。素材ごとに音量がバラバラだと、
    #    視聴者が毎回ボリュームを触ることになる。
    loudnorm = "loudnorm=I=-14:TP=-1.5:LRA=11"

    # 映像と音声を別々に繋ぐ。分割数が違うので、まとめて concat できない。
    joined = (
        f"{video_inputs}concat=n={len(pieces)}:v=1:a=0[vcat];"
        f"{audio_inputs}concat=n={len(keeps)}:v=0:a=1[acat];"
        f"[acat]{loudnorm}[aout];"
    )

    decode = available_decode_args(ffmpeg)
    inputs = [*decode, "-i", video_path]
    if telop_track:
        inputs += ["-f", "concat", "-safe", "0", "-i", telop_track]
        filter_complex = (
            "".join(parts) + joined
            # 静止画のままだとタイムスタンプが疎なので、動画と同じ fps に揃える
            + f"[1:v]format=rgba,fps={fps:.5g},setpts=PTS-STARTPTS[ov];"
            # repeatlast=0 にしないと、テロップ列が尽きた後も最後の1枚が残り続ける
            "[vcat][ov]overlay=0:0:eof_action=pass:repeatlast=0[vout]"
        )
    else:
        filter_complex = "".join(parts) + joined + "[vcat]null[vout]"

    Path(out_path).parent.mkdir(parents=True, exist_ok=True)

    # 🔴 フィルタはファイルに書いて渡すこと。
    #
    #    以前はコマンドライン引数に直接載せていた。区間ごとに音声約120文字・映像約62文字を
    #    連結するので、区間が増えると青天井に伸びる。実測:
    #        10分・カット60箇所・寄りなし   → 区間 61 →  12,350 文字
    #        20分・カット118箇所・寄りなし  → 区間119 →  23,922 文字
    #        20分・カット118箇所・寄り80    → 区間199 →  33,445 文字  ← 超過
    #        40分・カット250箇所・寄り170   → 区間421 →  71,269 文字  ← 超過
    #    Windows の CreateProcess の上限は 32,767 文字。
    #    つまり **20分素材に人物アップが付いた時点で書き出せなくなっていた**。
    #    出るのは「パラメーターが間違っています」だけで、原因には辿り着けない。
    #
    #    検証（T5）は25秒のクリップなので、この経路は一度も踏まれていなかった。
    #    ファイル渡しなら長さの上限が消えるうえ、失敗時にこのファイルを見れば再現できる。
    graph_dir = Path(work_dir) if work_dir else Path(out_path).parent
    graph_dir.mkdir(parents=True, exist_ok=True)
    graph_path = graph_dir / "filter_graph.txt"
    graph_path.write_text(filter_complex, encoding="utf-8")

    kept = sum(e - s for s, e in keeps)
    _run_with_progress(
        [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            *inputs,
            "-filter_complex_script", str(graph_path),
            "-map", "[vout]", "-map", "[aout]",
            *vargs,
            "-c:a", "aac", "-b:a", "192k",
            # 🔴 これが無いと、Web にそのまま上げたとき頭出しに時間がかかる。
            #    メタデータがファイル末尾に置かれ、再生前に全体を読む必要が出るため。
            "-movflags", "+faststart",
            out_path,
        ],
        total_seconds=kept,
        on_progress=on_progress,
        base=0.05,
        span=0.93,
        message="動画を書き出しています",
    )

    if on_progress:
        on_progress(1.0, "完了")

    return {
        "out_path": out_path,
        "encoder": encoder,
        # 🔴 ソフトウェアエンコーダに落ちたかを呼び出し側に伝える。
        #    mpeg4 まで落ちると画質が明らかに悪くなるが、
        #    IT知識のない人がエンコーダ名を見て異常だと気づくのは無理。
        "encoder_fallback": encoder in ("libopenh264", "mpeg4"),
        "quality": quality,
        "kept_seconds": round(kept, 2),
        "segments": len(keeps),
        "video_pieces": len(pieces),
        "closeups": sum(1 for _, _, r in pieces if r is not None),
        "size_mb": round(os.path.getsize(out_path) / 1024 / 1024, 2),
    }


#: 繋ぎ目のフェード長。30fps で約1フレーム。
#: これ以上長いと語頭が痩せて聞こえ、短いとクリックが残る。
FADE_SECONDS = 0.035

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

    decode = available_decode_args(ffmpeg)
    cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error"]
    for start, length in segments:
        cmd += [*decode, "-ss", f"{start:.3f}", "-t", f"{length:.3f}", "-i", video_path]

    filters: list[str] = []
    for i, (_, length) in enumerate(segments):
        filters.append(f"[{i}:v]setpts=PTS-STARTPTS[v{i}]")
        # 🔴 書き出しと同じフェードを掛けること。
        #    ここだけ素のまま繋ぐと、実際の書き出しには乗らないクリックノイズを
        #    聞かせることになり、「繋ぎが不自然」という誤った判断をさせてしまう。
        fade = min(FADE_SECONDS, length / 4)
        filters.append(
            f"[{i}:a]asetpts=PTS-STARTPTS,"
            f"afade=t=in:st=0:d={fade:.4f},"
            f"afade=t=out:st={max(0.0, length - fade):.4f}:d={fade:.4f}[a{i}]"
        )

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

    # 🔴 エンコーダを決め打ちしてはいけない。
    #    ここは以前 libopenh264 と直書きしていた。Mac に同梱する ffmpeg は
    #    「外部ライブラリを一切リンクしない」方針（VideoToolbox のみ）でビルドしており、
    #    libopenh264 が入っていない。その結果 Mac では**全候補のクリップ生成が失敗**し、
    #    「切って繋いだ結果を聞いて判断する」というこのアプリの中核が丸ごと死んでいた。
    #    しかも例外は1件ずつ握り潰されるので、解析は成功として返っていた。
    #
    #    プラットフォーム分岐が1文字も無いので npm run guard も素通りする。
    #    「分岐が無い＝Mac で壊れない」は成り立たない。実際に使えるものを選ぶこと。
    encoder, _name = _clip_encoder(ffmpeg)

    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    _run(cmd + [
        "-filter_complex", ";".join(filters),
        "-map", "[vout]", "-map", "[aout]",
        *encoder,
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


def _srt_time(seconds: float) -> str:
    ms = int(round(max(0.0, seconds) * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(path: str, entries: list[dict[str, Any]]) -> str:
    """字幕ファイルを書く。

    🔴 焼き込み済みの動画しか出せないと、後工程が全部詰む。
       BGM も SE も B-roll も足せず、あとでカットを1箇所足すだけで
       テロップが単語の途中で切れる。
       SRT があれば「カットはこのアプリ、テロップは編集ソフト」という
       現実的な使い分けができる。

    時刻は**編集後タイムライン**で書く。元素材の時刻で書くと、
    カットを適用した動画に読み込んだ瞬間にずれる。
    """
    lines: list[str] = []
    # 重なりは前を切り上げて解消する。焼き込みと同じ見え方にするため。
    # 重なった字幕を出しっぱなしにすると、読み込んだ先の挙動（後ろを待たせる／
    # 2行重ねて出す）がソフトごとに変わり、どれも意図した見え方にならない。
    ordered = sorted(entries, key=lambda x: float(x["out_start"]))
    number = 0
    for i, e in enumerate(ordered):
        end = float(e["out_end"])
        if i + 1 < len(ordered):
            end = min(end, float(ordered[i + 1]["out_start"]))
        if end - float(e["out_start"]) < 0.02:
            continue
        number += 1
        lines.append(str(number))
        lines.append(f"{_srt_time(e['out_start'])} --> {_srt_time(end)}")
        lines.append(str(e["text"]).replace("\r", ""))
        lines.append("")

    Path(path).parent.mkdir(parents=True, exist_ok=True)
    # BOM 付きにしておくと、Windows のメモ帳や一部の編集ソフトで文字化けしない
    Path(path).write_text("\n".join(lines), encoding="utf-8-sig")
    return path


def write_json(path: str, data: Any) -> str:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return path
