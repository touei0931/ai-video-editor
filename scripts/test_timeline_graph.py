"""親画面（NLE）の書き出しフィルタを、ffmpeg を動かさずに検める。

🔴 ここは間違えても例外が出ない。
   フィルタの繋ぎ方を1つ間違えても ffmpeg は動いてしまい、
   「音がずれている」「重ねた映像が出しっぱなし」という形で、
   **書き出したものを最後まで見て初めて**分かる。40分素材なら1回の確認に40分かかる。
   だから、組み立てた文字列そのものを机上で検査する。

一番効くのは**ラベルの検査**（check_labels）。
ffmpeg の filter_complex は `[v0]` のようなラベルで繋ぐが、
綴りを1文字間違えても「そんな入力は無い」と言われるだけで、
どこが繋がっていないのかは出ない。
「作ったラベルは必ず1回だけ使われる」を機械で見れば、繋ぎ忘れは全部ここで落ちる。

実行: python scripts/test_timeline_graph.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _console import enable_utf8  # noqa: E402

from sidecar.timeline_render import build_timeline_graph  # noqa: E402

failed = 0

#: `-map` で外へ出すラベル。使われていなくてよい
OUTPUTS = {"vout", "aout"}

#: 入力ファイルを指すラベル（[0:v] など）。作られる側ではない
INPUT_RE = re.compile(r"^\d+:[va]$")

CHAIN_HEAD = re.compile(r"^((?:\[[^\]]+\])*)")
CHAIN_TAIL = re.compile(r"((?:\[[^\]]+\])*)$")
LABEL = re.compile(r"\[([^\]]+)\]")


def check(name: str, ok: bool, detail: str = "") -> None:
    global failed
    if not ok:
        failed += 1
    print(f"[timeline-graph] {'OK  ' if ok else 'NG  '} {name}")
    if detail and not ok:
        print(f"                 {detail}")


def check_labels(name: str, graph: str) -> None:
    """作ったラベルが、ちょうど1回ずつ使われているかを見る。"""
    made: dict[str, int] = {}
    used: dict[str, int] = {}

    for chain in graph.split(";"):
        chain = chain.strip()
        if not chain:
            continue
        head = CHAIN_HEAD.match(chain).group(1)
        rest = chain[len(head):]
        tail = CHAIN_TAIL.search(rest).group(1)
        for lb in LABEL.findall(head):
            used[lb] = used.get(lb, 0) + 1
        for lb in LABEL.findall(tail):
            made[lb] = made.get(lb, 0) + 1

    problems: list[str] = []
    for lb, count in made.items():
        if count > 1:
            problems.append(f"{lb} を {count} 回作っている")
        u = used.get(lb, 0)
        if lb in OUTPUTS:
            if u != 0:
                problems.append(f"{lb} は外へ出すので使ってはいけない")
        elif u == 0:
            problems.append(f"{lb} を作ったが誰も使っていない")
        elif u > 1:
            problems.append(f"{lb} を {u} 回使っている")
    for lb in used:
        if lb not in made and not INPUT_RE.match(lb):
            problems.append(f"{lb} を使っているが誰も作っていない")
    for lb in OUTPUTS:
        if lb not in made:
            problems.append(f"{lb} が作られていない")

    check(f"{name}: ラベルの繋がり", not problems, " / ".join(problems))


def clip(path: str, at: float, s: float, e: float, **kw: object) -> dict:
    base = {"path": path, "at": at, "src_start": s, "src_end": e, "z": 0,
            "video": True, "audio": True}
    base.update(kw)
    return base


def main() -> int:
    enable_utf8()

    base = {"width": 1920, "height": 1080, "fps": 30.0}

    # ── 1本だけ ──
    g = build_timeline_graph({**base, "duration": 10.0,
                              "clips": [clip("a.mp4", 0.0, 0.0, 10.0)]})
    check("1本だけ: 入力は1つ", len(g["inputs"]) == 1, str(g["inputs"]))
    check("1本だけ: 区切りは1つ", g["video_segments"] == 1, str(g["video_segments"]))
    check("1本だけ: concat は使わない", "concat=" not in g["filter_complex"])
    check_labels("1本だけ", g["filter_complex"])

    # ── 同じ素材を2回使う ──
    g = build_timeline_graph({**base, "duration": 10.0, "clips": [
        clip("a.mp4", 0.0, 0.0, 5.0),
        clip("a.mp4", 5.0, 20.0, 25.0),
    ]})
    check("同じ素材は1回だけ開く", len(g["inputs"]) == 1, str(g["inputs"]))
    check("同じ素材: 区切りは2つ", g["video_segments"] == 2)
    check_labels("同じ素材を2回", g["filter_complex"])

    # ── 途中の空き ──
    #
    # 🔴 空きを飛ばすと後ろが前に詰まり、音とずれる
    g = build_timeline_graph({**base, "duration": 12.0, "clips": [
        clip("a.mp4", 0.0, 0.0, 4.0),
        clip("b.mp4", 6.0, 0.0, 4.0),
    ]})
    check("空き: 黒で埋める", "color=c=black" in g["filter_complex"])
    check("空き: 区切りは4つ（映像・空き・映像・尻の空き）",
          g["video_segments"] == 4, str(g["video_segments"]))
    check_labels("途中の空き", g["filter_complex"])

    # ── 頭が空いている ──
    g = build_timeline_graph({**base, "duration": 8.0, "clips": [
        clip("a.mp4", 3.0, 0.0, 5.0),
    ]})
    check("頭の空き: 区切りは2つ", g["video_segments"] == 2, str(g["video_segments"]))
    check("頭の空き: 黒の長さは3秒", "d=3.0000" in g["filter_complex"])
    check_labels("頭の空き", g["filter_complex"])

    # ── 上に重ねるレーン ──
    g = build_timeline_graph({**base, "duration": 20.0, "clips": [
        clip("a.mp4", 0.0, 0.0, 20.0),
        clip("b.mp4", 5.0, 0.0, 3.0, z=1),
    ]})
    fc = g["filter_complex"]
    check("重ね: overlay がある", "overlay=" in fc)
    check("重ね: 出す時間を区切っている",
          "enable='between(t,5.0000,8.0000)'" in fc, fc)
    check("重ね: 位置までずらしている", "setpts=PTS-STARTPTS+5.0000/TB" in fc, fc)
    check("重ね: 数を数えている", g["overlays"] == 1)
    check_labels("上に重ねる", fc)

    # ── 音 ──
    g = build_timeline_graph({**base, "duration": 20.0, "clips": [
        clip("a.mp4", 0.0, 0.0, 10.0),
        clip("b.mp4", 10.0, 2.0, 12.0),
    ]})
    fc = g["filter_complex"]
    check("音: 2本混ぜる", "amix=inputs=2" in fc, fc)
    # 🔴 normalize=1（既定）だと、クリップを足すたびに全体が小さくなる
    check("音: 数で割らない", "normalize=0" in fc, fc)
    check("音: 置き場所までずらす", "adelay=10000|10000:all=1" in fc, fc)
    check("音: 繋ぎ目にフェード", fc.count("afade=t=in") == 2, fc)
    check_labels("音", fc)

    # ── 音の無いタイムライン ──
    g = build_timeline_graph({**base, "duration": 6.0, "clips": [
        clip("a.mp4", 0.0, 0.0, 6.0, audio=False),
    ]})
    check("音無し: 無音を作る", "anullsrc" in g["filter_complex"])
    check("音無し: 本数は0", g["audio_clips"] == 0)
    check_labels("音の無いタイムライン", g["filter_complex"])

    # ── 音だけの素材（映像レーンに出さない） ──
    g = build_timeline_graph({**base, "duration": 30.0, "clips": [
        clip("a.mp4", 0.0, 0.0, 30.0),
        clip("bgm.m4a", 4.0, 0.0, 20.0, video=False, z=2, gain_db=-6.0),
    ]})
    fc = g["filter_complex"]
    check("音だけ: 映像は増えない", g["video_segments"] == 1, str(g["video_segments"]))
    check("音だけ: 音量を効かせる", "volume=-6.00dB" in fc, fc)
    check_labels("音だけの素材", fc)

    # ── テロップ ──
    g = build_timeline_graph({**base, "duration": 10.0,
                              "clips": [clip("a.mp4", 0.0, 0.0, 10.0)],
                              "telop_tracks": ["t0.txt", "t1.txt"]})
    fc = g["filter_complex"]
    check("テロップ: 段の数だけ入力が増える",
          [i["kind"] for i in g["inputs"]] == ["media", "concat", "concat"],
          str(g["inputs"]))
    check("テロップ: rgba で重ねる", fc.count("format=rgba") == 2, fc)
    check_labels("テロップ", fc)

    # ── BGM ──
    g = build_timeline_graph({**base, "duration": 10.0,
                              "clips": [clip("a.mp4", 0.0, 0.0, 10.0)],
                              "telop_tracks": ["t0.txt"],
                              "music": {"path": "m.mp3", "volume": 0.2}})
    kinds = [i["kind"] for i in g["inputs"]]
    # 🔴 入力の順番と、フィルタの中で使う番号が食い違うと、別の入力を音として混ぜる
    check("BGM: 入力の並びは media→music→concat",
          kinds == ["media", "music", "concat"], str(kinds))
    check("BGM: 番号が合っている", "[1:a]" in g["filter_complex"], g["filter_complex"])
    check_labels("BGM", g["filter_complex"])

    # ── コマ境界への丸め ──
    #
    # 🔴 丸めないと繋ぎ目で1コマ増減し、後ろへ行くほど音とずれる
    g = build_timeline_graph({**base, "duration": 10.0, "clips": [
        clip("a.mp4", 0.0, 0.0, 3.004),
    ]})
    check("丸め: 30fps なら 3.004 は 3.0000",
          "end=3.0000" in g["filter_complex"], g["filter_complex"])

    g = build_timeline_graph({**base, "fps": 29.97, "duration": 10.0, "clips": [
        clip("a.mp4", 0.0, 0.0, 1.0),
    ]})
    check("丸め: 29.97 では 1.0 秒は 1.0010 秒（30コマ）",
          "end=1.0010" in g["filter_complex"], g["filter_complex"])

    # ── 尻の余りを切る ──
    g = build_timeline_graph({**base, "duration": 5.0, "clips": [
        clip("a.mp4", 0.0, 0.0, 100.0),
    ]})
    check("尺: 長さは丸めた値", abs(g["duration"] - 5.0) < 1e-6, str(g["duration"]))
    check_labels("尻の余り", g["filter_complex"])

    # ── 縦横が混ざる ──
    g = build_timeline_graph({"width": 1080, "height": 1920, "fps": 30.0,
                              "duration": 20.0, "clips": [
                                  clip("yoko.mp4", 0.0, 0.0, 10.0),
                                  clip("tate.mp4", 10.0, 0.0, 10.0),
                              ]})
    fc = g["filter_complex"]
    # 🔴 揃えないと concat が "Input link parameters do not match" で止まる
    check("縦横混在: 大きさを揃える", fc.count("scale=1080:1920") == 2, fc)
    check("縦横混在: 引き伸ばさず余白", fc.count("force_original_aspect_ratio=decrease") == 2)
    check("縦横混在: 画素比も揃える", fc.count("setsar=1") >= 2)
    check_labels("縦横混在", fc)

    # ── 末尾 ──
    check("末尾にセミコロンを残さない", not g["filter_complex"].rstrip().endswith(";"))

    # ── 空のタイムライン ──
    for label, spec in [
        ("クリップ無し", {**base, "duration": 10.0, "clips": []}),
        ("長さ0", {**base, "duration": 0.0, "clips": [clip("a.mp4", 0, 0, 1)]}),
    ]:
        try:
            build_timeline_graph(spec)
            check(f"{label}: 断る", False, "例外が出なかった")
        except ValueError:
            check(f"{label}: 断る", True)

    # ── 数が増えても壊れないか（自動カット 300 本相当） ──
    many = []
    t = 0.0
    for _ in range(300):
        many.append(clip("a.mp4", round(t, 3), round(t, 3), round(t + 1.2, 3)))
        t += 1.2
    g = build_timeline_graph({**base, "duration": round(t, 3), "clips": many})
    check("300本: 入力は1つのまま", len(g["inputs"]) == 1)
    check("300本: 区切りは300", g["video_segments"] == 300, str(g["video_segments"]))
    check_labels("300本", g["filter_complex"])

    print()
    if failed:
        print(f"[timeline-graph] NG {failed} 件")
        return 1
    print("[timeline-graph] 全部 OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
