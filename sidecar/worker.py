"""重い処理を別プロセスで実行する。

🔴 なぜスレッドではなく別プロセスか（2026-08-18 に実測して判明）:
   CTranslate2（faster-whisper）の推論を Python のワーカースレッドで走らせると、
   Windows でデッドロックして戻ってこない。メインスレッドなら 2.7 秒で終わる同じ処理が、
   スレッド化した途端に無限に固まった。

🔴 なぜ multiprocessing ではなく subprocess か:
   multiprocessing の spawn は子プロセスで**main モジュールを再 import** する。
   `python -m sidecar` で起動していると再 import に失敗し、子が無言で死ぬ
   （stderr にも何も出ないので原因が分からない）。
   自分自身を `--worker` で起動する方式なら、開発時も PyInstaller で固めた後も
   まったく同じ経路になり、この種の落とし穴が消える。

別プロセスにすること自体が設計として優れている点:
  - **本当にキャンセルできる**（プロセスを終了させればよい）
  - **クラッシュが隔離される**（推論ライブラリが落ちても RPC ループは生き残る）
  - 親プロセスに推論ライブラリを読み込ませずに済む
"""

from __future__ import annotations

import json
import subprocess
import sys
from typing import Any, Callable

ProgressFn = Callable[[float, str], None]
CancelFn = Callable[[], bool]

HEAVY_METHODS = {"transcribe"}


def worker_command() -> list[str]:
    """自分自身をワーカーとして起動するコマンド。

    PyInstaller で固めると sys.executable が固めた実行ファイルそのものになるので、
    開発時も配布時も同じ書き方で通る。
    """
    if getattr(sys, "frozen", False):
        return [sys.executable, "--worker"]
    return [sys.executable, "-m", "sidecar", "--worker"]


def run_in_subprocess(
    method: str,
    params: dict[str, Any],
    on_progress: ProgressFn,
    is_cancelled: CancelFn,
) -> dict[str, Any]:
    proc = subprocess.Popen(
        worker_command(),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=None,  # 子の stderr は親のものをそのまま使う（ログが素通しで見える）
        text=True,
        encoding="utf-8",
        bufsize=1,
    )

    assert proc.stdin and proc.stdout
    proc.stdin.write(json.dumps({"method": method, "params": params}, ensure_ascii=False) + "\n")
    proc.stdin.flush()

    result: dict[str, Any] | None = None
    error: dict[str, Any] | None = None

    try:
        for line in proc.stdout:
            if is_cancelled():
                proc.terminate()
                return {"cancelled": True}

            line = line.strip()
            if not line:
                continue

            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                # 推論ライブラリが stdout に直接吐いた場合。プロトコルではないので無視する。
                print(f"worker: 解釈できない出力: {line[:200]}", file=sys.stderr, flush=True)
                continue

            kind = msg.get("type")
            if kind == "progress":
                on_progress(msg["value"], msg.get("message", ""))
            elif kind == "result":
                result = msg["result"]
                break
            elif kind == "error":
                error = msg
                break
    finally:
        try:
            proc.stdin.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

    if error:
        raise RuntimeError(f"{error['message']}\n{error.get('traceback', '')}")

    if result is None:
        raise RuntimeError(
            f"処理プロセスが結果を返さずに終了しました（exitcode={proc.returncode}）。"
            "推論ライブラリのクラッシュの可能性があります。"
        )

    return result


def worker_main() -> int:
    """ワーカーとして起動されたときのエントリ（--worker）。

    stdin から1行の JSON でジョブを受け取り、
    stdout に進捗（type=progress）と結果（type=result / error）を JSON 行で返す。
    """
    sys.stdin.reconfigure(encoding="utf-8-sig")
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8")

    def emit(payload: dict) -> None:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    line = sys.stdin.readline()
    if not line.strip():
        emit({"type": "error", "message": "ジョブが渡されませんでした"})
        return 1

    job = json.loads(line)

    # 重いライブラリはここで初めて読み込む
    from .heavy import dispatch_heavy

    try:
        result = dispatch_heavy(
            job["method"],
            job.get("params") or {},
            lambda v, m="": emit({"type": "progress", "value": v, "message": m}),
        )
        emit({"type": "result", "result": result})
        return 0
    except Exception as e:  # noqa: BLE001
        import traceback

        emit({
            "type": "error",
            "message": f"{type(e).__name__}: {e}",
            "traceback": traceback.format_exc(),
        })
        return 1
