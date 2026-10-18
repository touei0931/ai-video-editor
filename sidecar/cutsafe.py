"""切ってよいカットかを、前後の話の繋がりから確かめる。

なぜ要るか:
    独り言・言い直し・フィラーを全部切ると、**前後の関係が消えて話が分からなく
    なる**ことがある（2026-10-19、利用者）。カットの判定（cut.py）は「形」だけを
    見ていて、「切ったあと話が通じるか」は見ていない。

    例:
        「あれ、これ使えるんだっけ？」 ← 独り言として候補に挙がる
        「そう、それで大丈夫」         ← これを残すと「そう」「それ」が宙に浮く

2段構えにしている。

    1. ここ（規則）… 無料・即時・理由が説明できる。
       「直後が指示語で始まる」「問いと答えの片方だけ消える」など、
       **繋がりが切れる形**を見つけて「残した方がいい」の印を付ける
    2. LLM（proof_llm.Proofreader を使い回す）… 印が付いたものだけを
       前後の会話と一緒に見せて、切ってよいかを答えさせる

🔴 勝手に切らないこと・勝手に残さないこと。
   ここが出すのは**印と理由**だけ。決めるのは人で、画面の「全部承認」からは
   印の付いたものを外す（まとめて切るときに話を壊さないため）。

🔴 無音は対象にしない。
   無音を切っても語は消えないので、繋がりの問題は起きない。
   対象は「言葉が消える」カット（独り言・言い直し・フィラー）。
"""

from __future__ import annotations

import re
from typing import Any, Callable

#: 言葉が消えるカット。無音は繋がりの問題を起こさないので見ない
SPOKEN_KINDS = ("aside", "restate", "filler")

"""
#: 直後がこれで始まるなら、消えた内容を指している見込みが高い。

🔴 1文字の接続詞（「で、」「じゃ、」）は入れないこと。
   句読点を外して突き合わせるので、「でか。」のような語の頭に当たってしまう
   （実素材で唯一の印がこの誤検出だった、2026-10-19）。
   2文字以上で、それだけで指示語だと分かるものに限る。
"""
_POINTERS = (
    "それ", "それで", "そう", "そうそう", "あれ", "あれで", "これ", "この",
    "その", "あの", "だから", "なので", "じゃあ", "つまり",
    "ということで", "ってこと", "そっち", "こっち", "あっち",
)

#: 問いの言い回し（末尾）
_ASK_TAIL = re.compile(r"(?:？|\?|の|か|かな|かね|だっけ|ですか|ますか|ない)$")

#: 答えの言い回し（先頭）
_ANSWER_HEAD = (
    "はい", "うん", "そう", "違", "ちが", "いや", "ううん", "ない", "ある",
    "できる", "できない", "大丈夫", "オッケー", "ok", "OK", "だめ", "ダメ",
)

#: 内容語として数えない短い語・ひらがなだけの語
_STOP = re.compile(r"^[ぁ-んー、。！？!?\s]*$")


def _norm(text: str) -> str:
    return re.sub(r"[、。！？!?\s]", "", text or "")


def _content_words(text: str) -> set[str]:
    """内容語っぽいもの（カタカナ・漢字の2文字以上）。cut.py の見方に合わせる。"""
    out: set[str] = set()
    for m in re.finditer(r"[ァ-ヿー]{2,}|[一-鿿]{2,}", text or ""):
        out.add(m.group(0))
    return out


def _starts_with_pointer(text: str) -> str | None:
    head = _norm(text)
    for p in _POINTERS:
        if head.startswith(_norm(p)):
            return p
    return None


def _looks_like_question(text: str) -> bool:
    t = _norm(text)
    return bool(t) and bool(_ASK_TAIL.search(t))


def _looks_like_answer(text: str) -> bool:
    t = _norm(text)
    return any(t.startswith(_norm(a)) for a in _ANSWER_HEAD)


def check(candidate: dict[str, Any]) -> dict[str, Any] | None:
    """1件分。切ると繋がりが切れそうなら {"risk", "reason"} を返す。

    candidate は cut.py が作る形（text / before / after を使う）。
    """
    if candidate.get("kind") not in SPOKEN_KINDS:
        return None
    text = candidate.get("text") or candidate.get("word") or ""
    before = candidate.get("before") or ""
    after = candidate.get("after") or ""
    if not _norm(text):
        return None

    # 1) 直後が指示語で始まる → 消した内容を指している見込み
    pointer = _starts_with_pointer(after)
    if pointer:
        return {
            "risk": "high",
            "reason": f"このあとが「{pointer}」で始まります。消すと何を指しているか分からなくなります",
        }

    # 2) ここが問いで、直後が答え → 問いだけ消えると答えが浮く
    if _looks_like_question(text) and _looks_like_answer(after):
        return {
            "risk": "high",
            "reason": "ここが問いかけで、このあとが答えになっています。問いだけ消すと答えが浮きます",
        }

    # 3) 直前が問いで、ここが答え → 答えだけ消えると問いが浮く
    if _looks_like_question(before) and _looks_like_answer(text):
        return {
            "risk": "high",
            "reason": "直前の問いかけに答えている所です。消すと問いが浮きます",
        }

    """
    4) ここにしか出ない内容語が、このあとで使われている → 参照されている

    🔴 言い直し（restate）には当てないこと。
       言い直しは「同じ語をもう一度言っている」から候補になっている。
       後ろに同じ語が出るのは当たり前で、むしろ**前を消すのが正解**。
       ここに当てると、言い直し候補のほぼ全部に印が付く
       （実素材で 41件中 7件が言い直しの誤検出だった、2026-10-19）。
    """
    mine = _content_words(text) if candidate.get("kind") == "aside" else set()
    if mine:
        shared = mine & _content_words(after)
        if shared:
            word = sorted(shared, key=len, reverse=True)[0]
            return {
                "risk": "medium",
                "reason": f"「{word}」がこのあとにも出てきます。先に言った所を消すと繋がりません",
            }
    return None


