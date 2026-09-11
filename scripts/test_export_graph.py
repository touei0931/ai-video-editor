"""書き出しのフィルタが、コマンドラインに載らないことを検査する。

🔴 これが守っている不具合:
   残す区間ごとに音声・映像のフィルタを文字列連結して `-filter_complex` に渡していた。
   区間が増えると青天井に伸び、Windows の CreateProcess の上限 32,767 文字を超える。
   実測では **20分素材に人物アップが80箇所付いた時点で超過**していた。
   出るのは「パラメーターが間違っています」だけで、原因には辿り着けない。

   既存の検証（T5）は25秒のクリップなので、この経路を一度も踏んでいなかった。
   ffmpeg を実行せず、組み立てた文字列の長さと引数の形だけを見れば守れる。

実行: python scripts/test_export_graph.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _console import enable_utf8  # noqa: E402

from sidecar import media  # noqa: E402

#: Windows の CreateProcess のコマンドライン上限
CMDLINE_LIMIT = 32767

failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failed
    if not ok:
        failed += 1
    print(f"[export-graph] {'OK  ' if ok else 'NG  '} {name}")
    if detail:
        print(f"          {detail}")


def main() -> int:
    enable_utf8()

    # 40分素材でカット250箇所・人物アップ170箇所を想定した区間数
    keeps: list[tuple[float, float]] = []
    t = 0.0
    while len(keeps) < 251:
        keeps.append((round(t, 3), round(t + 5.4, 3)))
        t += 9.6

    framing = []
    for i in range(170):
        start = keeps[i][0] + 1.0
        framing.append({
            "src_start": start,
            "src_end": start + 2.0,
            "rect": {"x": 0.2, "y": 0.1, "w": 0.5, "h": 0.5},
        })

    captured: dict[str, list[str]] = {}

    def fake_run(cmd, total_seconds, on_progress, base, span, message):  # noqa: ANN001
        captured["cmd"] = list(cmd)
        # ffmpeg は動かさないので、後段が見るファイルだけ置いておく
        Path(cmd[-1]).write_bytes(b"0")

    original_run = media._run_with_progress
    original_probe = media.probe_video_info
    original_video_args = media.available_video_args
    original_decode = media.available_decode_args
    original_find = media.find_ffmpeg

    media._run_with_progress = fake_run
    # 🔴 find_ffmpeg も差し替えること。
    #    このテストは ffmpeg を**動かさない**のが売りだが、
    #    export_cut_video は最初に置き場所を探しに行く。
    #    差し替え忘れると、実行しないのに「ffmpeg が見つかりません」で
    #    落ちる。CI がずっと赤いまま放置される原因になっていた。
    media.find_ffmpeg = lambda: "ffmpeg"
    media.probe_video_info = lambda _p: {
        "width": 1920, "height": 1080, "fps": 30.0, "duration": 2400.0, "rotation": 0,
    }
    media.available_video_args = lambda _f, _q="standard": (["-c:v", "h264_nvenc"], "h264_nvenc")
    media.available_decode_args = lambda _f: []

    try:
        with tempfile.TemporaryDirectory() as tmp:
            out = str(Path(tmp) / "out.mp4")
            media.export_cut_video(
                "dummy.mp4", out, keeps, framing=framing, work_dir=tmp,
            )

            cmd = captured["cmd"]

            check("フィルタをコマンドラインに載せていない", "-filter_complex" not in cmd)
            check("フィルタをファイルで渡している", "-filter_complex_script" in cmd)

            graph_path = Path(cmd[cmd.index("-filter_complex_script") + 1])
            check("フィルタのファイルが作業フォルダにある", graph_path.exists())

            graph = graph_path.read_text(encoding="utf-8")
            # このテストが意味を持つのは、素で渡したら超える長さのときだけ。
            check(
                "検査に使う区間数が、旧方式なら上限を超える規模である",
                len(graph) > CMDLINE_LIMIT,
                f"フィルタ {len(graph):,} 文字 > 上限 {CMDLINE_LIMIT:,}",
            )

            total = sum(len(a) + 1 for a in cmd)
            check(
                "実際のコマンドラインは上限に遠い",
                total < CMDLINE_LIMIT // 4,
                f"コマンドライン {total:,} 文字",
            )

            # ── 等倍では速度のフィルタを1つも足さない ──
            check("等倍では setpts で縮めない", "setpts=PTS/" not in graph)
            check("等倍では atempo を足さない", "atempo" not in graph)
            check("等倍では出力のコマ数を固定しない", "-r" not in cmd)

            # ── 書き出す再生速度 ──
            #
            # 🔴 テロップを重ねた**あと**に映像を縮める。声は同じ率、BGM は縮めない。
            short = keeps[:3]
            track = Path(tmp) / "track-0.txt"
            track.write_text("ffconcat version 1.0\n", encoding="utf-8")
            music = Path(tmp) / "bgm.mp3"
            music.write_bytes(b"0")
            out2 = str(Path(tmp) / "fast.mp4")
            res = media.export_cut_video(
                "dummy.mp4", out2, short, telop_tracks=[str(track)], work_dir=tmp,
                music={"path": str(music), "volume": 0.2, "loop": True}, speed=1.25,
            )
            cmd2 = captured["cmd"]
            graph2 = Path(cmd2[cmd2.index("-filter_complex_script") + 1]).read_text(encoding="utf-8")
            check("速度: 映像を setpts で縮める", "setpts=PTS/1.25[vout]" in graph2, graph2[-200:])
            check(
                "速度: テロップを重ねたあとで縮める（overlay → setpts の順）",
                graph2.index("overlay=") < graph2.index("setpts=PTS/1.25"),
            )
            check("速度: 声は atempo で同じ率", "atempo=1.25" in graph2)
            check(
                "速度: 音量を揃えたあとに速度を掛ける（loudnorm → atempo）",
                graph2.index("loudnorm") < graph2.index("atempo=1.25"),
            )
            kept_src = sum(e - s for s, e in short)
            check(
                "速度: BGM は出来上がりの長さで切る",
                f"atrim=0:{kept_src / 1.25:.3f}" in graph2,
                f"素材 {kept_src:.3f}秒 / 期待 {kept_src / 1.25:.3f}秒",
            )
            check("速度: 出力のコマ数を固定する", "-r" in cmd2 and cmd2[cmd2.index("-r") + 1] == "30")
            check(
                "速度: 結果の長さは出来上がりの長さ",
                abs(res["kept_seconds"] - kept_src / 1.25) < 0.01,
                f"{res['kept_seconds']} / 期待 {kept_src / 1.25:.2f}",
            )
            # 出力ラベルの繋がり（作ったラベルは必ず1回だけ使う）。[vfull] が宙に浮いていないこと
            check("速度: 作った [vfull] を使っている", graph2.count("[vfull]") == 2, str(graph2.count("[vfull]")))

            # 4倍は atempo を2段に分ける（1段の上限は 2.0）
            media.export_cut_video("dummy.mp4", out2, short, work_dir=tmp, speed=4.0)
            cmd4 = captured["cmd"]
            graph4 = Path(cmd4[cmd4.index("-filter_complex_script") + 1]).read_text(encoding="utf-8")
            check("速度 4倍: atempo を 2.0 × 2.0 に分ける", "atempo=2.0,atempo=2.0" in graph4)
            check("速度 4倍: 0.25 倍は 0.5 × 0.5", media.atempo_chain(0.25) == "atempo=0.5,atempo=0.5",
                  media.atempo_chain(0.25))
            check("速度 1.5倍: 1段", media.atempo_chain(1.5) == "atempo=1.5", media.atempo_chain(1.5))
    finally:
        media._run_with_progress = original_run
        media.probe_video_info = original_probe
        media.available_video_args = original_video_args
        media.available_decode_args = original_decode
        media.find_ffmpeg = original_find

    print()
    print("test-export-graph: OK" if failed == 0 else f"test-export-graph: {failed} 件失敗")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
