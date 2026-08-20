"""レビュー用クリップが、その OS で実際に作れて再生できる形かを検査する。

🔴 これが守っている不具合:
   make_review_clip はエンコーダに libopenh264 を直書きしていた。
   Mac に同梱する ffmpeg は「外部ライブラリを一切リンクしない」方針（VideoToolbox のみ）で
   ビルドしているため libopenh264 が無く、**Mac では全候補のクリップ生成が失敗**していた。
   「切って繋いだ結果を聞いて判断する」という①カットの中核が丸ごと死ぬ。
   しかも例外は1件ずつ握り潰されるので、解析は成功として返る。

   プラットフォーム分岐が1文字も無いので platform-guard も素通りする。
   「分岐が無い＝Mac で壊れない」は成り立たない。両OSで実際に作ってみるしかない。

🔴 コーデックまで見ること。
   ファイルができても、Chromium が再生できない形式（ProRes / MPEG-4 Part 2）では
   レビュー画面は真っ黒になる。「ファイルはあるのに映らない」は原因が分かりにくい。

実行: python scripts/test_review_clip.py
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _console import enable_utf8  # noqa: E402

from sidecar.media import find_ffmpeg, make_review_clip  # noqa: E402

#: Chromium が MP4 の中で再生できる映像コーデック
PLAYABLE = {"h264"}

failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failed
    if not ok:
        failed += 1
    print(f"[review-clip] {'OK  ' if ok else 'NG  '} {name}")
    if detail:
        print(f"          {detail}")


def make_source(ffmpeg: str, path: str) -> None:
    """検査用の素材。実素材を CI に置けないので合成する。"""
    subprocess.run(
        [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
         "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=8",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=8",
         "-c:v", "mpeg4", "-c:a", "aac", "-shortest", path],
        check=True,
    )


def codec_of(ffmpeg: str, path: str) -> str:
    """ffprobe に頼らず ffmpeg の出力から映像コーデック名を拾う。"""
    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", path],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    for line in (result.stderr or "").splitlines():
        if "Video:" in line:
            return line.split("Video:", 1)[1].strip().split()[0].strip(",")
    return ""


def main() -> int:
    enable_utf8()
    ffmpeg = find_ffmpeg()

    with tempfile.TemporaryDirectory() as tmp:
        src = str(Path(tmp) / "src.mp4")
        make_source(ffmpeg, src)

        # 素材の真ん中を 1.2 秒カットしたときのレビュー用クリップ
        out = str(Path(tmp) / "clip.mp4")
        clip = make_review_clip(src, out, cut_start=3.0, cut_end=4.2)

        check("クリップが作れた", Path(out).exists() and Path(out).stat().st_size > 0)
        check(
            "繋ぎ目の位置が返る",
            clip["join_at"] > 0,
            f"繋ぎ目 {clip['join_at']}秒 / 尺 {clip['duration']}秒",
        )

        codec = codec_of(ffmpeg, out)
        check(
            "ブラウザが再生できる形式である",
            codec in PLAYABLE,
            f"映像コーデック: {codec or '不明'}（許容: {', '.join(sorted(PLAYABLE))}）",
        )

        # 素材の先頭。前半が取れないので後ろだけで作る経路
        head = str(Path(tmp) / "head.mp4")
        clip2 = make_review_clip(src, head, cut_start=0.0, cut_end=0.5)
        check("素材の先頭でも作れる", Path(head).exists() and clip2["duration"] > 0)

    print()
    print("test-review-clip: OK" if failed == 0 else f"test-review-clip: {failed} 件失敗")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