def review(candidates: list[dict[str, Any]]) -> dict[str, Any]:
    """全件に印を付ける（破壊的に keep_hint を足す）。

    返すもの: {"flagged": [{id, risk, reason}], "checked": n}
    """
    flagged: list[dict[str, Any]] = []
    checked = 0
    for c in candidates:
        if c.get("kind") not in SPOKEN_KINDS:
            continue
        checked += 1
        hint = check(c)
        if hint:
            c["keep_hint"] = hint
            flagged.append({"id": c.get("id"), **hint})
    return {"flagged": flagged, "checked": checked}


# ── LLM で確かめる（印が付いたものだけ）──────────────────────

_SYSTEM = """あなたは動画編集の下ごしらえを手伝う人です。
これから「カットしようとしている部分」と、その直前・直後の発言を見せます。
その部分を**消しても話が通じるか**だけを判断してください。

守ること:
- 消すと前後の関係が分からなくなるなら「残す」
- ただの言いよどみ・撮り直しのつぶやき・独り言で、消しても話が通じるなら「切る」
- 迷ったら「残す」
- 理由は20文字程度の日本語で短く

返すのは JSON だけ:
{"判断":"切る","理由":"短い理由"}"""


def build_messages(target: str, before: str, after: str) -> list[dict[str, str]]:
    lines = []
    if before:
        lines.append(f"直前の発言: {before}")
    lines.append(f"消そうとしている部分: {target}")
    if after:
        lines.append(f"直後の発言: {after}")
    return [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": "\n".join(lines)},
    ]


def parse_reply(text: str) -> dict[str, Any] | None:
    """返事を {"cut": bool, "reason": str} にする。読めなければ None。"""
    import json

    if not text:
        return None
    fenced = re.search(r"```(?:json)?\s*(.+?)```", text, re.S)
    if fenced:
        text = fenced.group(1)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        data = json.loads(text[start : end + 1])
    except ValueError:
        return None
    verdict = str(data.get("判断") or data.get("verdict") or "").strip()
    reason = str(data.get("理由") or data.get("reason") or "").strip()
    if not verdict:
        return None
    """
    🔴 読めない返事は「残す」に倒すこと。
       判断がつかないものを切ると、話の中身が消える。
    """
    return {"cut": verdict.startswith("切"), "reason": reason}


def verify(
    candidates: list[dict[str, Any]],
    ask: Callable[[list[dict[str, str]]], str],
    *,
    # 🔴 既定では「言葉が消える候補」を全部確かめる。規則で拾えるのはごく一部
    #    （実素材で 41件中 0〜1件）。「全部切ったら話が分からなくなる」を防ぐには
    #    1件ずつ聞く必要がある。件数は数十なので手元のモデルでも終わる
    only_flagged: bool = False,
    is_cancelled: Callable[[], bool] | None = None,
    on_progress: Callable[[float, str], None] | None = None,
) -> dict[str, Any]:
    """LLM に聞いて、切ってよいかを確かめる。本文も判断も書き換えない。

    ask は proof_llm.Proofreader().ask をそのまま渡せる。
    返すもの: {"verdicts": [{id, cut, reason}], "checked": n}
    """
    targets = [
        c for c in candidates
        if c.get("kind") in SPOKEN_KINDS and (not only_flagged or c.get("keep_hint"))
    ]
    verdicts: list[dict[str, Any]] = []
    for i, c in enumerate(targets):
        if is_cancelled and is_cancelled():
            return {"cancelled": True, "verdicts": verdicts, "checked": len(verdicts)}
        text = c.get("text") or c.get("word") or ""
        try:
            reply = ask(build_messages(text, c.get("before") or "", c.get("after") or ""))
        except Exception as e:  # noqa: BLE001
            return {"error": f"確かめられませんでした: {e}", "verdicts": verdicts, "checked": len(verdicts)}
        got = parse_reply(reply)
        if got is None:
            # 読めない返事は「残す」に倒す
            got = {"cut": False, "reason": "判断がつきませんでした"}
        verdicts.append({"id": c.get("id"), **got})
        if on_progress and targets:
            on_progress((i + 1) / len(targets), "切ってよいか確かめています")
    return {"cancelled": False, "verdicts": verdicts, "checked": len(verdicts)}
