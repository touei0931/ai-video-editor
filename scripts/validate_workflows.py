#!/usr/bin/env python3
"""GitHub Actions のワークフロー YAML を push 前に検証する。

ワークフローの構文エラーは push しないと分からず、1回あたり数分を無駄にする。
特に `run: |` ブロック内のヒアドキュメントは、閉じタグを列0に書くと
ブロックスカラーが途中で終わってファイル全体が壊れる（実際に踏んだ）。

    $ python scripts/validate_workflows.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _console import enable_utf8  # noqa: E402

enable_utf8()

try:
    import yaml
except ImportError:
    sys.exit("pyyaml が必要です: python -m pip install pyyaml")

ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = ROOT / ".github" / "workflows"


def main() -> int:
    files = sorted(WORKFLOWS.glob("*.yml")) + sorted(WORKFLOWS.glob("*.yaml"))
    if not files:
        print("ワークフローが見つかりません")
        return 1

    failed = False
    for path in files:
        try:
            doc = yaml.safe_load(path.read_text(encoding="utf-8"))
        except yaml.YAMLError as e:
            failed = True
            print(f"✗ {path.name}: YAML として壊れています\n   {e}")
            continue

        if not isinstance(doc, dict):
            failed = True
            print(f"✗ {path.name}: トップレベルがマッピングではありません")
            continue

        # YAML 1.1 では裸の `on` が真偽値 True として読まれる
        triggers = doc.get("on", doc.get(True))
        jobs = doc.get("jobs")

        if not triggers:
            failed = True
            print(f"✗ {path.name}: トリガー（on）がありません")
            continue
        if not isinstance(jobs, dict) or not jobs:
            failed = True
            print(f"✗ {path.name}: jobs がありません")
            continue

        trigger_names = list(triggers) if isinstance(triggers, (dict, list)) else [triggers]
        print(f"✓ {path.name}")
        print(f"    トリガー: {', '.join(map(str, trigger_names))}")
        for job_name, job in jobs.items():
            steps = job.get("steps", []) if isinstance(job, dict) else []
            runs_on = job.get("runs-on", "?") if isinstance(job, dict) else "?"
            print(f"    ジョブ {job_name}: {runs_on} / {len(steps)} ステップ")

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
