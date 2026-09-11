"""声で「誰が喋っているか」を見分け、覚えた声に名前と色を結び付ける。

用途:
    VTuber のコラボ配信の切り抜きで、喋っている人ごとにテロップの色を変える。
    「白上フブキは白、猫又おかゆは紫」のように、人ごとの色をあらかじめ登録しておき、
    テロップ1枚ずつの声を登録済みの声と見比べて色を付ける。

仕組み:
    1. テロップの区間の音を切り出し、話者埋め込み（声の特徴を表す 512 次元のベクトル）にする
    2. 登録済みの声（覚えたベクトルの平均）とのコサイン類似度を取る
    3. いちばん近い声が閾値を超え、2番目と十分に離れていれば、その人とみなす
    4. 誰にも当たらなかった声は、似たものどうしで「声1・声2…」にまとめて画面に出す。
       人が名前を付けると、その区間の声を覚える（次からは自動で当たる）

🔴 モデルは 3D-Speaker の ERes2Net（ONNX、Apache-2.0）を sherpa-onnx で回す。
   torch は使わない。配布物が 2GB 太るうえ、Mac 版に載らない。
   WeSpeaker の CAM++（VoxCeleb）も試したが、ゲーム音と BGM の乗ったコラボ配信では
   話者の違いがほぼ出なかった（同じ人どうし 0.49 / 別の人 0.51）。
   ERes2Net は同じ時間帯どうし 0.50 / 別の時間帯 0.27 と差が出た（2026-09-11、実素材）。

🔴 確信が無いものに色を付けないこと。
   間違った色が付くのは、色が付かないより悪い（誰の発言か分からないまま出る）。
   当たらなかったものは「声n」として人に見せ、名前を付けてもらう。

🔴 登録する声は複数の区間から集めること。
   1枚（1〜2秒）の声だけで覚えると、叫び声と普通の声で別人になる。
   同じ人と分かった区間は全部足す（上限あり）。
"""

from __future__ import annotations

import json
import sys
import time
import wave
from pathlib import Path
from typing import Any

# 🔴 numpy を読み込み時に要求しないこと。
#    このモジュールは rpc の env（環境の診断）からも読まれる。
#    検査の環境には numpy が無く、import の時点で落ちると
#    診断そのものが出せなくなる（CI の煙テストで踏んだ、2026-09-11）。
#    実際に声を見比べる所（embed / match）でだけ要る。
try:
    import numpy as np
except ImportError:  # noqa: F401
    np = None  # type: ignore[assignment]

#: 同梱モデルの名前。scripts/fetch_models.py が vendor/models/ に置く
MODEL_NAME = "speaker_eres2net.onnx"

DEFAULTS: dict[str, Any] = {
    # これより短い区間は声の特徴が取れない（叫び1つでも 0.6 秒はある）
    "min_seconds": 0.6,
    # 登録済みの声とみなす類似度の下限。
    # 実素材（ゲーム音つきのコラボ配信）で、本人 0.58±0.2 / 他人 0.34±0.2。
    # 0.5 で本人の 74% を通し、他人を 15% 通す。取りこぼしは「声n」に残るので直せる
    "match_threshold": 0.5,
    # 1位と2位の差がこれ未満なら「どちらとも言えない」として当てない
    "match_margin": 0.06,
    # 当たらなかった声どうしをまとめる類似度。
    # 実素材で 0.55 だと 18 組（ほぼ1枚ずつ）、0.45 で 8 組（叫び声の組・落ち着いた声の組・残り）。
    # まとめすぎても人が付け直せるが、ばらけすぎると付ける手間が枚数ぶんになる
    "group_threshold": 0.45,
    # 1人あたり覚える区間の上限。古いものから捨てる
    "max_samples": 32,
}

_extractor: Any = None


def model_path() -> Path:
    """同梱モデルの場所。顔モデル（face/__init__.py の model_path）と同じ置き方。

    🔴 配布時の候補を先に見ること。開発時の vendor/ を先に見ると、
       「配布物の中でだけ場所がずれている」を手元でもCIでも踏めなくなる。
    """
    if getattr(sys, "frozen", False):
        packed = Path(sys.executable).resolve().parent / "models" / MODEL_NAME
        if packed.exists():
            return packed
        raise RuntimeError("声を見分けるための部品がアプリの中に見つかりません。アプリを入れ直してください。")

    root = Path(__file__).resolve().parent.parent
    candidate = root / "vendor" / "models" / MODEL_NAME
    if candidate.exists():
        return candidate
    raise RuntimeError(
        f"声のモデルが見つかりません（{MODEL_NAME}）。python scripts/fetch_models.py を実行してください。"
    )


