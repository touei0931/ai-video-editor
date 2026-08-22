"""出来上がった .app の中のサイドカーを、配布と同じ形で動かして検める。

    python scripts/check_packed_sidecar.py release/mac-arm64/PAC.app

🔴 なぜ要るか（2026-08-22 に友達の Mac で踏んだ）:

    サイドカーは ffmpeg を自力で探していて、配布時の想定を
    「実行ファイルの隣」と書いていた。実際の同梱先は1階層上の ffmpeg/ の中。
    ところが開発中もCIも**リポジトリの中から**サイドカーを起動していたため、
    vendor/ffmpeg が先に見つかって毎回素通りし、誰も気づけなかった。
    友達が「動画を選ぶ」を押した瞬間に「ffmpeg が見つかりません」で落ちた。

    要点は「リポジトリから離れた場所で動かす」こと。
    ここを守らないと、この検査は何も検めていないのと同じになる。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def fail(msg: str) -> None:
    print(f"  NG {msg}")
    sys.exit(1)


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("使い方: python scripts/check_packed_sidecar.py <PAC.app へのパス>")

    app = Path(sys.argv[1]).resolve()
    if not app.is_dir():
        fail(f".app が見つからない: {app}")

    res = app / "Contents" / "Resources"
    sidecar = res / "sidecar" / "sidecar"
    ffmpeg = res / "ffmpeg" / "ffmpeg"

    print("=== 同梱されているか ===")
    for label, path in (("サイドカー", sidecar), ("ffmpeg", ffmpeg), ("ffprobe", res / "ffmpeg" / "ffprobe")):
        if not path.exists():
            fail(f"{label} が無い: {path}")
        if not os.access(path, os.X_OK):
            fail(f"{label} に実行権限が無い: {path}")
        print(f"  OK {label}")

    print("\n=== 同梱 ffmpeg が動くか ===")
    out = subprocess.run([str(ffmpeg), "-version"], capture_output=True, text=True)
    if out.returncode != 0:
        fail(f"ffmpeg が起動しない:\n{out.stderr[-500:]}")
    print(f"  OK {out.stdout.splitlines()[0]}")

    print("\n=== 配布と同じ形でサイドカーを動かす ===")
    # 🔴 リポジトリの外で動かす。中で動かすと vendor/ffmpeg が見えて検査にならない。
    workdir = tempfile.mkdtemp()
    env = {k: v for k, v in os.environ.items() if k != "PAC_FFMPEG"}
    proc = subprocess.run(
        [str(sidecar)],
        input='{"id":1,"method":"env","params":{}}\n',
        capture_output=True,
        text=True,
        cwd=workdir,
        env=env,
        timeout=180,
    )
    lines = [l for l in proc.stdout.splitlines() if l.strip()]
    if not lines:
        fail(f"サイドカーが何も返さない:\n{proc.stderr[-800:]}")

    payload = json.loads(lines[-1])
    if "result" not in payload:
        fail(f"エラーが返った: {payload}")
    info = payload["result"]

    print(f"  frozen  : {info.get('frozen')}")
    print(f"  machine : {info.get('machine')}")

    if not info.get("frozen"):
        fail("固めた状態で動いていない")

    # アプリが実行時に掴みにいく物は、全部ここで場所を確かめる。
    # 「同梱されているか」だけ見ていて「どこを見に行くか」を見ていなかったのが
    # 友達の環境で落ちた原因なので、解決結果そのものを検める。
    targets = [("ffmpeg", info.get("ffmpeg"))]
    for key, value in (info.get("face_models") or {}).items():
        targets.append((f"顔のモデル({key})", value))

    for label, found in targets:
        print(f"  {label:18}: {found}")
        if not found or "見つからない" in str(found):
            fail(f"配布した形で {label} を見つけられていない")
        if str(res) not in str(found):
            fail(f"アプリの外の {label} を掴んでいる: {found}")
        if not Path(found).exists():
            fail(f"返ってきた場所に実体が無い: {found}")

    print(f"\n  OK {len(targets)} 件すべて、リポジトリの外からでもアプリの中を掴めている")


if __name__ == "__main__":
    main()
