"""子プロセスで実行される重い処理。

ここに書いたものは**別プロセスで動く**（worker.py 参照）。
親プロセスには推論ライブラリを読み込ませないので、
親は軽いまま保たれ、クラッシュしても RPC ループは生き残る。
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any, Callable  # noqa: F401

from .asr import make_asr

ProgressFn = Callable[[float, str], None]

#: 既定のモデル。
#:
#: base では「えー」が「栄え」になるなど誤りが多く、②の要件（校正がほぼ不要）を満たせない。
#: large-v3-turbo は large-v3 とほぼ同等の精度で 4 倍程度速い。
#: 🔴 GPU が使えないと実時間の 1〜2 倍かかる。asr/__init__.py の
#:    _enable_cuda_libraries() が効いているかを必ず確認すること。
DEFAULT_MODEL = "large-v3-turbo"

_asr = None


def _get_asr():
    global _asr
    if _asr is None:
        _asr = make_asr()
    return _asr


def default_work_dir(video_path: str) -> Path:
    """素材ごとの作業フォルダ。

    🔴 動画ごとに分けること。
       以前は「動画のあるフォルダ / .ai-video-editor」を素材によらず共有していた。
       同じフォルダに動画が2本あると、audio.wav も analysis.json も clips/ も
       project.json（下書き）も後から開いたほうに上書きされる。
       下書きを保存したのに消えている、という壊れ方をする。

    名前は「元のファイル名 + パスのハッシュ」。
    ファイル名だけだと別フォルダの同名ファイルとぶつかり、
    ハッシュだけだと人がフォルダを見たときにどれか分からない。
    """
    src = Path(video_path)
    stem = re.sub(r'[<>:"/\\|?*\s]+', "_", src.stem)[:40] or "video"
    digest = hashlib.sha1(str(src.resolve()).encode("utf-8")).hexdigest()[:8]
    return src.parent / ".ai-video-editor" / f"{stem}-{digest}"


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


def _make_review_clips(
    video_path: str,
    work_dir: Path,
    analysis: dict[str, Any],
    on_progress: ProgressFn,
    base: float,
    span: float,
) -> int:
    """人間が1件ずつ見る候補ぶんだけ、レビュー用クリップを作る。

    「切って繋いだ結果」を即座に再生できることがレビュー速度を決める（§3.3.3）。

    作るのは**人間が実際に見る候補だけ**。自動で決まる分まで作ると、
    候補118件のうち25件しか使わないクリップを118件ぶん作ることになる。

    🔴 失敗した件数を返すこと。
       以前は1件ずつ握り潰して解析は成功として返していた。
       Mac ではエンコーダの選び方が原因で**全滅**していたのに、
       画面には「クリップがありません」と出るだけで理由が分からなかった。
    """
    from .cut import needs_review
    from .media import make_review_clip

    clips_dir = work_dir / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)
    targets = [c for c in analysis["candidates"] if needs_review(c, analysis.get("review_band"))]
    total = len(targets)
    failed = 0

    for i, c in enumerate(targets):
        if c.get("clip_path"):
            continue
        try:
            clip = make_review_clip(
                video_path,
                str(clips_dir / f"{c['id']}.mp4"),
                c["src_start"],
                c["src_end"],
            )
            c["clip_path"] = clip["path"]
            c["clip_join_at"] = clip["join_at"]
            c["clip_duration"] = clip["duration"]
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"レビュー用クリップの生成に失敗: {c['id']}: {e}", file=sys.stderr, flush=True)
            c["clip_path"] = None
        if total:
            on_progress(base + span * ((i + 1) / total), f"プレビューを準備しています {i + 1}/{total}")

    return failed


def _redetect(params: dict[str, Any], on_progress: ProgressFn) -> dict[str, Any]:
    """文字起こしをやり直さずに、カット候補だけ作り直す。

    🔴 「間の詰め具合」を変える手段がこれしか無い。

       以前は詰め方を変えるには analyze をやり直すしかなく、
       音声抽出と文字起こし（20分素材で12〜18分）から全部走り直していた。
       実質「一度決めた詰め方は変えられない」のと同じで、
       ショート向けの設定に至っては UI からも IPC からも到達できなかった。

       detect_candidates は transcript.json だけあれば動く。
       候補の組み直しは数百ミリ秒で終わる。
    """
    from .clean import clean_transcript
    from .cut import detect_candidates
    from .media import write_json

    transcript_path = params.get("transcript_path")
    video_path = params.get("video_path")
    if not transcript_path or not video_path:
        raise ValueError("transcript_path と video_path が必要です")

    on_progress(0.05, "カット候補を作り直しています")
    transcript = json.loads(Path(transcript_path).read_text(encoding="utf-8"))
    clean_transcript(transcript)

    analysis = detect_candidates(transcript, params.get("options"))
    analysis["video_path"] = video_path

    work_dir = Path(params.get("work_dir") or default_work_dir(video_path))
    failed = _make_review_clips(video_path, work_dir, analysis, on_progress, 0.1, 0.85)
    analysis["clip_failures"] = failed

    write_json(str(work_dir / "analysis.json"), analysis)
    on_progress(1.0, "完了")

    kinds: dict[str, int] = {}
    for c in analysis["candidates"]:
        kinds[c["kind"]] = kinds.get(c["kind"], 0) + 1

    return {
        "cancelled": False,
        "candidates": analysis["candidates"],
        "candidate_count": len(analysis["candidates"]),
        "kinds": kinds,
        "review_band": analysis["review_band"],
        "duration": analysis["duration"],
        "options": analysis.get("options", {}),
        "clip_failures": failed,
    }


def _analyze(params: dict[str, Any], on_progress: ProgressFn) -> dict[str, Any]:
    """動画を解析してカット候補を作る（①カットの中核）。

    動画 → 音声抽出 → 文字起こし → カット候補検出 → analysis.json
    """
    from .cut import detect_candidates
    from .media import (
        ensure_readable_video,
        ensure_writable_dir,
        extract_audio,
        probe_video_info,
        write_json,
    )

    video_path = params.get("video_path")
    if not video_path:
        raise ValueError("video_path が必要です")

    # 🔴 ffmpeg に渡す前に切り分ける。
    #    ffmpeg が失敗してからでは「見つからない／許可が無い／書けない」の
    #    区別がつかず、友達には全部「動画が見つかりません」に見えてしまう。
    ensure_readable_video(video_path)

    work_dir = Path(params.get("work_dir") or default_work_dir(video_path))
    ensure_writable_dir(work_dir, "作業用のフォルダ")

    video_info = probe_video_info(video_path)
    duration = video_info["duration"]
    wav = extract_audio(video_path, str(work_dir / "audio.wav"), on_progress)

    # 文字起こしの進捗を全体の 5%〜85% に割り当てる
    def asr_progress(v: float, m: str = "") -> None:
        on_progress(0.05 + v * 0.8, m)

    transcript = _get_asr().transcribe(
        wav,
        model=params.get("model", DEFAULT_MODEL),
        language=params.get("language", "ja"),
        on_progress=asr_progress,
        is_cancelled=None,
    )
    transcript["duration"] = transcript.get("duration") or duration

    # 🔴 幻聴を落としてから使う。ここを通さないと下流が全部壊れる（clean.py 参照）。
    from .clean import clean_transcript

    speech = clean_transcript(transcript)

    on_progress(0.86, "カット候補を検出しています")

    if speech["kept"] == 0:
        # 使える発話がひとつも無い。ここで候補を作ると
        # 「素材全体が無音」＝全部カット、という壊れた結果になる。
        analysis = {
            "duration": transcript["duration"],
            "word_count": 0,
            "candidates": [],
            "options": {},
            "review_band": {"low": 0.6, "high": 0.9},
        }
    else:
        analysis = detect_candidates(transcript, params.get("options"))

    # レビュー用の短尺クリップを先に作っておく。
    # 「切って繋いだ結果」を即座にループ再生できることがレビュー速度を決める（§3.3.3）。
    #
    # 作るのは**人間が実際に見る候補だけ**。自動承認・自動却下される分まで作ると、
    # 候補118件のうち約25件しか使わないクリップを118件ぶん作ることになる。
    failed = _make_review_clips(video_path, work_dir, analysis, on_progress, 0.86, 0.13)
    analysis["clip_failures"] = failed
    analysis["video_path"] = video_path
    analysis["transcript"] = {
        "backend": transcript.get("backend"),
        "device": transcript.get("device"),
        "model": transcript.get("model"),
        "elapsed_seconds": transcript.get("elapsed_seconds"),
        "realtime_factor": transcript.get("realtime_factor"),
        "text": "".join(s["text"] for s in transcript.get("segments", [])),
    }

    transcript_path = write_json(str(work_dir / "transcript.json"), transcript)
    analysis_path = write_json(str(work_dir / "analysis.json"), analysis)

    on_progress(1.0, "完了")

    kinds: dict[str, int] = {}
    for c in analysis["candidates"]:
        kinds[c["kind"]] = kinds.get(c["kind"], 0) + 1

    return {
        "cancelled": False,
        "analysis_path": analysis_path,
        # テロップ生成はカットレビューのあとに別の呼び出しで行うので、
        # そのときに必要になるパスをここで渡しておく
        "transcript_path": transcript_path,
        "wav_path": wav,
        "work_dir": str(work_dir),
        "video": video_info,
        "video_path": video_path,
        # 素材に使える音声が入っていたか。UI はこれを見て
        "speech": speech,
        "duration": analysis["duration"],
        "candidate_count": len(analysis["candidates"]),
        "kinds": kinds,
        "review_band": analysis["review_band"],
        "transcript": analysis["transcript"],
        "candidates": analysis["candidates"],
    }


def _build_telops(params: dict[str, Any], on_progress: ProgressFn) -> dict[str, Any]:
    """承認されたカットを踏まえてテロップ候補を作る（②）。

    カットのあとに作るのが要点。理由は telop.py の冒頭に書いてある。
    """
    from .telop import build_units

    on_progress(0.1, "テロップを組み立てています")

    transcript_path = params.get("transcript_path")
    if not transcript_path:
        raise ValueError("transcript_path が必要です")
    transcript = json.loads(Path(transcript_path).read_text(encoding="utf-8"))

    # transcript.json は掃除済みのものが書かれているが、
    # 古い解析結果を読み直した場合に備えてもう一度通す（何度通しても結果は同じ）
    from .clean import clean_transcript

    clean_transcript(transcript)

    cuts = [(float(c["src_start"]), float(c["src_end"])) for c in params.get("cuts", [])]
    result = build_units(transcript, cuts, params.get("wav_path"), params.get("options"))

    out_path = params.get("out_path")
    if out_path:
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        Path(out_path).write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    on_progress(1.0, "完了")
    styles: dict[str, int] = {}
    for t in result["telops"]:
        styles[t["style"]] = styles.get(t["style"], 0) + 1

    return {
        "cancelled": False,
        "out_path": out_path,
        "telops": result["telops"],
        "styles": styles,
        "needs_check": sum(1 for t in result["telops"] if t["needs_check"]),
    }


def _plan_framing(params: dict[str, Any], on_progress: ProgressFn) -> dict[str, Any]:
    """③ズーム・画角の自動化（引きと人物アップを自動で切り替える）。

    テロップが決まったあとに呼ぶ。どこで強調するかがテロップ側で決まっているので、
    それをそのまま「寄る理由」に使える。
    """
    from .framing import plan_framing, sample_faces, to_segments, wanted_windows
    from .media import probe_video_info

    video_path = params["video_path"]
    telops = params.get("telops") or []
    telop_position = params.get("telop_position", "top")

    info = probe_video_info(video_path)
    duration = float(params.get("duration") or info["duration"])

    on_progress(0.05, "寄る候補を探しています")
    wants = wanted_windows(telops, params.get("options"))
    if not wants:
        on_progress(1.0, "完了")
        return {"cancelled": False, "shots": [], "segments": [], "faces_found": 0, "windows": 0}

    def face_progress(v: float, m: str = "") -> None:
        on_progress(0.05 + v * 0.9, m)

    samples = sample_faces(
        video_path,
        [(s, e) for s, e, _ in wants],
        info["width"],
        info["height"],
        params.get("options"),
        face_progress,
    )

    shots, skipped = plan_framing(
        samples, telops, duration, telop_position, params.get("options")
    )
    on_progress(1.0, "完了")

    reasons: dict[str, int] = {}
    for shot in shots:
        reasons[shot["reason"]] = reasons.get(shot["reason"], 0) + 1

    skipped_reasons: dict[str, int] = {}
    for item in skipped:
        skipped_reasons[item["reason"]] = skipped_reasons.get(item["reason"], 0) + 1

    return {
        "cancelled": False,
        "shots": shots,
        "segments": to_segments(shots, duration),
        "faces_found": sum(1 for s in samples if s["faces"]),
        "samples": len(samples),
        "windows": len(wants),
        "reasons": reasons,
        # 寄らなかった理由。「なぜアップにならないのか」を画面に出すため
        "skipped": skipped_reasons,
    }


def _export(params: dict[str, Any], on_progress: ProgressFn) -> dict[str, Any]:
    """承認されたカットとテロップを適用して書き出す。"""
    from .cut import keep_ranges, map_time_to_output
    from .media import export_cut_video, png_size, probe_video_info, write_srt, write_telop_track

    video_path = params["video_path"]
    out_path = params["out_path"]
    duration = float(params["duration"])
    cuts = [(float(c["src_start"]), float(c["src_end"])) for c in params.get("cuts", [])]

    keeps = keep_ranges(duration, cuts)
    kept_total = sum(e - s for s, e in keeps)

    work_dir = Path(params.get("work_dir") or default_work_dir(video_path))

    # ── テロップを編集後タイムラインへ写す ──
    telop_tracks: list[str] = []
    burned = 0
    srt_path = None
    telops = params.get("telops") or []
    # 焼き込むかどうかに関わらず、字幕ファイルは書けるようにしておく
    burn = bool(params.get("burn_telops", True))

    if telops:
        on_progress(0.02, "テロップを配置しています")

        if burn:
            # 🔴 テロップの大きさが映像と一致していることを確かめる。
            #    ずれていると overlay は黙って左上に貼り付けるだけなので、
            #    「テロップがずれて見切れる」という形で書き出したあとに初めて気づく。
            #    実際に iPhone の縦動画（回転情報つき）で起きた。
            info = probe_video_info(video_path)
            pw, ph = png_size(telops[0]["png"])
            if (pw, ph) != (info["width"], info["height"]):
                raise ValueError(
                    f"テロップの大きさが映像と違います（テロップ {pw}x{ph} / 映像 {info['width']}x{info['height']}）。"
                    "動画を読み込み直してください。"
                )

        placed: list[dict[str, Any]] = []
        for t in telops:
            out_start = map_time_to_output(keeps, float(t["src_start"]))
            out_end = map_time_to_output(keeps, float(t["src_end"]))
            # まるごとカットに入った、または詰められて一瞬になったものは出さない
            if out_end - out_start < 0.15:
                continue
            placed.append({
                "out_start": out_start,
                "out_end": out_end,
                "png": t.get("png"),
                "text": t.get("text", ""),
                # 何段目か。同じ時間に重なるテロップは段ごとに別の帯にする
                "lane": int(t.get("lane") or 0),
            })

        if placed:
            if params.get("write_srt", True):
                srt_path = write_srt(str(Path(out_path).with_suffix(".srt")), placed)
            if burn:
                """
                🔴 段ごとに帯を分ける。
                   1本の帯は「同時に1枚」しか出せない（前を切り上げるしかない）。
                   同じ時間に2枚以上出すには、段の数だけ帯を作って重ねる。
                """
                lanes = sorted({int(p.get("lane") or 0) for p in placed})
                for lane in lanes:
                    same = [p for p in placed if int(p.get("lane") or 0) == lane]
                    telop_tracks.append(
                        write_telop_track(
                            str(work_dir / "telops" / f"track-{lane}.txt"),
                            params["blank_png"],
                            same,
                            kept_total,
                        )
                    )
                burned = len(placed)

    result = export_cut_video(
        video_path,
        out_path,
        keeps,
        telop_tracks=telop_tracks,
        fps=float(params.get("fps") or 30.0),
        framing=params.get("framing") or None,
        on_progress=on_progress,
        # フィルタのファイルは作業フォルダへ。書き出し先（利用者が選んだ場所）を
        # 中間ファイルで汚さない。
        work_dir=str(work_dir),
        # BGM。{"path": ..., "volume": 0〜1, "loop": true} を想定
        music=params.get("music") or None,
    )
    # ── 編集ソフトへ渡す用のタイムライン ──
    #
    # 🔴 焼き込んだ MP4 だけを出口にしない。
    #    そこで止まると BGM も差し込み映像も足せず、あとからカットを1箇所直すだけで
    #    テロップが単語の途中で切れる。
    #    「カットの判断はこのアプリ、仕上げは編集ソフト」という使い分けができるようにする。
    fcpxml_path = None
    if params.get("write_fcpxml"):
        from .fcpxml import write_fcpxml

        info = probe_video_info(video_path)
        fcpxml_path = write_fcpxml(
            str(Path(out_path).with_suffix(".fcpxml")),
            video_path,
            keeps,
            fps=float(params.get("fps") or info["fps"] or 30.0),
            width=info["width"],
            height=info["height"],
            duration=duration,
            telops=[{"src_start": t["src_start"], "src_end": t["src_end"], "text": t.get("text", "")}
                    for t in telops],
        )

    result["cancelled"] = False
    result["original_seconds"] = round(duration, 2)
    result["cut_count"] = len(cuts)
    result["telop_count"] = burned
    result["srt_path"] = srt_path
    result["fcpxml_path"] = fcpxml_path
    return result


HEAVY_HANDLERS: dict[str, Callable[..., Any]] = {
    "transcribe": _transcribe,
    "analyze": _analyze,
    "redetect": _redetect,
    "build_telops": _build_telops,
    "plan_framing": _plan_framing,
    "export": _export,
}


def dispatch_heavy(method: str, params: dict[str, Any], on_progress: ProgressFn) -> Any:
    handler = HEAVY_HANDLERS.get(method)
    if handler is None:
        raise ValueError(f"重い処理として未知のメソッドです: {method}")
    return handler(params, on_progress)