def describe_backend() -> str:
    """診断用。モデルと実行部品の有無を1行で。"""
    try:
        import sherpa_onnx  # noqa: F401
    except ImportError:
        return "sherpa-onnx が入っていない"
    try:
        return f"sherpa-onnx / {model_path()}"
    except RuntimeError as e:
        return str(e)


def _get_extractor() -> Any:
    """モデルは1回だけ読む（40MB。呼ぶたびに読むと画面の操作が引っかかる）。"""
    global _extractor
    if _extractor is not None:
        return _extractor
    try:
        import sherpa_onnx
    except ImportError as e:
        raise RuntimeError(
            "声を見分ける部品（sherpa-onnx）が入っていません。pip install sherpa-onnx を実行してください。"
        ) from e
    cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(model_path()), num_threads=4)
    _extractor = sherpa_onnx.SpeakerEmbeddingExtractor(cfg)
    return _extractor


def _read_wav(path: str) -> tuple[int, np.ndarray]:
    """16bit PCM の wav を float32 のモノラルにする。解析が作る audio.wav はこの形。"""
    with wave.open(path) as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        width = w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if width != 2:
        raise RuntimeError(f"対応していない音の形式です（{width * 8}bit）。16bit の wav が要ります。")
    data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1)
    return sr, data


def _normalize(v: np.ndarray) -> np.ndarray:
    n = float(np.linalg.norm(v))
    return v / n if n > 0 else v


def embed_ranges(
    wav_path: str, ranges: list[tuple[float, float]], min_seconds: float = DEFAULTS["min_seconds"]
) -> list[np.ndarray | None]:
    """区間ごとの声の特徴。短すぎる区間は None。"""
    sr, data = _read_wav(wav_path)
    ex = _get_extractor()
    out: list[np.ndarray | None] = []
    for start, end in ranges:
        a = max(0, int(start * sr))
        b = min(len(data), int(end * sr))
        if (b - a) / sr < min_seconds:
            out.append(None)
            continue
        stream = ex.create_stream()
        stream.accept_waveform(sr, data[a:b])
        stream.input_finished()
        out.append(_normalize(np.asarray(ex.compute(stream), dtype=np.float32)))
    return out


# ── 登録した声（プロフィール）──────────────────────────────

def load_profiles(path: str) -> dict[str, Any]:
    """覚えた声の一覧。無ければ空。壊れていても例外にしない（覚え直せる）。"""
    p = Path(path)
    if not p.exists():
        return {"version": 1, "speakers": []}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"version": 1, "speakers": []}
    speakers = [s for s in data.get("speakers", []) if isinstance(s, dict) and s.get("id") and s.get("name")]
    return {"version": 1, "speakers": speakers}


def save_profiles(path: str, profiles: dict[str, Any]) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(profiles, ensure_ascii=False), encoding="utf-8")
    tmp.replace(p)


def public_view(speaker: dict[str, Any]) -> dict[str, Any]:
    """画面に渡す形。埋め込みそのものは渡さない（512次元×32本で無駄に太る）。"""
    return {
        "id": speaker["id"],
        "name": speaker["name"],
        "color": speaker.get("color") or "#ffffff",
        "strokeColor": speaker.get("strokeColor"),
        "samples": len(speaker.get("samples") or []),
        "updated": speaker.get("updated"),
    }


def _centroid(speaker: dict[str, Any]) -> np.ndarray | None:
    samples = speaker.get("samples") or []
    if not samples:
        return None
    return _normalize(np.mean(np.asarray(samples, dtype=np.float32), axis=0))


def match_embeddings(
    embeddings: list[np.ndarray | None],
    speakers: list[dict[str, Any]],
    threshold: float = DEFAULTS["match_threshold"],
    margin: float = DEFAULTS["match_margin"],
) -> list[tuple[str | None, float]]:
    """区間ごとに、いちばん近い登録済みの声（無ければ None）と類似度。

    🔴 1位が閾値を超えても、2位との差が小さければ当てない。
       声の似た2人（同じ配信で叫んでいる）のどちらか分からないものに
       色を付けると、間違った色が半分出る。
    """
    cents = [(s["id"], _centroid(s)) for s in speakers]
    cents = [(sid, c) for sid, c in cents if c is not None]
    out: list[tuple[str | None, float]] = []
    for e in embeddings:
        if e is None or not cents:
            out.append((None, 0.0))
            continue
        scored = sorted(((float(e @ c), sid) for sid, c in cents), reverse=True)
        best, sid = scored[0]
        second = scored[1][0] if len(scored) > 1 else -1.0
        if best >= threshold and best - second >= margin:
            out.append((sid, round(best, 3)))
        else:
            out.append((None, round(best, 3)))
    return out


