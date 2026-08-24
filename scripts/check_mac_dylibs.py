"""渡した Mac の実行ファイルが、システム以外のライブラリに依存していないか検める。

    python scripts/check_mac_dylibs.py vendor/ffmpeg/ffmpeg vendor/ffmpeg/ffprobe

🔴 なぜ要るか（2026-08-24 に友達の Mac で踏んだ）:

    同梱していた ffmpeg が Homebrew の libxcb にリンクされていた。
    ビルドした macOS ランナーには Homebrew が入っているので、そこでは普通に動く。
    `ffmpeg -version` も通る。だから CI の関門を全部素通りした。

    Homebrew の無い友達の Mac では dyld がライブラリを見つけられず、
    ffmpeg が**起動すらできない**。画面には「元の動画が見つかりません」と出た。

    「動くか」を確かめるだけでは足りない。**どこに依存しているか**を見る必要がある。
    ランナーの環境は友達の環境ではない。

判定:
    /usr/lib/** と /System/** だけが許される。
    @rpath / @loader_path / /opt/homebrew/** / /usr/local/** はすべて NG。
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

# macOS のどの機体にも必ずあるもの。ここ以外に依存してはいけない。
ALLOWED_PREFIXES = ("/usr/lib/", "/System/")


def dependencies(binary: Path) -> list[str]:
    out = subprocess.run(
        ["otool", "-L", str(binary)], capture_output=True, text=True, check=True
    ).stdout
    deps = []
    for line in out.splitlines()[1:]:  # 1行目はファイル名
        line = line.strip()
        if not line:
            continue
        deps.append(line.split(" (compatibility")[0].strip())
    return deps


def main() -> None:
    targets = [Path(a) for a in sys.argv[1:]]
    if not targets:
        sys.exit("使い方: python scripts/check_mac_dylibs.py <実行ファイル> ...")

    bad = False
    for t in targets:
        if not t.exists():
            print(f"  NG {t} が無い")
            bad = True
            continue

        print(f"\n{t}")
        for dep in dependencies(t):
            ok = dep.startswith(ALLOWED_PREFIXES)
            print(f"  {'OK ' if ok else 'NG '}{dep}")
            if not ok:
                bad = True

    if bad:
        print(
            "\nNG 他所のライブラリに依存しています。"
            "\n   このまま配ると、そのライブラリを持っていない Mac では起動できません。"
            "\n   ビルド時の configure に --disable-autodetect が入っているか確認してください。"
        )
        sys.exit(1)

    print("\nOK すべてシステムのライブラリだけに依存しています")


if __name__ == "__main__":
    main()
