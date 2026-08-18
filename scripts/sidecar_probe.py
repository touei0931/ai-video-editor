#!/usr/bin/env python3
"""サイドカーを子プロセスとして起動し、プロトコルを直接叩く（切り分け用）。

Electron を挟まずに「サイドカー単体が正しく応答するか」を確かめる。
Electron 経由で止まったときに、どちら側の問題かをすぐ判別できる。

    $ python scripts/sidecar_probe.py                 # システム Python で起動
    $ python scripts/sidecar_probe.py path/to/sidecar # 固めたバイナリで起動
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _console import enable_utf8  # noqa: E402

enable_utf8()

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    positional = [a for a in sys.argv[1:] if not a.startswith("--")]
    # --transcribe の引数（音声パス）は位置引数から除く
    if "--transcribe" in sys.argv:
        audio_arg = sys.argv[sys.argv.index("--transcribe") + 1]
        positional = [a for a in positional if a != audio_arg]

    cmd = [positional[0]] if positional else [sys.executable, "-m", "sidecar"]

    print(f"起動: {' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd,
        cwd=str(ROOT),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        bufsize=1,
    )

    def pump_stderr() -> None:
        for line in proc.stderr:
            print(f"  [stderr] {line.rstrip()}")

    threading.Thread(target=pump_stderr, daemon=True).start()

    def send(obj: dict) -> None:
        proc.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
        proc.stdin.flush()

    def read_until_id(target_id: int, timeout: float = 30.0) -> dict | None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = proc.stdout.readline()
            if not line:
                return None
            msg = json.loads(line)
            if msg.get("method") == "progress":
                print(f"  進捗 {msg['params']['value']:.2f} {msg['params']['message']}")
                continue
            if msg.get("id") == target_id:
                return msg
        return None

    failures = 0

    # 1. env
    t0 = time.time()
    send({"id": 1, "method": "env", "params": {}})
    res = read_until_id(1, timeout=15)
    if res and "result" in res:
        print(f"✓ env ({time.time() - t0:.2f}秒): {res['result']['platform']} / frozen={res['result']['frozen']}")
    else:
        print(f"✗ env: 応答なし（{res}）")
        failures += 1

    # 2. 進捗
    send({"id": 2, "method": "sleep", "params": {"seconds": 1.0, "steps": 10}})
    res = read_until_id(2, timeout=20)
    print(f"{'✓' if res and 'result' in res else '✗'} sleep: {res.get('result') if res else 'なし'}")
    if not (res and "result" in res):
        failures += 1

    # 3. キャンセル
    send({"id": 3, "method": "sleep", "params": {"seconds": 10, "steps": 100}})
    time.sleep(0.8)
    send({"id": 99, "method": "cancel", "params": {"request_id": 3}})
    res = read_until_id(3, timeout=20)
    ok = bool(res and res.get("result", {}).get("cancelled"))
    print(f"{'✓' if ok else '✗'} cancel: {res.get('result') if res else 'なし'}")
    if not ok:
        failures += 1

    # 4. 文字起こし（--transcribe <音声パス> を付けたときだけ）
    if "--transcribe" in sys.argv:
        audio = sys.argv[sys.argv.index("--transcribe") + 1]
        print(f"文字起こし: {audio}")
        t0 = time.time()
        send({
            "id": 4,
            "method": "transcribe",
            "params": {
                "audio_path": audio,
                "model": os.environ.get("ASR_MODEL", "base"),
                "language": "ja",
            },
        })
        res = read_until_id(4, timeout=600)
        if res and "result" in res:
            r = res["result"]
            print(f"✓ transcribe ({time.time() - t0:.1f}秒): "
                  f"{r['duration']}秒 → x{r['realtime_factor']} / {r['segment_count']}セグメント")
            print(f"  {r['text'][:80]}…")
        else:
            print(f"✗ transcribe: {res}")
            failures += 1

    proc.stdin.close()
    proc.wait(timeout=30)
    print(f"\n終了コード: {proc.returncode}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