def group_unknown(
    embeddings: list[np.ndarray | None],
    threshold: float = DEFAULTS["group_threshold"],
) -> list[int | None]:
    """当たらなかった声を似たものどうしでまとめる。区間ごとの組番号（None は短すぎて不明）。

    先頭から順に、既にある組の中心に近ければそこへ、無ければ新しい組を作る。
    厳密な階層クラスタリングではないが、数十枚の切り抜きには十分で、依存も増えない。
    """
    groups: list[list[np.ndarray]] = []
    cents: list[np.ndarray] = []
    assigned: list[int | None] = []
    for e in embeddings:
        if e is None:
            assigned.append(None)
            continue
        best_i, best_s = -1, -1.0
        for i, c in enumerate(cents):
            s = float(e @ c)
            if s > best_s:
                best_i, best_s = i, s
        if best_i >= 0 and best_s >= threshold:
            groups[best_i].append(e)
            cents[best_i] = _normalize(np.mean(np.stack(groups[best_i]), axis=0))
            assigned.append(best_i)
        else:
            groups.append([e])
            cents.append(e)
            assigned.append(len(groups) - 1)

    # 🔴 1回通しただけだと、先に別々に始まった組が後から似てきても分かれたまま。
    #    中心どうしが近い組を、近い順にまとめ直す（大きい組へ寄せる）。
    #    実素材で 19 組 → 数組になった。
    merged_into = list(range(len(groups)))

    def root(i: int) -> int:
        while merged_into[i] != i:
            i = merged_into[i]
        return i

    changed = True
    while changed:
        changed = False
        roots = sorted({root(i) for i in range(len(groups))}, key=lambda i: -len(groups[i]))
        best_pair, best_s = None, threshold
        for a_i, a in enumerate(roots):
            for b in roots[a_i + 1:]:
                s = float(cents[a] @ cents[b])
                if s >= best_s:
                    best_pair, best_s = (a, b), s
        if best_pair:
            a, b = best_pair
            groups[a] += groups[b]
            cents[a] = _normalize(np.mean(np.stack(groups[a]), axis=0))
            merged_into[b] = a
            changed = True

    # 組番号を 0 から詰め直す（大きい組から順）
    order = sorted({root(i) for i in range(len(groups))}, key=lambda i: (-len(groups[i]), i))
    renumber = {g: n for n, g in enumerate(order)}
    return [None if a is None else renumber[root(a)] for a in assigned]


# ── RPC の中身 ──────────────────────────────────────────────

def identify(params: dict[str, Any]) -> dict[str, Any]:
    """テロップの区間ごとに「誰の声か」を返す。

    params:
        wav_path       解析が作った audio.wav
        units          [{id, src_start, src_end}]
        profiles_path  覚えた声の置き場所
        threshold / margin（任意）
    """
    opts = {**DEFAULTS, **{k: v for k, v in params.items() if k in DEFAULTS}}
    units = list(params.get("units") or [])
    profiles = load_profiles(params["profiles_path"])
    speakers = profiles["speakers"]

    ranges = [(float(u["src_start"]), float(u["src_end"])) for u in units]
    embeddings = embed_ranges(params["wav_path"], ranges, opts["min_seconds"]) if units else []
    matched = match_embeddings(embeddings, speakers, opts["match_threshold"], opts["match_margin"])

    # 当たらなかったものだけをまとめる
    unknown_idx = [i for i, (sid, _) in enumerate(matched) if sid is None and embeddings[i] is not None]
    grouped = group_unknown([embeddings[i] for i in unknown_idx], opts["group_threshold"])
    voice_of: dict[int, int] = {i: g for i, g in zip(unknown_idx, grouped) if g is not None}

    out_units = []
    for i, u in enumerate(units):
        sid, score = matched[i]
        out_units.append({
            "id": u["id"],
            "speaker": sid,
            "score": score,
            "voice": f"v{voice_of[i] + 1}" if i in voice_of else None,
        })

    # 「声n」の一覧。枚数が多い順。代表は一番長い区間（聞いて確かめる用）
    voices: dict[int, dict[str, Any]] = {}
    for i, g in voice_of.items():
        u = units[i]
        v = voices.setdefault(g, {"id": f"v{g + 1}", "count": 0, "seconds": 0.0, "sample": None, "unitIds": []})
        length = float(u["src_end"]) - float(u["src_start"])
        v["count"] += 1
        v["seconds"] += length
        v["unitIds"].append(u["id"])
        if v["sample"] is None or length > (float(v["sample"]["src_end"]) - float(v["sample"]["src_start"])):
            v["sample"] = {"id": u["id"], "src_start": u["src_start"], "src_end": u["src_end"]}
    voice_list = sorted(voices.values(), key=lambda v: (-v["count"], v["id"]))
    for v in voice_list:
        v["seconds"] = round(v["seconds"], 2)

    return {
        "units": out_units,
        "voices": voice_list,
        "speakers": [public_view(s) for s in speakers],
        "matched": sum(1 for sid, _ in matched if sid),
        "unknown": len(unknown_idx),
        "tooShort": sum(1 for e in embeddings if e is None),
    }


