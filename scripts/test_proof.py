"""文字起こしの見直し（sidecar/proof.py）の検査。

🔴 守っていること:
   - 黙って書き換えるのは、利用者が書いた言い換え表の通りの置換だけ
     （テロップは発言の引用。こちらの判断で言い回しを変えない）
   - 印は少なく正確に。実素材（VTuber のコラボ切り抜き5本・141枚）で測りながら
     規則を決めた。落とした案と理由は proof.py の注意書きに残してある
   - 短いテロップ（3文字以下）には印を付けない。「へー!」「ダメ」は
     確信度が低く出るが、読めば分かるし直す手間も安い

実行: python scripts/test_proof.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _console import enable_utf8  # noqa: E402

from sidecar.proof import parse_names, parse_swaps, review  # noqa: E402

failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failed
    if not ok:
        failed += 1
    print(f"[proof] {'OK  ' if ok else 'NG  '} {name}")
    if detail:
        print(f"        {detail}")


def telop(text: str, **extra):
    return {"id": f"t{abs(hash(text)) % 1000:03d}", "text": text, **extra}


def main() -> int:
    enable_utf8()

    # ── 言い換え表の読み取り ──
    swaps = parse_swaps("オロライブ→ホロライブ\n かなた, 天音かなた \nあ→")
    check("矢印でも読点でも読める", swaps == {"オロライブ": "ホロライブ", "かなた": "天音かなた"}, str(swaps))
    check("右側が空なら無視する", "あ" not in swaps)
    check("名前は読点・空白・改行で区切れる",
          parse_names("ホロライブ、フブキ おかゆ\nラミィ") == ["ホロライブ", "フブキ", "おかゆ", "ラミィ"])

    # ── 言い換えは書き換える ──
    telops = [telop("ではオロライブポケモンユナイト世界対抗戦は")]
    out = review(telops, swaps={"オロライブ": "ホロライブ"}, use_tagger=False)
    check("言い換え表の通りに直す", telops[0]["text"].startswith("ではホロライブ"), telops[0]["text"])
    check("直した件数を返す", out["fixed"] == 1, str(out["fixed"]))
    check("直した印が付く", telops[0].get("fixed_by_swap") is True)

    # 冪等（2回当てても増えない）
    again = review(telops, swaps={"オロライブ": "ホロライブ"}, use_tagger=False)
    check("2回当てても変わらない", again["fixed"] == 0)

    # ── 印（本文は変えない） ──
    cases_flag = [
        ("アルファベットの語", "え みないいのahu"),
        ("日本語にない文字", "みんなائーこの辺いくねぇ"),
        ("浮いたローマ字", "自信力だね本当に嬉しいSVPおめでとう"),
    ]
    for label, text in cases_flag:
        t = [telop(text)]
        r = review(t, use_tagger=False)
        check(f"{label}に印が付く", len(r["suspects"]) == 1, text)
        check(f"{label}でも本文は変えない", t[0]["text"] == text)

    cases_quiet = [
        ("よく出る略語（JP）", "まさかJPが優勝するとは"),
        ("よく出る略語（EN/ID）", "ホロライブENホロライブIDの3地域で"),
        ("ふつうの日本語", "他のみんなはマリオパーティーやったことある?"),
        ("1文字の漢字＋助詞", "今からまばたきしないからね"),
        ("短い感動詞", "へー!"),
        ("短い語", "ダメ"),
    ]
    for label, text in cases_quiet:
        r = review([telop(text)], use_tagger=False)
        check(f"{label}には印を付けない", not r["suspects"], f"{text} → {r['suspects']}")

    # ── 品詞が取れるときだけの手がかり ──
    try:
        import nagisa  # noqa: F401

        has_tagger = True
    except ImportError:
        has_tagger = False

    if has_tagger:
        """
        🔴 1文字の漢字＋感動詞だけに絞ってある。
           実素材では「はいはい」の連呼が「母あ分からん!」「母え」になっていた。
           同じ幻聴でも「母はいはい!」は 母／は（助詞）と切れるので、ここでは拾えない。
           「母は…」は日本語として普通の形なので、規則では直せない
           （前後の会話を読む LLM の仕事。proof_llm.py）。
        """
        r = review([telop("母あ分からん!")], use_tagger=True)
        check("1文字の漢字＋感動詞（幻聴の典型）に印が付く", len(r["suspects"]) == 1,
              str(r["suspects"]))
        r = review([telop("母はいはいはい!")], use_tagger=True)
        check("「母は…」は規則では拾えない（LLM に回す）", not r["suspects"], str(r["suspects"]))
        # 🔴 1文字＋助詞は日本語で最も普通の形。ここに印を付けてはいけない
        for text in ("他のみんなはどう?", "今からいくよ", "左をやってくれ!", "お尻だけが来るんだ!"):
            r = review([telop(text)], use_tagger=True)
            check(f"「{text[:6]}…」には印を付けない", not r["suspects"], str(r["suspects"]))
    else:
        print("[proof] --  nagisa が無いので品詞の手がかりは試験しない")

    # ── 既にある印を消さない ──
    t = [telop("え", needs_check=True)]
    review(t, use_tagger=False)
    check("確信度で付いた印を消さない", t[0]["needs_check"] is True)

    print()
    print("test-proof: OK" if failed == 0 else f"test-proof: {failed} 件失敗")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
