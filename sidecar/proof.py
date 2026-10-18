"""文字起こしを読み直して、怪しい所に印を付け、直す。

2段構えにしている。

    1. ここ（proof.py）… **決定論的**な見直し。無料・即時・理由が説明できる。
       - 出てくる名前の表（「ホロライブ」など）と言い換え表で、確実な誤りを直す
       - 「ここは怪しい」の印を付ける（書き換えはしない）
    2. proof_llm.py … 前後の会話を読んで**候補**を出す（ローカルの小さな LLM）。
       直すかどうかは人が決める。

🔴 黙って書き換えてよいのは、利用者が表に書いた言い換えだけ。
   テロップは発言の引用なので、こちらの判断で言い回しを変えてはいけない。
   「たぶんこう言った」は候補として見せ、人に選ばせる。

🔴 印は**少なく正確に**。全部に「要確認」が付くと誰も見ない。
   確信度（faster-whisper）が使えるならそれを使い、使えない（Qwen3-ASR は
   確信度を返さない）ときは、下の数少ない手がかりだけで印を付ける。

実素材（VTuber のコラボ切り抜き5本）で見えた典型:
   「オロライブ」（ホロライブ）     … 確信度 0.94。確信度では拾えない。名前の表で直る
   「母はいはい!」                  … 1文字の漢字＋感動詞。文脈を読まないと直せない
   「COOKUY どーす」「SVP」         … 日本語の中に浮いたラテン文字
"""

from __future__ import annotations

import re
from typing import Any, Iterable

#: 日本語の文字（ひらがな・カタカナ・漢字・長音）
_JA = r"぀-ヿ㐀-䶿一-鿿ｦ-ﾟ々ー"
#: 1語の中で日本語とラテン文字が混ざっている（「ハグイwe」）
_MIXED = re.compile(rf"[{_JA}][A-Za-z]|[A-Za-z][{_JA}]")
#: 日本語の中に浮いたラテン文字の塊（「COOKUY」「SVP」）。2文字以上
_LATIN = re.compile(r"(?<![A-Za-z])[A-Za-z]{2,}(?![A-Za-z])")
#: よく出るので見逃してよいラテン語
_LATIN_OK = {
    "EN", "ID", "JP", "KR", "CN", "TV", "PC", "VR", "AI", "MC", "NG", "OK", "CM",
    "DM", "SNS", "YouTube", "Twitter", "X", "LINE", "FPS", "RTA", "MV", "EP", "vs",
}

#: この長さ以下のテロップには印を付けない（「へー!」「ダメ」。読めば分かるし、取りこぼしも安い）
MIN_LENGTH = 4

#: 日本語でも英字でも数字でも記号でもない文字（アラビア文字などの混入）
_FOREIGN = re.compile(
    rf"[^{_JA}A-Za-z0-9\s"
    r"。、！？!?…・「」『』（）\(\)\-ー~〜%％&＆@＠#＃\.,:：;；\"'’”\+＋=＝/／\*＊°]"
)


