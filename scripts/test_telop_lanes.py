"""同じ時間に2枚以上のテロップを出せることを検める。

🔴 テロップの帯は1本だと「同時に1枚」しか出せない。
   重なった2枚目は、前を切り上げる形でしか置けなかった。
   段の数だけ帯を作って重ねているか、フィルタの組み立てを見て確かめる。

🔴 BGM の入力番号がずれていないかも一緒に見る。
   帯が増えると入力の番号が動く。ずれると**別の入力を音として混ぜる**。

実行: python scripts/test_telop_lanes.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sidecar import media  # noqa: E402

failed = 0


def check(name: str, ok: bool, note: str = "") -> None:
    global failed
    if ok:
        print(f"[lanes] OK   {name}")
    else:
        failed += 1
        print(f"[lanes] NG   {name}" + (f"\n          {note}" if note else ""))


def build_graph(track_count: int, with_music: bool) -> tuple[str, list[str]]:
    """ffmpeg は動かさず、組み立てたフィルタとコマンドだけ取り出す"""
    captured: dict[str, list[str]] = {}

    def fake_run(cmd, total_seconds, on_progress, base, span, message):  # noqa: ANN001
        captured["cmd"] = list(cmd)
        Path(cmd[-1]).write_bytes(b"0")

    original = (
        media._run_with_progress,
        media.probe_video_info,
        media.available_video_args,
        media.available_decode_args,
    )
    media._run_with_progress = fake_run
    media.probe_video_info = lambda _p: {
        "width": 1920, "height": 1080, "fps": 30.0, "duration": 60.0, "rotation": 0,
    }
    media.available_video_args = lambda _f, _q="standard": (["-c:v", "libx264"], "libx264")
    media.available_decode_args = lambda _f: []
    try:
        with tempfile.TemporaryDirectory() as tmp:
            tracks = []
            for i in range(track_count):
                p = Path(tmp) / f"track-{i}.txt"
                p.write_text("file 'x.png'\nduration 1.0\n", encoding="utf-8")
                tracks.append(str(p))
            music = None
            if with_music:
                m = Path(tmp) / "bgm.mp3"
                m.write_bytes(b"0")
                music = {"path": str(m), "volume": 0.2, "loop": True}
            out = str(Path(tmp) / "out.mp4")
            media.export_cut_video(
                "dummy.mp4", out, [(0.0, 10.0), (12.0, 20.0)],
                telop_tracks=tracks, work_dir=tmp, music=music,
            )
            cmd = captured["cmd"]
            graph = Path(cmd[cmd.index("-filter_complex_script") + 1]).read_text(encoding="utf-8")
            return graph, cmd
    finally:
        (
            media._run_with_progress,
            media.probe_video_info,
            media.available_video_args,
            media.available_decode_args,
        ) = original


def main() -> int:
    # ── 帯が1本のとき（これまでどおり）──
    graph, cmd = build_graph(1, with_music=False)
    check("1段なら重ねるのは1回", graph.count("overlay=") == 1)
    check("1段でも出口は [vout]", graph.rstrip().endswith("[vout]"))
    check("帯を入力に足している", cmd.count("concat") >= 1)

    # ── 帯が3本のとき ──
    graph, cmd = build_graph(3, with_music=False)
    check("3段なら3回重ねる", graph.count("overlay=") == 3, graph[-260:])
    check("段の順に重ねる（下の段が上に載る）", "[vcat][ov0]" in graph and "[ov2]overlay" in graph)
    check("出口は [vout] ひとつ", graph.count("[vout]") == 1 and graph.rstrip().endswith("[vout]"))
    check("最後の1枚が残り続けないようにしている", graph.count("repeatlast=0") == 3)
    check("帯の数だけ入力がある", cmd.count("-f") == 3)

    # ── BGM を足しても入力番号がずれないこと ──
    graph, cmd = build_graph(2, with_music=True)
    # 映像1本 + 帯2本 = 入力 0,1,2 なので BGM は 3
    check("BGM は帯のあとの入力番号を使う", "[3:a]" in graph, graph[:200])
    check("BGM を混ぜている", "amix=inputs=2" in graph)

    # ── 帯が無いとき ──
    graph, cmd = build_graph(0, with_music=False)
    check("テロップが無ければ重ねない", "overlay=" not in graph)
    check("それでも出口は [vout]", "[vcat]null[vout]" in graph)

    if failed:
        print(f"\ntest-telop-lanes: NG（{failed} 件）")
        return 1
    print("\ntest-telop-lanes: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
