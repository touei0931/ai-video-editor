#!/usr/bin/env python3
"""重い処理（文字起こし）を「同一プロセス」「子プロセス」の両方で走らせて比較する。

CTranslate2 の推論がどの実行形態で固まるのかを切り分けるための道具。
2026-08-18 に「ワーカースレッドだとデッドロックする」ことが判明したため、
以後この手の切り分けが必要になったらこれを使う。

    $ python scripts/heavy_probe.py <音声パス>
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from _console import enable_utf8  # noqa: E402

enable_utf8()


def main() -> int:
    if len(sys.argv) < 2:
        sys.exit("使い方: python scripts/heavy_probe.py <音声パス>")

    audio = sys.argv[1]
    params = {"audio_path": audio, "model": "base", "language": "ja"}

    def on_progress(v: float, m: str = "") -> None:
        print(f"  進捗 {v:.2f} {m}")

    # 1. 同一プロセス・メインスレッド
    from sidecar.heavy import dispatch_heavy

    print("[1] 同一プロセス（メインスレッド）")
    t0 = time.time()
    r = dispatch_heavy("transcribe", params, on_progress)
    print(f"  → {time.time() - t0:.1f}秒 / x{r['realtime_factor']}")

    # 2. 子プロセス
    from sidecar.worker import run_in_process

    print("[2] 子プロセス")
    t0 = time.time()
    r2 = run_in_process("transcribe", params, on_progress, lambda: False)
    print(f"  → {time.time() - t0:.1f}秒 / x{r2['realtime_factor']}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