def _new_id() -> str:
    return f"spk{int(time.time() * 1000):x}"


def enroll(params: dict[str, Any]) -> dict[str, Any]:
    """区間の声を覚える。id があれば既存の人に足し、無ければ name と color で新しく作る。

    🔴 覚えるのは埋め込みだけ。音そのものは保存しない。
    """
    profiles = load_profiles(params["profiles_path"])
    speakers = profiles["speakers"]
    sid = params.get("id")
    speaker = next((s for s in speakers if s["id"] == sid), None) if sid else None
    if speaker is None:
        name = str(params.get("name") or "").strip()
        if not name:
            raise ValueError("名前が要ります")
        speaker = {
            "id": _new_id(),
            "name": name,
            "color": params.get("color") or "#ffffff",
            "strokeColor": params.get("strokeColor"),
            "samples": [],
        }
        speakers.append(speaker)

    ranges = [(float(r["src_start"]), float(r["src_end"])) for r in (params.get("ranges") or [])]
    added = 0
    if ranges:
        limit = int(params.get("max_samples") or DEFAULTS["max_samples"])
        for e in embed_ranges(params["wav_path"], ranges):
            if e is None:
                continue
            speaker.setdefault("samples", []).append([round(float(x), 5) for x in e])
            added += 1
        speaker["samples"] = speaker["samples"][-limit:]
    speaker["updated"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    save_profiles(params["profiles_path"], profiles)
    return {"speaker": public_view(speaker), "added": added, "speakers": [public_view(s) for s in speakers]}


def update(params: dict[str, Any]) -> dict[str, Any]:
    """名前や色を変える。声はそのまま。"""
    profiles = load_profiles(params["profiles_path"])
    speaker = next((s for s in profiles["speakers"] if s["id"] == params.get("id")), None)
    if speaker is None:
        raise ValueError("その人は登録されていません")
    for key in ("name", "color", "strokeColor"):
        if key in params:
            speaker[key] = params[key]
    if params.get("forget"):
        # 覚えた声だけ消す（名前と色は残す）。別の配信で覚え直すとき用
        speaker["samples"] = []
    speaker["updated"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    save_profiles(params["profiles_path"], profiles)
    return {"speakers": [public_view(s) for s in profiles["speakers"]]}


def delete(params: dict[str, Any]) -> dict[str, Any]:
    profiles = load_profiles(params["profiles_path"])
    profiles["speakers"] = [s for s in profiles["speakers"] if s["id"] != params.get("id")]
    save_profiles(params["profiles_path"], profiles)
    return {"speakers": [public_view(s) for s in profiles["speakers"]]}


def list_speakers(params: dict[str, Any]) -> dict[str, Any]:
    profiles = load_profiles(params["profiles_path"])
    return {"speakers": [public_view(s) for s in profiles["speakers"]], "backend": describe_backend()}


OPS = {
    "identify": identify,
    "enroll": enroll,
    "update": update,
    "delete": delete,
    "list": list_speakers,
}


def handle(params: dict[str, Any]) -> dict[str, Any]:
    """RPC の入口。op で分ける。"""
    op = params.get("op")
    fn = OPS.get(str(op))
    if fn is None:
        raise ValueError(f"知らない操作です: {op}")
    if not params.get("profiles_path"):
        raise ValueError("profiles_path が要ります")
    return fn(params)
