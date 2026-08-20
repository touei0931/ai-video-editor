"""③ズーム・画角の自動化（引きと人物アップを自動で切り替える機能）。

要件:
  通常は引きの画角 / 強調したい箇所は人物をアップ / 視聴者が飽きそうな箇所で画角変化

🔴 ゆっくり寄る動き（ズームイン）ではなく、**切り替える**（パンチイン）。
   話し手が映る動画で編集者がやるのはカメラを寄せる動きではなく、
   寄った画に「切る」こと。動きを付けると素人っぽくなるうえ、
   書き出しのフィルタも重くなる。

🔴 寄り先はテロップの位置を避ける。
   テロップの置き場所を決めてから画角を決める。逆順にすると
   「寄ったら顔がテロップに突っ込む」が量産される。

座標系（§11.2）:
   ここが返すのは**すべて元素材のタイムコード（src_*）**と、
   元素材の正規化座標（0〜1）の矩形。
   編集後タイムラインへの変換は書き出し時にだけ行う。
"""

from __future__ import annotations

import subprocess
import sys
from typing import Any, Callable

ProgressFn = Callable[[float, str], None]

DEFAULTS = {
    # 顔を探す間隔（秒）。細かくしても寄り先はほとんど変わらない
    "sample_interval": 0.4,
    # 解析用の高さ。顔の位置を知るのに元解像度は要らない
    "analysis_height": 360,
    # 1ショットの最短の長さ。これより短い切り替えは目が疲れるだけ
    "min_shot": 1.6,
    # 同じ画角がこれだけ続いたら、飽きる前に変える
    "boredom": 14.0,
    # アップにしたとき、顔の高さが画面のどれくらいを占めるか
    "face_ratio": 0.30,
    # 寄れる限界。これ以上寄ると元素材の粗が見える
    "max_zoom": 2.2,
    # 顔がこの確度未満なら見なかったことにする
    "min_score": 0.5,
}


# ── 顔を拾う ──────────────────────────────────────────────


