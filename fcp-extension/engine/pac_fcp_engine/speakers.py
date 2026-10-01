"""話者（喋っている人）を声で見分ける。中身は PAC 本体の sidecar/speakers.py。

パネルからの流れ:
    ⑤テロップの「声を見分ける」
      → 拡張（EngineClient）→ コンテナアプリ（EngineServer）
      → このエンジンを `--speakers params.json --out result.json` で起動

🔴 ここでは見分け方を作り直さないこと。
   閾値（0.5 / 2位との差 0.06 / まとめ 0.45）は PAC 本体で実素材を測って
   決めたもの（2026-09-11、ゲーム音つきの4人コラボ）。作り直すと必ず質が落ちる。

🔴 音（wav）は解析が取り出したものを使い回すこと。
   見分けるには元の音が要る。解析のたびに消していたので、
   `--keep-wav` で残すようにした（analyze.py 参照）。

🔴 できないときは理由を日本語で返すこと。
   声のモデル（40MB）や sherpa-onnx が同梱から漏れると、ここが
   「見分けられません」になる。黙って 0 件を返すと、
   「声が1人しかいない動画なのかも」と誤解したまま終わる。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from . import repo  # noqa: F401  (sidecar を import できるようにする副作用)


def run(params: dict[str, Any]) -> dict[str, Any]:
    """話者の操作をひとつ実行する。params["op"] は identify / enroll / update / delete / list。"""
    from sidecar.speakers import describe_backend, handle

    try:
        out = handle(params)
    except Exception as e:  # noqa: BLE001
        # 🔴 何が無いのかまで返す。「見分けられません」だけでは手が打てない
        return {"error": f"{e}", "backend": describe_backend()}
    out.setdefault("backend", describe_backend())
    return out


def run_file(params_path: str, out_path: str) -> dict[str, Any]:
    """JSON ファイルで受けて JSON ファイルに返す。

    🔴 引数（argv）に積まないこと。identify はテロップ全部の区間を渡すので、
       100枚を超えると argv の上限に当たる。
    """
    params = json.loads(Path(params_path).read_text(encoding="utf-8"))
    result = run(params)
    Path(out_path).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    return result
