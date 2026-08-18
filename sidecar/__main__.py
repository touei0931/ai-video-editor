"""stdio JSON-RPC ループ。

    $ python -m sidecar

stdin から1行1リクエスト（{"id":1,"method":"ping","params":{}}）を読み、
stdout に1行1レスポンスを書く。ログ・進捗は stderr に出す
（stdout を汚すとプロトコルが壊れるため）。
"""

from __future__ import annotations

import json
import sys
import traceback

from .rpc import dispatch


def _configure_streams() -> None:
    """文字コードを固定する。

    - stdin は BOM 付きで渡ってくることがある（PowerShell からの手動テスト等）ので utf-8-sig
    - stdout は **必ず UTF-8**。Windows の既定は cp932 で、日本語を含む JSON が壊れる
    - newline を "\\n" に固定（CRLF が混ざると行区切りプロトコルが乱れる）
    """
    sys.stdin.reconfigure(encoding="utf-8-sig")
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8")


def main() -> int:
    _configure_streams()
    print("sidecar: 起動しました", file=sys.stderr, flush=True)

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

        try:
            result = dispatch(method, params)
            resp = {"id": req_id, "result": result}
        except Exception as e:  # noqa: BLE001 — 落とさずクライアントに返す
            traceback.print_exc(file=sys.stderr)
            resp = {"id": req_id, "error": {"message": f"{type(e).__name__}: {e}"}}

        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    print("sidecar: stdin が閉じたので終了します", file=sys.stderr, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
