"""焼き込むテロップの帯と字幕ファイルの検査。

🔴 ここが守っていること:
   テロップの帯（concat デマクサのリスト）は**1本しかない**。
   そこへ重なったテロップを素直に並べると、後ろのテロップが
   「前が消えるまで待たされる」形で必ずずれる。しかも1枚ずれると
   以降が芋づる式にずれるので、**後半ほど声と文字が離れていく**。

   テロップの開始時刻は、その言葉が発せられた時刻そのもの。
   だから重なりは「前を切り上げて」直す。次を遅らせてはいけない。

   画面側（src/telop/split.ts の resolveOverlaps）でも同じ規則で直しているが、
   下書きの読み込みや手作業の組み合わせで重なりが残る可能性は消せないので、
   最後に書き出す側でも同じ規則を適用する。

実行: python scripts/test_telop_track.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _console import enable_utf8  # noqa: E402

from sidecar.media import write_srt, write_telop_track  # noqa: E402

failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failed
    if not ok:
        failed += 1
    print(f"[telop-track] {'OK  ' if ok else 'NG  '} {name}")
    if detail:
        print(f"              {detail}")


def parse_track(path: str) -> list[tuple[str, float]]:
    """リストを (ファイル名, 表示秒数) の並びにする。"""
    out: list[tuple[str, float]] = []
    name = ""
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line.startswith("file "):
            name = Path(line[5:].strip().strip("'")).name
        elif line.startswith("duration "):
            out.append((name, float(line[9:])))
    return out


def starts_of(track: list[tuple[str, float]]) -> dict[str, float]:
    """各 PNG が実際に出はじめる時刻。"""
    out: dict[str, float] = {}
    at = 0.0
    for name, length in track:
        if name != "blank.png" and name not in out:
            out[name] = round(at, 3)
        at += length
    return out


def main() -> int:
    enable_utf8()
    tmp = Path(tempfile.mkdtemp(prefix="telop-track-"))
    blank = str(tmp / "blank.png")

    def telop(name: str, start: float, end: float) -> dict[str, object]:
        return {"png": str(tmp / name), "out_start": start, "out_end": end, "text": name}

    # ── 重なっていない普通の並び ──────────────────────────
    path = write_telop_track(str(tmp / "a.txt"), blank, [
        telop("1.png", 1.0, 2.0),
        telop("2.png", 3.0, 4.0),
    ], 10.0)
    track = parse_track(path)
    starts = starts_of(track)
    check("重なっていなければ定刻どおり", starts == {"1.png": 1.0, "2.png": 3.0}, str(starts))
    total = round(sum(d for _, d in track), 3)
    check("全体の尺が動画に合う", total == 10.0, f"{total} 秒")

    # ── 重なっている場合（これが本題）──────────────────────
    path = write_telop_track(str(tmp / "b.txt"), blank, [
        telop("1.png", 1.0, 5.0),
        telop("2.png", 3.0, 6.0),
        telop("3.png", 4.0, 8.0),
    ], 10.0)
    track = parse_track(path)
    starts = starts_of(track)
    check(
        "重なっていても、次は定刻に出る",
        starts == {"1.png": 1.0, "2.png": 3.0, "3.png": 4.0},
        str(starts),
    )
    lengths = {name: length for name, length in track if name != "blank.png"}
    check(
        "重なったぶんは前を切り上げる",
        lengths == {"1.png": 2.0, "2.png": 1.0, "3.png": 4.0},
        str(lengths),
    )

    # ── 丸ごと呑み込まれる場合 ───────────────────────────
    path = write_telop_track(str(tmp / "c.txt"), blank, [
        telop("1.png", 1.0, 9.0),
        telop("2.png", 1.005, 3.0),
    ], 10.0)
    track = parse_track(path)
    names = [n for n, _ in track if n != "blank.png"]
    check("一瞬しか出ないものは出さない", names == ["2.png"], str(names))

    # ── 最後の1枚 ──────────────────────────────────────
    path = write_telop_track(str(tmp / "d.txt"), blank, [telop("1.png", 8.0, 9.0)], 10.0)
    track = parse_track(path)
    check(
        "最後は必ず透明で終わる（出しっぱなしにしない）",
        track[-1][0] == "blank.png",
        str(track[-1]),
    )

    # ── 字幕ファイルも同じ規則 ───────────────────────────
    srt = write_srt(str(tmp / "e.srt"), [
        {"out_start": 1.0, "out_end": 5.0, "text": "まえ"},
        {"out_start": 3.0, "out_end": 6.0, "text": "あと"},
    ])
    body = Path(srt).read_text(encoding="utf-8-sig")
    check(
        "字幕も前を切り上げる",
        "00:00:01,000 --> 00:00:03,000" in body,
        body.replace("\n", " | "),
    )
    check(
        "字幕の次は定刻に出る",
        "00:00:03,000 --> 00:00:06,000" in body,
        body.replace("\n", " | "),
    )
    check("字幕の番号が飛ばない", body.lstrip().startswith("1") and "\n2\n" in body, body.replace("\n", " | "))

    print("")
    if failed:
        print(f"❌ {failed} 件が期待どおりではありません")
        return 1
    print("✅ テロップの帯と字幕、すべて問題なし")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
