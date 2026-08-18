"""PyInstaller のエントリスクリプト。

sidecar/__main__.py は相対 import を使うので、PyInstaller のエントリには直接使えない。
薄いランチャを1枚かませる。

固めた実行ファイルは、引数なしで RPC サーバ、`--worker` で重い処理のワーカーになる
（sidecar/worker.py 参照）。sys.executable が実行ファイル自身になるので、
開発時と配布時で子プロセスの起動方法が変わらない。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sidecar.__main__ import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
