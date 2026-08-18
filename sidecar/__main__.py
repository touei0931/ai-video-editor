"""stdio JSON-RPC ループ。

    $ python -m sidecar

stdin から1行1リクエスト（{"id":1,"method":"ping","params":{}}）を読み、
stdout に1行1レスポンスを書く。ログ・進捗は stderr に出す
（stdout を汚すとプロトコルが壊れるため）。

🔴 スレッド構成（2026-08-18 の実測にもとづく）:

    メインスレッド : ジョブの実行（重い処理の子プロセス管理を含む）
    読み取りスレッド: stdin を読んでキューに積む / cancel を即時処理

  なぜこの向きか:
    - CTranslate2 の推論を**ワーカースレッドで走らせるとデッドロックする**
      （メインスレッドなら 2.7 秒で終わる処理が無限に固まる）。
    - 子プロセスに逃がしても、**その子プロセスをワーカースレッドから管理すると同じく固まる**。
      子プロセス単体では 2.8 秒で完走することを確認済み。
    - stdin を読むだけのスレッドは純粋な I/O なのでこの問題が起きない。

  結果として、重い処理は「メインスレッドが管理する子プロセス」で走る。
  同時に走るジョブは1つ。この用途では同時実行は不要なので、単純さを取る。
"""

from __future__ import annotations

import json
import queue
import sys
import threading
import traceback

from .rpc import dispatch

_write_lock = threading.Lock()

# 実行中・待機中リクエストのキャンセルフラグ
_cancel_flags: dict[int, threading.Event] = {}
_flags_lock = threading.Lock()

_jobs: queue.Queue = queue.Queue()
_STOP = object()


def _configure_streams() -> None:
    """文字コードを固定する。

    - stdin は BOM 付きで渡ってくることがある（PowerShell からの手動テスト等）ので utf-8-sig
    - stdout は **必ず UTF-8**。Windows の既定は cp932 で、日本語を含む JSON が壊れる
    - newline を "\\n" に固定（CRLF が混ざると行区切りプロトコルが乱れる）
    """
    sys.stdin.reconfigure(encoding="utf-8-sig")
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8")


def send(payload: dict) -> None:
    with _write_lock:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def make_progress(req_id: int | None):
    """進捗通知を送る関数を作る。id を持たない = 応答ではなく通知。"""

    def emit(value: float, message: str = "") -> None:
        send({
            "method": "progress",
            "params": {"request_id": req_id, "value": round(value, 4), "message": message},
        })

    return emit


def make_cancel_checker(req_id: int | None):
    def is_cancelled() -> bool:
        with _flags_lock:
            flag = _cancel_flags.get(req_id) if req_id is not None else None
        return bool(flag and flag.is_set())

    return is_cancelled


def handle(req_id: int | None, method: str, params: dict) -> None:
    try:
        result = dispatch(
            method,
            params,
            on_progress=make_progress(req_id),
            is_cancelled=make_cancel_checker(req_id),
        )
        send({"id": req_id, "result": result})
    except Exception as e:  # noqa: BLE001 — 落とさずクライアントに返す
        traceback.print_exc(file=sys.stderr)
        send({"id": req_id, "error": {"message": f"{type(e).__name__}: {e}"}})
    finally:
        if req_id is not None:
            with _flags_lock:
                _cancel_flags.pop(req_id, None)


def read_stdin() -> None:
    """stdin を読んでジョブを積む。cancel だけはここで即座に処理する。"""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            print(f"sidecar: 不正なJSON: {e}", file=sys.stderr, flush=True)
            continue

        req_id = req.get("id")
        method = req.get("method", "")
        params = req.get("params") or {}

        # キャンセルは実行中のジョブを待たずに反映する
        if method == "cancel":
            target = params.get("request_id")
            with _flags_lock:
                flag = _cancel_flags.get(target)
                if flag:
                    flag.set()
            send({"id": req_id, "result": {"cancelled": bool(flag)}})
            continue

        if req_id is not None:
            with _flags_lock:
                _cancel_flags[req_id] = threading.Event()

        _jobs.put((req_id, method, params))

    # stdin が閉じた = 親プロセス（Electron）が終了したか、リクエストを流し終えた
    _jobs.put(_STOP)


def main() -> int:
    # 重い処理は自分自身を --worker で起動した別プロセスで走らせる（worker.py）
    if "--worker" in sys.argv:
        from .worker import worker_main

        return worker_main()

    _configure_streams()
    print("sidecar: 起動しました", file=sys.stderr, flush=True)

    reader = threading.Thread(target=read_stdin, daemon=True)
    reader.start()

    # メインスレッドがジョブを実行する（重い処理の子プロセス管理もここ）
    while True:
        job = _jobs.get()
        if job is _STOP:
            break
        handle(*job)

    print("sidecar: 終了します", file=sys.stderr, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
