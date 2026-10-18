"""文字起こしの見直し。中身は PAC 本体の sidecar/proof.py と sidecar/proof_llm.py。

パネルからの流れ:
    ⑤テロップの「文字起こしを見直す」
      → 拡張（EngineClient）→ コンテナアプリ（EngineServer）
      → このエンジンを `--proofread params.json --out result.json` で起動

2段ある。
    1. 決定論的（proof.py）… 言い換え表の置換と「怪しい所」の印。無料・即時
    2. ローカル LLM（proof_llm.py）… 前後の会話を読んで**候補**を出す。
       初回だけモデルの取得（約 2.3GB）。ネットには出ない

🔴 本文を黙って書き換えて返さないこと。
   直すのは利用者が書いた言い換え表の通りの置換だけで、LLM の分は候補として返す。
   テロップは発言の引用なので、「たぶんこう言った」を自動で当てては困る。

🔴 できないときは理由を日本語で返すこと。
   モデルが無い・Ollama が起きていない、は普通に起こる。
   黙って 0 件を返すと「見直したのに何も出ない＝誤りが無い」と誤解される。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from . import repo  # noqa: F401  (sidecar を import できるようにする副作用)


def run(params: dict[str, Any]) -> dict[str, Any]:
    """op は "review"（候補を出す）か "backend"（部品の有無を見る）。"""
    from sidecar.proof import parse_names, parse_swaps, review as rule_review
    from sidecar.proof_llm import Proofreader, pick_engine

    op = str(params.get("op") or "review")
    engine = str(params.get("engine") or pick_engine())

    if op == "backend":
        try:
            return {"backend": Proofreader(engine, params.get("model")).describe()}
        except Exception as e:  # noqa: BLE001
            return {"error": str(e)}

    if op == "cuts":
        """
        カットを当ててよいかを、前後の発言から確かめる。

        🔴 判断は書き換えない。返すのは「切る/残す」の見立てと理由だけで、
           決めるのは人（画面の④カット）。
        """
        from sidecar import cutsafe

        candidates: list[dict[str, Any]] = list(params.get("candidates") or [])
        if not candidates:
            return {"error": "確かめるカット候補がありません"}

        rules = cutsafe.review(candidates)
        out: dict[str, Any] = {
            "flagged": rules["flagged"],
            "verdicts": [],
            "checked": 0,
        }
        if not params.get("llm", True):
            return out
        try:
            reader = Proofreader(engine, params.get("model"))
        except Exception as e:  # noqa: BLE001
            out["error"] = str(e)
            return out
        out["backend"] = reader.describe()
        got = cutsafe.verify(
            candidates,
            reader.ask,
            only_flagged=bool(params.get("onlyFlagged", False)),
        )
        out["verdicts"] = got.get("verdicts", [])
        out["checked"] = got.get("checked", 0)
        if got.get("error"):
            out["error"] = got["error"]
        return out

    if op != "review":
        return {"error": f"知らない操作です: {op}"}

    telops: list[dict[str, Any]] = list(params.get("telops") or [])
    if not telops:
        return {"error": "見直すテロップがありません"}

    names = parse_names(str(params.get("names") or ""))
    swaps = parse_swaps(str(params.get("swaps") or ""))

    # 1段目。言い換え表の置換（本文を直す）と、怪しい所の印
    rules = rule_review(telops, names=names, swaps=swaps)
    fixed = [
        {"id": t.get("id"), "text": t.get("text")}
        for t in telops
        if t.get("fixed_by_swap")
    ]

    out: dict[str, Any] = {
        "fixed": fixed,
        "suspects": rules["suspects"],
        "candidates": [],
        "checked": 0,
    }
    if not params.get("llm", True):
        return out

    # 2段目。前後の会話を読んで候補を出す
    try:
        reader = Proofreader(engine, params.get("model"))
    except Exception as e:  # noqa: BLE001
        out["error"] = str(e)
        return out
    out["backend"] = reader.describe()

    only = params.get("onlyIds")
    llm = reader.review(
        telops,
        names=names,
        only_ids=list(only) if only else None,
    )
    out["candidates"] = llm.get("candidates", [])
    out["checked"] = llm.get("checked", 0)
    if llm.get("error"):
        out["error"] = llm["error"]
    return out


def run_file(params_path: str, out_path: str) -> dict[str, Any]:
    """JSON ファイルで受けて JSON ファイルに返す（argv には積めない量になるため）。"""
    params = json.loads(Path(params_path).read_text(encoding="utf-8"))
    result = run(params)
    Path(out_path).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    return result
