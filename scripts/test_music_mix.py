"""BGM が実際に混ざるかを検める。

🔴 「画面で足せる」ことと「出力に入っている」ことは別。
   足しただけで出力に乗らないのが、一番たちの悪い壊れ方になる。
   ここでは本物の ffmpeg で書き出して、音が変わったことを数値で確かめる。

    python scripts/test_music_mix.py
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _console import enable_utf8  # noqa: E402

enable_utf8()

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sidecar.media import export_cut_video, find_ffmpeg  # noqa: E402

FAILS: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'OK ' if ok else 'NG '}{label}{(' / ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(label)


def mean_volume(ffmpeg: str, path: str) -> float:
    """その音声の平均音量(dBFS)。混ざったかどうかの判定に使う。"""
    out = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", path, "-af", "volumedetect", "-f", "null", "-"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    ).stderr
    for line in out.splitlines():
        if "mean_volume:" in line:
            return float(line.split("mean_volume:")[1].split("dB")[0].strip())
    raise RuntimeError(f"音量を読めません:\n{out[-800:]}")


def main() -> None:
    ffmpeg = find_ffmpeg()
    tmp = Path(tempfile.mkdtemp())

    # 素材: 5秒の映像＋小さめの声（440Hz）
    src = tmp / "src.mp4"
    subprocess.run(
        [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
         "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=5",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
         "-c:v", "mpeg4", "-c:a", "aac", "-shortest", str(src)],
        check=True,
    )
    # BGM: 2秒しかない（＝繰り返しが要る）別の音
    bgm = tmp / "bgm.wav"
    subprocess.run(
        [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
         "-f", "lavfi", "-i", "sine=frequency=880:duration=2", str(bgm)],
        check=True,
    )

    keeps = [(0.0, 5.0)]

    print("=== BGM なし ===")
    plain = tmp / "plain.mp4"
    export_cut_video(str(src), str(plain), keeps, fps=30.0, work_dir=str(tmp))
    check("書き出せた", plain.exists() and plain.stat().st_size > 0)
    v_plain = mean_volume(ffmpeg, str(plain))
    print(f"     平均音量 {v_plain:.2f} dB")

    print("\n=== BGM あり（2秒の音を5秒へ繰り返す）===")
    mixed = tmp / "mixed.mp4"
    export_cut_video(
        str(src), str(mixed), keeps, fps=30.0, work_dir=str(tmp),
        music={"path": str(bgm), "volume": 0.5, "loop": True},
    )
    check("書き出せた", mixed.exists() and mixed.stat().st_size > 0)
    v_mixed = mean_volume(ffmpeg, str(mixed))
    print(f"     平均音量 {v_mixed:.2f} dB")

    # 🔴 「混ざったか」は音量の変化で見る。同じなら何も足されていない
    check(
        "BGM が実際に混ざっている",
        abs(v_mixed - v_plain) > 0.3,
        f"差 {abs(v_mixed - v_plain):.2f} dB",
    )

    # 尺が変わっていないこと（BGM が短くても長くても動画の長さは動かない）
    def dur(p: str) -> float:
        out = subprocess.run(
            [ffmpeg, "-hide_banner", "-i", p], capture_output=True, text=True,
            encoding="utf-8", errors="replace",
        ).stderr
        tok = out.split("Duration:")[1].split(",")[0].strip()
        h, m, sec = tok.split(":")
        return int(h) * 3600 + int(m) * 60 + float(sec)

    d_plain, d_mixed = dur(str(plain)), dur(str(mixed))
    check(
        "尺が変わっていない",
        abs(d_plain - d_mixed) < 0.35,
        f"BGMなし {d_plain:.2f}秒 / BGMあり {d_mixed:.2f}秒",
    )

    print()
    if FAILS:
        print("test-music-mix: NG " + " / ".join(FAILS))
        sys.exit(1)
    print("test-music-mix: OK")


if __name__ == "__main__":
    main()
