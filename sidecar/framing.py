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
    # 顔を探す間隔（秒）。
    # 寄り先を決めるだけなら 0.4 秒で足りるが、
    # 口の動きを見るには粗すぎる（喋る速さは毎秒4〜8音）。
    # 調べる区間はもともと数十箇所しかないので、細かくしても総時間は知れている。
    "sample_interval": 0.25,
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

    # ── 「寄らない」判断 ──
    #
    # 🔴 顔が見えていないのに寄ってはいけない。
    #    区間の一部にしか顔が映っていないのに寄ると、
    #    ほとんどの時間は「誰もいない場所のアップ」になる。
    #    確信が持てないときは引きのままにする。
    "min_presence": 0.5,      # 区間のサンプルのうち、顔が見えていた割合
    # 顔の位置がこれ以上ばらつくなら、寄り先が定まらないので寄らない
    "max_wander": 0.18,

    # ── 「誰に寄るか」の判断 ──
    #
    # 🔴 大きく映っている人＝喋っている人ではない。
    #    実際に「喋っていない方の人にアップした」という不具合が出た。
    #    複数人いるときは口の動きで選ぶ。
    "speaker_min_motion": 0.04,   # 口の開きの振れ幅がこれ未満なら「喋っていない」
    "speaker_margin": 1.4,        # 2位の何倍動いていれば話者と言い切れるか
    "mouth_crop_size": 256,       # 口を測るときに顔を切り抜いて拡大する大きさ
}


# ── 顔を拾う ──────────────────────────────────────────────


def sample_faces(
    video_path: str,
    windows: list[tuple[float, float]],
    frame_width: int,
    frame_height: int,
    options: dict[str, Any] | None = None,
    on_progress: ProgressFn | None = None,
    keep_frames: bool = True,
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
                # 🔴 読まないパイプは作らない。
                #    stderr=PIPE のまま一度も読まずにいると、壊れた素材で
                #    ffmpeg がデコードエラーを出し続けたときに 64KB のパイプが埋まり、
                #    ffmpeg が書き込みでブロックする → stdout も進まない →
                #    こちらの read が永久に待つ。この画面にはキャンセルも無いので、
                #    タスクマネージャで殺すしかなくなる。
                stderr=subprocess.DEVNULL,
            )

            index = 0
            try:
                while True:
                    raw = proc.stdout.read(frame_bytes) if proc.stdout else b""
                    if len(raw) < frame_bytes:
                        break
                    image = np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 3).copy()
                    faces = [f for f in detector.detect(image) if f["score"] >= opts["min_score"]]
                    entry: dict[str, Any] = {"t": round(start + index / fps, 3), "faces": faces}
                    # 複数人いるフレームだけ画像を残す。
                    # 誰が喋っているかを口の動きで決めるのに要る。
                    # 全フレーム残すとメモリを食うので、必要なものだけ。
                    if len(faces) > 1 and keep_frames:
                        entry["image"] = image
                    samples.append(entry)
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


def _center(f: dict[str, float]) -> tuple[float, float]:
    return f["x"] + f["w"] / 2, f["y"] + f["h"] / 2