def _suspect_reasons(text: str, tagger: Any) -> list[str]:
    """怪しい手がかり。**確信度は見ない**（telop.py の needs_check が持っている）。

    🔴 印は少なく正確に。実素材（コラボ切り抜き5本・141枚）で測りながら決めた。
       落とした案:
       - 確信度が低い … 「へー!」0.26 のような短い感動詞に必ず付く。正しいのに印が出る
       - 1文字の漢字＋助詞 … 「他のみんな」「今から」「左を」。日本語で最も普通の形で、
         27% に印が付いた。感動詞が続くときだけに絞った（「母はい」）
    """
    reasons: list[str] = []
    if len(text) < MIN_LENGTH:
        return reasons

    if _FOREIGN.search(text):
        found = _FOREIGN.search(text).group(0)
        reasons.append(f"日本語にない文字「{found}」が混ざっている")

    """
    🔴 見逃してよいラテン語（EN / JP / VR など）は、混ざっていても印を付けないこと。
       「まさかJPが優勝するとは」は正しい。語そのものが怪しいときだけ見る。
    """
    latin_words = [m.group(0) for m in _LATIN.finditer(text)]
    odd = [w for w in latin_words if w not in _LATIN_OK and w.upper() not in _LATIN_OK]
    if odd:
        reasons.append(f"アルファベットの語「{odd[0]}」")
    elif not latin_words and _MIXED.search(text):
        # 1文字のラテン文字が日本語に食い込んでいる（「あaい」）
        reasons.append("日本語とアルファベットが1語に混ざっている")

    """
    🔴 1文字の漢字＋感動詞は、幻聴の典型。
       実素材で「はいはい」の連呼が「母はいはい!」になっていた。確信度は 0.77 あり、
       確信度では拾えない。品詞が取れるときだけ見る（nagisa は Qwen3-ASR と
       一緒に入っている。無い環境ではこの手がかりを使わない）。
    """
    if tagger is not None:
        try:
            tags = tagger.tagging(text)
            words, posts = tags.words, tags.postags
        except Exception:  # noqa: BLE001
            words, posts = [], []
        for i, (w, pos) in enumerate(zip(words, posts)):
            if len(w) == 1 and pos == "名詞" and re.fullmatch(r"[\u4e00-\u9fff]", w):
                if (posts[i + 1] if i + 1 < len(posts) else "") == "感動詞":
                    reasons.append(f"1文字の「{w}」が浮いている")
                    break
    return reasons


def normalize_names(text: str, names: Iterable[str], swaps: dict[str, str] | None = None) -> str:
    """利用者が書いた表で、確実な誤りだけを直す。

    names は「出てくる名前」の一覧。**表記が近いものを寄せるのではなく**、
    swaps（言い換え表）に書かれた通りの置き換えだけを行う。
    名前の一覧は、LLM に渡す手がかり（文脈）としても使う。

    🔴 似ている語を勝手に寄せないこと。「はるか」（人名）と「はるか昔」のように、
       同じ音でも直してはいけない所がある。表に書かれた対応だけ置き換える。
    """
    out = text
    for wrong, right in (swaps or {}).items():
        wrong = wrong.strip()
        if wrong and right.strip():
            out = out.replace(wrong, right.strip())
    return out


def parse_swaps(raw: str) -> dict[str, str]:
    """「オロライブ→ホロライブ」の形を1行1件で読む。全角の矢印・タブ・カンマも許す。"""
    swaps: dict[str, str] = {}
    for line in (raw or "").replace("\r", "\n").split("\n"):
        line = line.strip()
        if not line:
            continue
        for sep in ("→", "->", "=>", "\t", ",", "、"):
            if sep in line:
                wrong, right = line.split(sep, 1)
                if wrong.strip() and right.strip():
                    swaps[wrong.strip()] = right.strip()
                break
    return swaps


def parse_names(raw: str) -> list[str]:
    """「出てくる名前」を読む。読点・空白・改行のどれで区切ってもよい。"""
    parts = re.split(r"[、,\s]+", (raw or "").strip())
    return [p for p in (x.strip() for x in parts) if p]


def review(
    telops: list[dict[str, Any]],
    *,
    names: Iterable[str] = (),
    swaps: dict[str, str] | None = None,
    use_tagger: bool = True,
) -> dict[str, Any]:
    """テロップを読み直す。

    返すもの:
        fixed    … 言い換え表で直した件数（本文は破壊的に書き換える）
        suspects … [{id, reasons}] 怪しい所。本文は変えない
    """
    tagger = None
    if use_tagger:
        try:
            import nagisa

            tagger = nagisa
        except Exception:  # noqa: BLE001
            tagger = None

    swaps = swaps or {}
    fixed = 0
    suspects: list[dict[str, Any]] = []
    for t in telops:
        text = (t.get("text") or "").strip()
        if not text:
            continue
        if swaps:
            after = normalize_names(text, names, swaps)
            if after != text:
                t["text"] = after
                t["fixed_by_swap"] = True
                fixed += 1
                text = after
        reasons = _suspect_reasons(text, tagger)
        if reasons:
            # 🔴 既にある needs_check を消さないこと（確信度の判定もここに乗る）
            t["needs_check"] = True
            t["check_reasons"] = reasons
            suspects.append({"id": t.get("id"), "reasons": reasons})
    return {"fixed": fixed, "suspects": suspects}
