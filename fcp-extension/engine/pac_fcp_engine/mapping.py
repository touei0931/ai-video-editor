"""解析結果を、パネル（webui）が読む形に変換する。

webui/src/lib/types.ts の ProjectState と対応させること。
ここは重い依存を一切持たないので、Windows でもテストできる。
"""

from __future__ import annotations

from typing import Any

# PAC 側のテロップ種別 -> パネルの2種類（通常 / 強調）
# note（補足）は見た目を分けず通常に寄せる。テンプレートは2種類しか持たないため。
_STYLE_MAP = {
    "normal": "normal",
    "emphasis": "emphasis",
    "note": "normal",
}


def map_cuts(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """カット候補を webui の CutCandidate にする。

    src_* は「元素材の時刻」。パネルも元素材の時刻で表示するのでそのまま渡す。
    判断は必ず pending から始める（勝手に切らない）。
    """
    out: list[dict[str, Any]] = []
    for c in candidates:
        kind = c.get("kind")
        if kind not in ("silence", "filler", "restate"):
            continue
        # 無音には文字が無いので、直前の発話を手がかりとして見せる
        text = c.get("text") or ""
        if kind == "silence":
            text = ""
        out.append({
            "id": c["id"],
            "start": float(c["src_start"]),
            "end": float(c["src_end"]),
            "kind": kind,
            "text": text,
            "confidence": float(c.get("confidence", 0)),
            "decision": "pending",
        })
    out.sort(key=lambda c: c["start"])
    return out


def map_telops(units: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """テロップ候補を webui の Telop にする。"""
    out: list[dict[str, Any]] = []
    for t in units:
        text = (t.get("text") or "").strip()
        if not text:
            continue
        out.append({
            "id": t["id"],
            "start": float(t["src_start"]),
            "end": float(t["src_end"]),
            "text": text,
            "style": _STYLE_MAP.get(t.get("style", "normal"), "normal"),
        })
    out.sort(key=lambda t: t["start"])
    return out


def cut_text_from_transcript(
    candidates: list[dict[str, Any]], transcript: dict[str, Any]
) -> list[dict[str, Any]]:
    """カット候補に「その区間で何を言っているか」を埋める。

    一覧に文字が出ていないと、承認/却下の判断ができない。
    """
    words: list[dict[str, Any]] = []
    for seg in transcript.get("segments", []):
        for w in seg.get("words", []):
            if w.get("text", "").strip():
                words.append(w)

    for c in candidates:
        if c.get("text"):
            continue
        s, e = float(c["src_start"]), float(c["src_end"])
        inside = [
            w["text"]
            for w in words
            if float(w["src_start"]) >= s - 0.01 and float(w["src_end"]) <= e + 0.01
        ]
        c["text"] = "".join(inside).strip()
    return candidates


def project_state(
    duration: float,
    waveform: list[float],
    cuts: list[dict[str, Any]],
    telops: list[dict[str, Any]],
    media_path: str | None = None,
) -> dict[str, Any]:
    """パネルにそのまま渡せる形。styles と fonts は Swift 側が足す。"""
    return {
        "videoUrl": media_path,
        "durationSec": round(float(duration), 3),
        "waveform": [round(float(v), 4) for v in waveform],
        "cuts": cuts,
        "telops": telops,
    }
