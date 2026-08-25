"""PAC 本体の解析ロジックを、書き換えずに借りるための道。

無音・フィラー・言い直しの検出（sidecar/cut.py）、幻聴の除去（sidecar/clean.py）、
テロップの組み立て（sidecar/telop.py）は PAC 本体で既に作り込まれている。
**コピーすると二重管理になって必ず片方が腐る**ので、import して使う。

PAC 側には一切手を入れない（読むだけ）。
"""

from __future__ import annotations

import sys
from pathlib import Path

# fcp-extension/engine/pac_fcp_engine/repo.py -> リポジトリのルート
REPO_ROOT = Path(__file__).resolve().parents[3]


def ensure_importable() -> Path:
    """sidecar パッケージを import できるようにする。

    PyInstaller で固めたときは sidecar も一緒に入っているので、
    ここで sys.path をいじると、固めた中身ではなく無い場所を見に行ってしまう。
    """
    if getattr(sys, "frozen", False):
        return REPO_ROOT
    root = str(REPO_ROOT)
    if root not in sys.path:
        sys.path.insert(0, root)
    return REPO_ROOT


ensure_importable()