def _track(samples: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """フレームをまたいで同じ人を繋ぐ。

    位置がいちばん近いものを同じ人とみなす。
    数フレームの間に人が入れ替わることは考えなくてよい。
    """
    tracks: list[list[dict[str, Any]]] = []
    for sample in samples:
        for face in sample["faces"]:
            cx, cy = _center(face)
            best, best_dist = None, 1e9
            for track in tracks:
                lx, ly = _center(track[-1]["face"])
                dist = ((cx - lx) ** 2 + (cy - ly) ** 2) ** 0.5
                if dist < best_dist:
                    best, best_dist = track, dist
            # 顔の幅ぶんくらい離れていたら別人とみなす
            if best is not None and best_dist < max(0.12, face["w"]):
                best.append({"t": sample["t"], "face": face})
            else:
                tracks.append([{"t": sample["t"], "face": face}])
    return tracks


def _average(entries: list[dict[str, Any]]) -> dict[str, float]:
    n = len(entries)
    return {
        "x": sum(e["face"]["x"] for e in entries) / n,
        "y": sum(e["face"]["y"] for e in entries) / n,
        "w": sum(e["face"]["w"] for e in entries) / n,
        "h": sum(e["face"]["h"] for e in entries) / n,
        "score": sum(e["face"]["score"] for e in entries) / n,
    }


def _wander(entries: list[dict[str, Any]]) -> float:
    """顔の中心がどれだけ動き回ったか。大きいと寄り先が定まらない。"""
    if len(entries) < 2:
        return 0.0
    xs = [_center(e["face"])[0] for e in entries]
    ys = [_center(e["face"])[1] for e in entries]
    return max(max(xs) - min(xs), max(ys) - min(ys))


def pick_target(
    samples: list[dict[str, Any]],
    start: float,
    end: float,
    read_mouth: Callable[[float, dict[str, float]], float | None] | None,
    options: dict[str, Any] | None = None,
) -> tuple[dict[str, float] | None, str]:
    """区間の寄り先を決める。(顔, 理由) を返す。顔が None なら寄らない。

    🔴 「寄らない」を積極的に選ぶこと。
       顔が見えていない、位置が定まらない、誰が喋っているか分からない——
       どれか一つでも当てはまるなら引きのままにする。
       外した寄りは、寄らなかったことより明らかに悪い。
    """
    opts = {**DEFAULTS, **(options or {})}
    window = [s for s in samples if start <= s["t"] <= end]
    if not window:
        return None, "顔を調べていない"

    # ① そもそも顔が見えているか
    seen = sum(1 for s in window if s["faces"])
    presence = seen / len(window)
    if presence < opts["min_presence"]:
        # 🔴 理由の文字列に値を埋め込まない。
        #    呼び出し側はこの文字列をキーにして件数を集計するので、
        #    値が違うだけで別の理由として並び、
        #    「顔がほとんど映っていない（38%）1件 / 同（41%）1件 / …」と延々続く。
        return None, "顔がほとんど映っていない"

    tracks = [t for t in _track(window) if t]
    if not tracks:
        return None, "顔を追えなかった"

    # 区間を通して映っていた人だけを候補にする
    solid = [t for t in tracks if len(t) / len(window) >= opts["min_presence"]]
    if not solid:
        return None, "同じ人が映り続けていない"

    # ② 1人だけなら迷う余地がない
    if len(solid) == 1:
        entries = solid[0]
        if _wander(entries) > opts["max_wander"]:
            return None, "顔が動き回っていて寄り先が定まらない"
        return _average(entries), "話し手"

    # ③ 複数人。口が動いている人を選ぶ
    if read_mouth is None:
        return None, "誰が喋っているか判断できない"

    motions: list[tuple[float, list[dict[str, Any]]]] = []
    for entries in solid:
        values = []
        for e in entries:
            value = read_mouth(e["t"], e["face"])
            if value is not None:
                values.append(value)
        # 口の「開き具合」ではなく「振れ幅」を見る。
        # 口を開けたまま黙っている人もいるので、動いているかどうかが要る。
        motion = (max(values) - min(values)) if len(values) >= 2 else 0.0
        motions.append((motion, entries))

    motions.sort(key=lambda m: m[0], reverse=True)
    best, second = motions[0][0], motions[1][0]

    if best < opts["speaker_min_motion"]:
        return None, "誰も口を動かしていない"
    if second > 0 and best < second * opts["speaker_margin"]:
        return None, "誰が喋っているか決められない"

    entries = motions[0][1]
    if _wander(entries) > opts["max_wander"]:
        return None, "顔が動き回っていて寄り先が定まらない"
    return _average(entries), f"喋っている人（口の動き {best:.2f}）"


def make_mouth_reader(samples: list[dict[str, Any]]) -> Callable[[float, dict[str, float]], float | None] | None:
    """顔を切り抜いて拡大し、口の開き具合を測る関数を作る。

    🔴 画面全体を渡してはいけない。
       FaceLandmarker は顔が小さいとほぼ拾わない（実測で検出率5%）。
       顔だけを切り抜いて拡大してから渡すと、ちゃんと取れる。
    """
    frames = {s["t"]: s["image"] for s in samples if "image" in s}
    if not frames:
        return None

    try:
        import numpy as np  # noqa: F401
    except ImportError:  # pragma: no cover
        return None

    from .face import make_mouth_reader as make_reader

    reader = make_reader()
    size = int(DEFAULTS["mouth_crop_size"])

    def read(t: float, face: dict[str, float]) -> float | None:
        image = frames.get(t)
        if image is None:
            return None
        h, w = image.shape[:2]
        # 顔の周りに少し余白を足す。ぴったり切ると輪郭が入らず検出しにくい
        pad = 0.35
        x0 = max(0, int((face["x"] - face["w"] * pad) * w))
        x1 = min(w, int((face["x"] + face["w"] * (1 + pad)) * w))
        y0 = max(0, int((face["y"] - face["h"] * pad) * h))
        y1 = min(h, int((face["y"] + face["h"] * (1 + pad)) * h))
        if x1 - x0 < 16 or y1 - y0 < 16:
            return None

        crop = image[y0:y1, x0:x1]
        # 拡大は素朴な繰り返しで十分。輪郭の精度は要らない
        scale = max(1, size // max(1, min(crop.shape[0], crop.shape[1])))
        if scale > 1:
            crop = crop.repeat(scale, axis=0).repeat(scale, axis=1)
        return reader.openness(np.ascontiguousarray(crop))

    return read


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
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """いつ・誰に寄るかを決める。(寄るショット, 寄らなかった理由) を返す。"""
    opts = {**DEFAULTS, **(options or {})}
    if duration <= 0:
        return [], []

    wants = wanted_windows(telops, opts)
    read_mouth = make_mouth_reader(samples)
    skipped: list[dict[str, Any]] = []

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

        face, why = pick_target(samples, start, end, read_mouth, opts)
        if not face:
            skipped.append({"src_start": round(start, 3), "reason": why})
            continue
        rect = closeup_rect(face, telop_position, opts)
        if not rect:
            skipped.append({"src_start": round(start, 3), "reason": "元から顔が大きく映っている"})
            continue

        shots.append({
            "src_start": round(start, 3),
            "src_end": round(min(end, duration), 3),
            "kind": "closeup",
            "reason": reason,
            "target": why,
            "rect": rect,
            "enabled": True,
        })
        cursor = end

    return shots, skipped


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
