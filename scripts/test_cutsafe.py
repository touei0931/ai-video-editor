"""カットを当ててよいか（前後の繋がり）の検査。sidecar/cutsafe.py

🔴 守っていること:
   - 無音は見ない（語が消えないので繋がりの問題が起きない）
   - 言い直しに「同じ語が後ろにもある」を当てない。言い直しは**前を消すのが正解**で、
     当てると候補のほぼ全部に印が付く（実素材 41件中 7件が誤検出だった）
   - 1文字の接続詞（「で、」）を指示語として扱わない。「でか。」に当たる
   - 読めない返事は「残す」に倒す（判断がつかないものを切ると中身が消える）
   - 判断は書き換えない。返すのは印と理由だけ

実行: python scripts/test_cutsafe.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _console import enable_utf8  # noqa: E402

from sidecar.cutsafe import build_messages, check, parse_reply, review, verify  # noqa: E402

failed = 0


def ok(name: str, cond: bool, detail: str = "") -> None:
    global failed
    if not cond:
        failed += 1
    print(f"[cutsafe] {'OK  ' if cond else 'NG  '} {name}")
    if detail:
        print(f"          {detail}")


def cand(kind="aside", text="", before="", after="", cid="c1"):
    return {"id": cid, "kind": kind, "text": text, "before": before, "after": after}


def main() -> int:
    enable_utf8()

    # ── 残した方がいい形 ──
    hint = check(cand(text="あれ、これ使えるんだっけ?", after="そう、それで大丈夫"))
    ok("直後が指示語なら印が付く", hint is not None and hint["risk"] == "high", str(hint))

    hint = check(cand(text="これ、いけるかな?", after="はい、大丈夫です"))
    ok("問いと答えの片方だけ消えるのを止める", hint is not None, str(hint))

    hint = check(cand(text="うん、大丈夫", before="これ、いけるかな?"))
    ok("直前の問いに答えている所も止める", hint is not None, str(hint))

    hint = check(cand(text="マリオパーティーやったことある?", after="マリオパーティーは初めて"))
    ok("独り言で同じ内容語が後に出たら印", hint is not None and hint["risk"] == "medium", str(hint))

    # ── 印を付けない形 ──
    ok("無音は見ない", check(cand(kind="silence", text="", after="それで")) is None)
    ok("言い直しに「同じ語が後にある」を当てない",
       check(cand(kind="restate", text="ペコちゃん", after="ペコちゃん先輩")) is None)
    ok("1文字の接続詞は指示語にしない（「でか。」に当たる）",
       check(cand(text="マジ", after="でか。はい。")) is None)
    ok("繋がりの手がかりが無ければ印なし",
       check(cand(text="えーっと", after="では始めます")) is None)

    # ── 全件に印を付ける ──
    cands = [
        cand(kind="silence", cid="c0"),
        cand(kind="aside", text="あれ?", after="それでいこう", cid="c1"),
        cand(kind="filler", text="えー", after="では", cid="c2"),
    ]
    r = review(cands)
    ok("言葉が消える候補だけ数える", r["checked"] == 2, str(r["checked"]))
    ok("印は候補にも書き込む", cands[1].get("keep_hint") is not None)
    ok("印が付かないものには書き込まない", "keep_hint" not in cands[2])
    ok("一覧で返す", [f["id"] for f in r["flagged"]] == ["c1"], str(r["flagged"]))

    # ── LLM に聞く所 ──
    msgs = build_messages("あれ?", "前の話", "次の話")
    ok("前後を一緒に見せる", "前の話" in msgs[1]["content"] and "次の話" in msgs[1]["content"])
    ok("返すのは JSON だと伝える", "JSON" in msgs[0]["content"])

    ok("切る判断を読める", parse_reply('{"判断":"切る","理由":"言いよどみ"}') == {"cut": True, "reason": "言いよどみ"})
    ok("残す判断を読める", (parse_reply('{"判断":"残す","理由":"前を受けている"}') or {}).get("cut") is False)
    ok("読めない返事は None", parse_reply("わかりません") is None)

    asked: list[str] = []

    def ask(messages):
        asked.append(messages[1]["content"])
        return '{"判断":"切る","理由":"ただのつぶやき"}'

    got = verify(cands, ask)
    ok("既定では言葉が消える候補を全部聞く", got["checked"] == 2, str(got["checked"]))
    ok("判断を id つきで返す", {v["id"] for v in got["verdicts"]} == {"c1", "c2"}, str(got["verdicts"]))
    # 🔴 判断（decision）は書き換えない
    ok("候補の判断は触らない", all("decision" not in c for c in cands))

    got = verify(cands, ask, only_flagged=True)
    ok("印の付いたものだけに絞れる", got["checked"] == 1, str(got["checked"]))

    def broken(messages):
        return "答えられません"

    got = verify(cands, broken)
    ok("🔴 読めない返事は残すに倒れる",
       all(v["cut"] is False for v in got["verdicts"]), str(got["verdicts"]))

    def dead(messages):
        raise RuntimeError("モデルがありません")

    got = verify(cands, dead)
    ok("落ちずに理由を返す", "error" in got, str(got.get("error")))

    got = verify(cands, ask, is_cancelled=lambda: True)
    ok("途中で止められる", got.get("cancelled") is True)

    print()
    print("test-cutsafe: OK" if failed == 0 else f"test-cutsafe: {failed} 件失敗")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