def sample_faces(
    video_path: str,
    windows: list[tuple[float, float]],
    frame_width: int,
    frame_height: int,
    options: dict[str, Any] | None = None,
    on_progress: ProgressFn | None = None,
) -> list[dict[str, Any]]:
    """指定した区間だけ顔を探し、時刻つきで返す。

    🔴 素材全体を等間隔で舐めてはいけない。
       実測（30秒の縦動画）で 18.8 倍速。20分素材なら 64 秒かかり、
       文字起こし（50倍速で24秒）より遅くなって解析時間の主役になってしまう。
       寄る候補は多くても数十箇所なので、**そこだけ調べれば足りる**。
       区間ごとに入力側 -ss で頭出しすれば、素材の長さに関係なく一定時間で済む。

    ffmpeg から生の RGB を直接受け取る。
    PNG をディスクに書くのは、書く時間も読む時間も無駄。
    """
    from .face import make_detector
    from .media import find_ffmpeg

    opts = {**DEFAULTS, **(options or {})}
    if frame_width <= 0 or frame_height <= 0 or not windows:
        return []

    try:
        import numpy as np
    except ImportError:  # pragma: no cover
        return []

    height = int(opts["analysis_height"])
    width = int(round(frame_width / frame_height * height / 2)) * 2
    fps = 1.0 / float(opts["sample_interval"])
    frame_bytes = width * height * 3

    ffmpeg = find_ffmpeg()
    detector = make_detector()
    samples: list[dict[str, Any]] = []

    try:
        for i, (start, end) in enumerate(windows):
            length = max(0.2, end - start)
            proc = subprocess.Popen(
                [
                    ffmpeg, "-hide_banner", "-loglevel", "error",
                    "-ss", f"{max(0.0, start):.3f}", "-t", f"{length:.3f}",
                    "-i", video_path,
                    "-vf", f"fps={fps:.5g},scale={width}:{height}",
                    "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )

            index = 0
            try:
                while True:
                    raw = proc.stdout.read(frame_bytes) if proc.stdout else b""
                    if len(raw) < frame_bytes:
                        break
                    image = np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 3).copy()
                    faces = [f for f in detector.detect(image) if f["score"] >= opts["min_score"]]
                    samples.append({"t": round(start + index / fps, 3), "faces": faces})
                    index += 1
            finally:
                if proc.stdout:
                    proc.stdout.close()
                proc.wait()

            if on_progress:
                on_progress((i + 1) / len(windows), "顔の位置を調べています")
    finally:
        detector.close()

    samples.sort(key=lambda s: s["t"])
    return samples


# ── 顔を1人に絞る ─────────────────────────────────────────


def _pick_main_face(faces: list[dict[str, float]]) -> dict[str, float] | None:
    """寄り先の顔を選ぶ。

    複数人いるときは**一番大きく映っている顔**を選ぶ。
    話者判定（口の動きと音量の相関）はここではやらない。
    大きく映っている＝カメラに近い＝主役、で実用上ほぼ外さない。
    """
    if not faces:
        return None
    return max(faces, key=lambda f: f["w"] * f["h"])


def _face_at(samples: list[dict[str, Any]], start: float, end: float) -> dict[str, float] | None:
    """区間の顔の平均。ブレを均すために平均を取る。"""
    picked = [
        _pick_main_face(s["faces"])
        for s in samples
        if start <= s["t"] <= end
    ]
    picked = [f for f in picked if f]
    if not picked:
        return None

    n = len(picked)
    return {
        "x": sum(f["x"] for f in picked) / n,
        "y": sum(f["y"] for f in picked) / n,
        "w": sum(f["w"] for f in picked) / n,
        "h": sum(f["h"] for f in picked) / n,
        "score": sum(f["score"] for f in picked) / n,
    }


# ── 寄りの画角を作る ──────────────────────────────────────


def closeup_rect(
    face: dict[str, float],
    telop_position: str,
    options: dict[str, Any] | None = None,
) -> dict[str, float] | None:
    """顔に寄った画角を求める。正規化座標（0〜1）で返す。

    画面の縦横比は変えない。変えると書き出しで引き伸ばされる。
    """
    opts = {**DEFAULTS, **(options or {})}

    # 顔が画面の face_ratio を占める大きさに寄る
    zoom = face["h"] / opts["face_ratio"] if face["h"] > 0 else 1.0
    zoom = max(1.0 / opts["max_zoom"], min(1.0, zoom))
    if zoom > 0.92:
        # ほとんど寄れない。元から顔が大きく映っているので、切り替える意味がない
        return None

    w, h = zoom, zoom
    cx = face["x"] + face["w"] / 2
    cy = face["y"] + face["h"] / 2

    # 🔴 テロップを避ける。
    #    テロップが上にあるなら顔を画面の下寄りに、下にあるなら上寄りに置く。
    #    そうしないと、寄った瞬間に顔とテロップが重なる。
    if telop_position == "top":
        anchor = 0.62
    elif telop_position == "bottom":
        anchor = 0.40
    else:
        anchor = 0.5

    x = cx - w / 2
    y = cy - h * anchor

    # 画面の外にはみ出さないように寄せる
    x = max(0.0, min(1.0 - w, x))
    y = max(0.0, min(1.0 - h, y))
    return {"x": round(x, 4), "y": round(y, 4), "w": round(w, 4), "h": round(h, 4)}


WIDE = {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}


def wanted_windows(
    telops: list[dict[str, Any]],
    options: dict[str, Any] | None = None,
) -> list[tuple[float, float, str]]:
    """寄りたい時刻を集める。顔を探すのはこの区間だけでよい。

    寄る理由は2つだけ:
      1. 強調（感嘆符・大きな声・強調語）… 要件「強調したい箇所は人物をアップ」
      2. 同じ画角が続きすぎた … 要件「視聴者が飽きそうな箇所で画角変化」
    それ以外は引き（元の画角のまま）。
    """
    opts = {**DEFAULTS, **(options or {})}
    wants: list[tuple[float, float, str]] = []

    for t in telops:
        if t.get("style") == "emphasis" or t.get("highlight"):
            wants.append((float(t["src_start"]), float(t["src_end"]), "強調"))

    # 飽き防止。最後に画角が変わってから boredom 秒たっていたら1つ入れる
    last_change = 0.0
    for t in sorted(telops, key=lambda x: float(x["src_start"])):
        start = float(t["src_start"])
        if any(s <= start <= e for s, e, _ in wants):
            last_change = start
            continue
        if start - last_change >= opts["boredom"]:
            wants.append((start, float(t["src_end"]), "画角が続きすぎ"))
            last_change = start

    wants.sort()
    return wants


def plan_framing(
    samples: list[dict[str, Any]],
    telops: list[dict[str, Any]],
    duration: float,
    telop_position: str = "top",
    options: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """いつ寄るかを決める。"""
    opts = {**DEFAULTS, **(options or {})}
    if duration <= 0:
        return []

    wants = wanted_windows(telops, opts)

    # ── 重なりと短すぎるショットを整理する ──
    shots: list[dict[str, Any]] = []
    cursor = 0.0
    for start, end, reason in wants:
        start = max(start, cursor)
        # 短いショットは目が疲れるだけなので伸ばす
        end = max(end, start + opts["min_shot"])
        if end <= start:
            continue
        if start - cursor < opts["min_shot"] and shots:
            # 直前の寄りとくっつける
            shots[-1]["src_end"] = round(end, 3)
            cursor = end
            continue

        face = _face_at(samples, start, end)
        if not face:
            continue
        rect = closeup_rect(face, telop_position, opts)
        if not rect:
            continue

        shots.append({
            "src_start": round(start, 3),
            "src_end": round(min(end, duration), 3),
            "kind": "closeup",
            "reason": reason,
            "rect": rect,
            "enabled": True,
        })
        cursor = end

    return shots


def to_segments(
    shots: list[dict[str, Any]], duration: float
) -> list[dict[str, Any]]:
    """寄りのショットの隙間を引きで埋めて、素材全体を覆う区間列にする。"""
    out: list[dict[str, Any]] = []
    cursor = 0.0
    for shot in sorted(shots, key=lambda s: s["src_start"]):
        if not shot.get("enabled", True):
            continue
        if shot["src_start"] - cursor > 0.02:
            out.append({"src_start": round(cursor, 3), "src_end": shot["src_start"],
                        "kind": "wide", "rect": dict(WIDE)})
        out.append(shot)
        cursor = shot["src_end"]

    if duration - cursor > 0.02:
        out.append({"src_start": round(cursor, 3), "src_end": round(duration, 3),
                    "kind": "wide", "rect": dict(WIDE)})
    return out
