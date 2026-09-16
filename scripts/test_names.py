"""出演者名の後処理補正（sidecar/names.py）の検査。

🔴 守っていること:
   - 直せる: 実測の誤変換（ラミーちゃん / ふばるちゃん / こゆちゃん / ノロハちゃん / ペコレちゃん）、
     表記統一（カナタ→かなた）、漢字の聞き違い（彼方→かなた、天音彼方→天音かなた、猫股おかゆ→猫又おかゆ、mis_kanji）。
   - 触らない: 一般語（おかん召喚 / 素晴らしい / あなたのルール / 顔かゆい）、
     出演者リストに無い人（オリーちゃん / デカヌちゃん）、「ちゃんと」、敬称食い（かなさん）、
     助詞食い（ラミの）。
   - 敬称込みの alias（すいちゃん / フブちゃん / シオちゃま）で別人化しない（ルイちゃん / ふみちゃん / しろちゃま）。
   - strict（dict の strict / str 形式の末尾「!」）の alias は表記統一だけ（ルイちゃん 不変、スイちゃん→すいちゃん）。
     strict でない 2 モーラ alias（こよ）は距離 1 のまま（こゆちゃん→こよちゃん）。
   - 保護区間は「人」で見る: 同じ人の短い alias（フブ / ぺこ）が長い alias（フブキ / ぺこら）への距離 1 補正を潰さない。
     同じ人の両表記（こぼ / コボ）で振動しない。
   - mis_kanji: 姓の二重化は alias の有無に依らず防ぐ（猫又お粥→猫又おかゆ、天音彼方→天音かなた）。
     名の部分だけの mis_kanji（吹雪・彼方）も無条件で直す（敬称・姓の条件は実素材で正しい補正だけを失った）。
     漢字を含まない / 他の人の alias と同じ mis_kanji は warnings（後者は置換しない）。
   - MAX_ROUNDS で収束しなかったセグメントは warnings に入る。
   - 冪等（2 回目は count 0。表記統一で語境界が生まれる 'カナタロイちゃん' も 1 回で収束）、
     words と text の整合（前後の空白は無視、一致しなければ text も触らない）、
     str 形式の cast、空の cast で無変化、不正な cast（str そのまま / None / 数値）は ValueError。
   - V3 の既知の限界（距離 1 の相手・3 モーラ＋敬称の一般語）は現状の出力を期待値として固定。
     挙動が変わったら気づくための検査で、「正しい」という意味ではない。

実行: python scripts/test_names.py
"""

from __future__ import annotations

import copy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _console import enable_utf8  # noqa: E402

from sidecar.names import fix_text, fix_transcript, parse_cast  # noqa: E402

failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failed
    if not ok:
        failed += 1
    print(f"[names] {'OK  ' if ok else 'NG  '} {name}")
    if detail:
        print(f"        {detail}")


CAST = parse_cast([
    {"name": "白上フブキ", "aliases": ["フブキ"]},
    {"name": "猫又おかゆ", "aliases": ["おかゆ", "おかゆん"], "mis_kanji": ["お粥", "猫股おかゆ"]},
    {"name": "天音かなた", "aliases": ["かなた", "かなたん"], "mis_kanji": ["彼方"]},
    {"name": "雪花ラミィ", "aliases": ["ラミィ"]},
    {"name": "大空スバル", "aliases": ["スバル"], "mis_kanji": ["大沢すばる"]},
    {"name": "博衣こより", "aliases": ["こより", "こよ"]},
    {"name": "風真いろは", "aliases": ["いろは"]},
    {"name": "兎田ぺこら", "aliases": ["ぺこら", "ぺこ"]},
    {"name": "湊あくあ", "aliases": ["あくあ"]},
])


def case(text: str, want: str, rule: str | None = None, cast=None, label: str | None = None) -> None:
    got, fixes = fix_text(text, CAST if cast is None else cast)
    ok = got == want
    if ok and rule is not None:
        ok = any(f.rule == rule for f in fixes)
    label = label or ("直す" if text != want else "触らない")
    check(f"{label}: {text!r} → {got!r}", ok, "" if ok else f"期待 {want!r} / fixes={fixes}")


def seg(start: float, text: str, words: list[str] | None = None) -> dict:
    """words を与えなければ 1 文字 1 語で組む（実データの形）。"""
    chars = words if words is not None else list(text)
    step = 0.2
    return {
        "id": int(start * 10),
        "src_start": start,
        "src_end": start + step * len(chars),
        "text": text,
        "words": [
            {"src_start": round(start + i * step, 3), "src_end": round(start + (i + 1) * step, 3),
             "text": c, "probability": 0.9}
            for i, c in enumerate(chars)
        ],
    }


def joined(s: dict) -> str:
    return "".join(w["text"] for w in s["words"])


def main() -> int:
    enable_utf8()

    # ── 直せる（実測の誤変換から）──
    case("ラミーちゃん", "ラミィちゃん", "kana")
    case("ふばるちゃんが好きそうなステージだね", "スバルちゃんが好きそうなステージだね", "fix")
    case("こゆちゃんが取れちゃうよ", "こよちゃんが取れちゃうよ", "fix")
    case("ノロハちゃんナス好きだからナスあげよう", "いろはちゃんナス好きだからナスあげよう", "fix")
    case("ペコレちゃんいいのね", "ぺこらちゃんいいのね", "fix")
    case("でもラミーとカナタはきっと下手くそだから", "でもラミィとかなたはきっと下手くそだから", "kana")
    case("アクアの番", "あくあの番", "kana")

    # ── mis_kanji ──
    # 名の部分だけの mis_kanji（彼方・お粥）は name 末尾の alias（かなた・おかゆ）に。姓が付いていれば姓ごと name に。
    # 🔴 名の部分だけの mis_kanji にも敬称・姓の条件は付けない。一度付けたが、実素材で正しい補正 6 件
    #    （「お粥が一番暫定1位」「この彼方も相手も」）を失い、防げた誤爆は 0 件だった（2026-09-16 最終確認）。
    #    一般語と紛れる表記（天候の 吹雪 など）は辞書側で mis_kanji に書かない運用で受ける。
    case("彼方さんが言ってた", "かなたさんが言ってた", "mis_kanji")
    case("彼方が言ってた", "かなたが言ってた", "mis_kanji")  # 敬称も姓も無くても直す
    case("彼方たんが", "かなたたんが", "mis_kanji")
    case("天音彼方", "天音かなた", "mis_kanji")  # 天音天音かなた にしない
    case("天音彼方さんと彼方さん", "天音かなたさんとかなたさん", "mis_kanji")
    case("お粥ちゃん", "おかゆちゃん", "mis_kanji")
    # フルネーム型の mis_kanji（読みが alias で終わる）は name に。正解表記 おかゆ を丸ごと含んでいても跨いでよい。敬称は要らない
    case("猫股おかゆ", "猫又おかゆ", "mis_kanji")
    case("大沢すばるが来た", "大空スバルが来た", "mis_kanji")
    # 姓の二重化は alias に依存しない（aliases 無し / name の末尾でない alias だけ）
    case("猫又お粥ちゃん", "猫又おかゆちゃん", "mis_kanji",
         cast=parse_cast([{"name": "猫又おかゆ", "mis_kanji": ["お粥"]}]), label="姓の二重化（aliases 無し）")
    case("天音彼方", "天音かなた", "mis_kanji",
         cast=parse_cast([{"name": "天音かなた", "aliases": ["かなたん"], "mis_kanji": ["彼方"]}]), label="姓の二重化（末尾でない alias）")
    # alias 無しの entry の mis_kanji は無条件で name に（読みが分からないので型を判定できない）
    case("お粥が来た", "猫又おかゆが来た", "mis_kanji",
         cast=parse_cast([{"name": "猫又おかゆ", "mis_kanji": ["お粥"]}]), label="alias 無しは無条件")
    # 名の部分だけの mis_kanji も無条件。天候の 吹雪 まで フブキ になるのは、辞書に 吹雪 を書いた側の判断
    fubu_mk = parse_cast([{"name": "白上フブキ", "aliases": ["フブキ"], "mis_kanji": ["吹雪"]}])
    case("吹雪の中", "フブキの中", "mis_kanji", cast=fubu_mk, label="一般語の mis_kanji（敬称無しでも直す）")
    case("吹雪先輩", "フブキ先輩", "mis_kanji", cast=fubu_mk, label="一般語の mis_kanji（敬称あり）")
    case("白上吹雪", "白上フブキ", "mis_kanji", cast=fubu_mk, label="一般語の mis_kanji（姓あり）")
    # 他の人の alias と同じ mis_kanji は置換しない（正解表記の保護を mis_kanji で上書きさせない）
    case("かなた", "かなた",
         cast=parse_cast([{"name": "天音かなた", "aliases": ["かなた"]}, {"name": "金田一", "mis_kanji": ["かなた"]}]),
         label="他の人の alias と同じ mis_kanji")
    r = fix_transcript({"segments": [seg(1.0, "かなた")]},
                       [{"name": "天音かなた", "aliases": ["かなた"]}, {"name": "金田一", "mis_kanji": ["かなた"]}])
    check("他の人の alias と同じ mis_kanji は warnings（置換 0）",
          r["count"] == 0 and any("金田一" in w and "かなた" in w for w in r["warnings"]), str(r["warnings"]))
    r = fix_transcript({"segments": [seg(1.0, "ラミーちゃん")]},
                       [{"name": "雪花ラミィ", "aliases": ["ラミィ"], "mis_kanji": ["ラミー"]}])
    check("漢字を含まない mis_kanji は warnings", any("漢字が無い" in w for w in r["warnings"]), str(r["warnings"]))

    # 漢字の聞き違いは mis_kanji が無いと届かない（読み辞書が無い）。V3 の規則では触らないのが正しい
    case("青くゆんが来た", "青くゆんが来た")

    # ── 触らない（誤爆の型）──
    case("おかん召喚しかないなこれ", "おかん召喚しかないなこれ")  # 一般語。4 モーラでも音が落ちた形は不可
    case("素晴らしい!", "素晴らしい!")  # 漢字直後の送り仮名を語頭に見ない
    case("あなたのルールを追加していいんだよ", "あなたのルールを追加していいんだよ")  # 3 モーラは敬称必須
    case("オリーちゃんが作ってくれた部屋に", "オリーちゃんが作ってくれた部屋に")  # 出演者に無い人（距離 2）
    case("デカヌちゃんを守りましょう", "デカヌちゃんを守りましょう")  # 出演者に無い（距離 2）
    case("これちゃんとやって", "これちゃんとやって")  # 「ちゃんと」は敬称にしない
    case("3位はかなさんかな", "3位はかなさんかな")  # 候補が敬称を食わない
    case("全く顔かゆいを知らない人", "全く顔かゆいを知らない人")  # おかゆ を含むが敬称無し
    case("ラミの匂いがする", "ラミの匂いがする")  # 助詞食い
    case("いやーめちゃめちゃ面白かった!", "いやーめちゃめちゃ面白かった!")  # かった→かなた を弱い文脈で通さない
    case("シオンちゃん", "シオンちゃん")  # 出演者に無い名前は触らない

    # ── 敬称込みの alias（casts.yaml / UI で「フブちゃん」と書かれる形）で別人化しない ──
    # 🔴 敬称込みのまま 5 モーラの語として評価すると「3 モーラ以下は敬称必須」を素通りして
    #    ルイちゃん→すいちゃん になる。語幹（すい）を照合に、敬称込みは保護にだけ使う。
    #    2 モーラの語幹は距離 0（表記統一）だけ。
    sui = parse_cast(["星街すいせい すいせい すいちゃん"])
    case("ルイちゃんがさ", "ルイちゃんがさ", cast=sui, label="別人化しない")
    case("るいちゃん", "るいちゃん", cast=sui, label="別人化しない")
    case("すーちゃん", "すーちゃん", cast=sui, label="別人化しない")
    case("スイちゃん", "すいちゃん", "kana", cast=sui, label="語幹の表記統一")
    case("すいせいちゃん", "すいせいちゃん", cast=sui)
    fubu = parse_cast(["白上フブキ フブキ フブちゃん"])
    case("ふみちゃん", "ふみちゃん", cast=fubu, label="別人化しない")
    case("ふうちゃん", "ふうちゃん", cast=fubu, label="別人化しない")
    case("ふぶちゃん", "フブちゃん", "kana", cast=fubu, label="語幹の表記統一")
    shion = parse_cast(["紫咲シオン シオン シオちゃま"])
    case("しろちゃま", "しろちゃま", cast=shion, label="別人化しない")
    case("しおちゃま", "シオちゃま", "kana", cast=shion, label="語幹の表記統一")

    # ── strict（愛称ごとに人が決める）: str 形式の末尾「!」/ dict の strict は距離 0（表記統一）だけ ──
    # 🔴 敬称無しの 2 モーラ alias は既定で距離 1 を許す（こゆ→こよ ×9 など正しい補正の 22/28 を支える）。
    #    1 音違いに一般語や他の人が居る すい / フブ / シオ / ころ だけ strict にする（casts.yaml）
    sui_s = parse_cast(["星街すいせい すいせい すい!"])
    check("str 形式の末尾「!」は strict（aliases にも入る）",
          sui_s[0].strict == ["すい"] and sui_s[0].aliases == ["星街すいせい", "すいせい", "すい"], str(sui_s))
    case("ルイちゃんがさ", "ルイちゃんがさ", cast=sui_s, label="strict: 別人化しない")
    case("スイちゃん", "すいちゃん", "kana", cast=sui_s, label="strict: 表記統一は効く")
    sui_no = parse_cast(["星街すいせい すいせい すい"])
    case("ルイちゃんがさ", "すいちゃんがさ", "fix", cast=sui_no, label="strict でなければ距離 1（既定）")
    fubu_s = parse_cast([{"name": "白上フブキ", "aliases": ["フブキ"], "strict": ["フブ"]}])
    check("dict の strict は aliases に自動で入る", fubu_s[0].aliases == ["白上フブキ", "フブキ", "フブ"] and fubu_s[0].strict == ["フブ"], str(fubu_s))
    case("ふみちゃん", "ふみちゃん", cast=fubu_s, label="strict: 別人化しない")
    case("フブヒちゃん", "フブキちゃん", "fix", cast=fubu_s, label="strict の短い alias が長い alias の補正を潰さない")
    case("こゆちゃんが取れちゃうよ", "こよちゃんが取れちゃうよ", "fix", label="strict でない こよ は距離 1 のまま")
    # 敬称込み形（シオちゃま）と strict 形（シオ!）は同じ挙動
    for c in (parse_cast(["紫咲シオン シオン シオちゃま"]), parse_cast(["紫咲シオン シオン シオ!"])):
        case("しろちゃま", "しろちゃま", cast=c, label="別人化しない（敬称込み形 / strict 形）")
        case("しおちゃま", "シオちゃま", "kana", cast=c, label="語幹の表記統一（敬称込み形 / strict 形）")
    korone = parse_cast(["戌神ころね ころね ころ!"])
    case("ごろさん", "ごろさん", cast=korone, label="strict: 別人化しない")

    # ── 保護区間は「人」で見る: 同じ人の短い alias が長い alias への距離 1 補正を潰さない ──
    case("フブヒちゃん", "フブキちゃん", "fix", cast=parse_cast(["白上フブキ フブキ フブ"]), label="保護区間（同じ人は跨げる）")
    case("ぺこれちゃん", "ぺこらちゃん", "fix", label="保護区間（同じ人は跨げる）")  # CAST に [ぺこら, ぺこ]
    case("シオソちゃん", "シオンちゃん", "fix", cast=parse_cast(["紫咲シオン シオン シオ"]), label="保護区間（同じ人は跨げる）")
    # 同じ人の両表記（こぼ / コボ）が alias にあっても、表記統一で振動しない
    both = parse_cast(["こぼ・かなえる こぼ コボ"])
    case("コボちゃんが来た", "コボちゃんが来た", cast=both, label="両表記 alias で振動しない")
    case("こぼちゃんが来た", "こぼちゃんが来た", cast=both, label="両表記 alias で振動しない")
    lap = parse_cast(["ラプラス・ダークネス ラプラス ラプちゃん"])
    case("カプちゃん", "カプちゃん", cast=lap, label="別人化しない")
    case("らっちゃん", "らっちゃん", cast=lap, label="別人化しない")
    # 3 モーラの語幹（ラミィちゃん→ラミィ）は敬称無しの alias と同じ規則で直る
    lam = parse_cast(["雪花ラミィ ラミィちゃん"])
    case("ラミーちゃん", "ラミィちゃん", "kana", cast=lam, label="3 モーラ語幹")
    # 愛称の接尾（たん）は敬称ではないので剥がさない
    kan = parse_cast(["天音かなた かなたん"])
    case("かなたんが", "かなたんが", cast=kan)
    case("かなだんが", "かなたんが", "fix", cast=kan)

    # ── V3 の既知の限界（直せない / 誤爆する）。現状の出力を固定。挙動が変わったら気づくため ──
    # 距離 1 の相手（コボ→こよ、かなえ→かなた、あくま→あくあ）は規則では防げない。その人を cast に入れるしか無い
    case("コボちゃんが来た", "こよちゃんが来た", label="既知の限界（別人化）")
    case("かなえさんも来た", "かなたさんも来た", label="既知の限界（別人化）")
    case("あくまちゃんかわいい", "あくあちゃんかわいい", label="既知の限界（別人化）")
    # 3 モーラ＋敬称の一般語（あなた様）は敬称文脈で通ってしまう
    case("あなた様に感謝", "かなた様に感謝", label="既知の限界（一般語）")
    # cast にその人が居れば保護されて直らない（対処法の確認）
    with_kobo = parse_cast(["博衣こより こより こよ", "こぼ・かなえる こぼ コボ"])
    case("コボちゃんが来た", "コボちゃんが来た", cast=with_kobo, label="対処: cast に入れれば守れる")

    # ── 出演者リストに無い名前は触らない（別の cast で）──
    other = parse_cast(["紫咲シオン シオン"])
    got, fixes = fix_text("ふばるちゃんが好きそう", other)
    check("リストに無い名前（スバル）は触らない", got == "ふばるちゃんが好きそう" and not fixes, got)

    # ── str 形式の cast ──
    str_cast = parse_cast(["天音かなた かなた かなたん", "雪花ラミィ ラミィ"])
    check("str 形式: 先頭が name、残りが aliases、name も aliases に入る",
          str_cast[0].name == "天音かなた" and str_cast[0].aliases == ["天音かなた", "かなた", "かなたん"],
          str(str_cast))
    got, _ = fix_text("ラミーちゃんとカナタ", str_cast)
    check("str 形式の cast で直る", got == "ラミィちゃんとかなた", got)

    # ── 不正な cast は ValueError（ASR の前に落とすため黙って受けない）──
    for bad, why in (("天音かなた かなた", "str をそのまま"), ([None], "None の要素"), ([1], "数値の要素"),
                     ([{"name": "x", "aliases": 5}], "aliases が数値")):
        try:
            parse_cast(bad)  # type: ignore[arg-type]
            check(f"不正な cast（{why}）は ValueError", False, "例外が出なかった")
        except ValueError:
            check(f"不正な cast（{why}）は ValueError", True)
    try:
        fix_transcript({"segments": []}, "天音かなた かなた")  # type: ignore[arg-type]
        check("fix_transcript に str の cast は ValueError", False)
    except ValueError:
        check("fix_transcript に str の cast は ValueError", True)
    wrapped = parse_cast([{"name": "x", "aliases": "かなた", "mis_kanji": "彼方"}])
    check("dict の aliases / mis_kanji が str なら [str] に包む",
          wrapped[0].aliases == ["x", "かなた"] and wrapped[0].mis_kanji == ["彼方"], str(wrapped))

    # ── 別人物が同じ alias を持つと warning（同区間の候補は置換しない）──
    r = fix_transcript({"segments": [seg(1.0, "ミコちゃん")]}, ["さくらみこ みこ", "みこち みこ"])
    check("同じ alias が 2 人にあれば warnings に入る", len(r["warnings"]) == 1 and "みこ" in r["warnings"][0], str(r["warnings"]))

    # ── 空の cast で無変化 ──
    t = {"segments": [seg(1.0, "ラミーちゃん")]}
    before = copy.deepcopy(t)
    r = fix_transcript(t, parse_cast([]))
    check("空の cast: count 0 で無変化", r["count"] == 0 and t == before, str(r))
    r = fix_transcript(copy.deepcopy(before), None)
    check("cast=None: count 0", r["count"] == 0, str(r))

    # ── transcript: words と text の整合、冪等 ──
    t = {"segments": [
        seg(10.0, "ラミーちゃんとカナタ"),  # 同じ長さの置換 ×2
        seg(20.0, "ふばるちゃんの座右の銘だもんね", ["ふ", "ば", "る", "ちゃん", "の", "座", "右", "の", "銘", "だ", "もん", "ね"]),
        seg(30.0, "彼方さんが言ってた"),  # 2 文字 → 3 文字（伸びる）。名の部分だけの mis_kanji は敬称が要る
        seg(40.0, "そうだね確かに 全く顔かゆいを知らない人からすれば"),  # 触らない
    ]}
    # 先頭に空白が付く実データの形（連結の先頭だけ空白）
    t["segments"].append(seg(50.0, "ラミーちゃん", [" ラ", "ミ", "ー", "ちゃん"]))
    t["segments"][-1]["text"] = "ラミーちゃん"
    # words と text が一致しない形（text も触らない）
    bad = seg(60.0, "ラミーちゃん", ["ラミ", "ちゃん"])
    t["segments"].append(bad)
    # 末尾に空白が付く形（faster_whisper の word は生。前後の空白を無視して一致を見る）
    t["segments"].append(seg(70.0, "おかいゆん", ["おか", "いゆ", "ん "]))
    t["segments"][-1]["text"] = "おかいゆん"
    # words が無いセグメント（text だけ直す。skipped_mismatch に数えない）
    t["segments"].append({"id": 800, "src_start": 80.0, "src_end": 81.0, "text": "ラミーちゃん", "words": []})

    orig_words = [copy.deepcopy(s["words"]) for s in t["segments"]]
    r = fix_transcript(t, CAST)
    segs = t["segments"]

    check("count は置換した語の数（ラミー, カナタ, ふばる, 彼方, ラミー(空白付き), おかいゆん, ラミー(words 無し)）",
          r["count"] == 7, str(r["count"]))
    check("fixes の time/before/after/rule/segment_text が入り、before/after は語単位",
          all({"time", "before", "after", "rule", "segment_text"} <= set(f) for f in r["fixes"])
          and r["fixes"][0] == {"time": 10.0, "before": "ラミー", "after": "ラミィ", "rule": "kana", "segment_text": "ラミーちゃんとカナタ"},
          str(r["fixes"][:1]))
    check("fixes の time は該当 word の src_start（カナタ は 8 文字目 = 10.0 + 0.2*7）",
          abs(r["fixes"][1]["time"] - 11.4) < 1e-6 and r["fixes"][1]["before"] == "カナタ", str(r["fixes"][1]))
    check("text が直る", segs[0]["text"] == "ラミィちゃんとかなた" and segs[1]["text"] == "スバルちゃんの座右の銘だもんね"
          and segs[2]["text"] == "かなたさんが言ってた", str([s["text"] for s in segs[:3]]))
    for k in (0, 1, 2, 3):
        check(f"words の連結 == text（seg {k}）", joined(segs[k]) == segs[k]["text"], f"{joined(segs[k])!r} vs {segs[k]['text']!r}")
    check("同じ長さの置換は word 数も時刻も変わらない",
          len(segs[0]["words"]) == len(orig_words[0])
          and [(w["src_start"], w["src_end"]) for w in segs[0]["words"]] == [(w["src_start"], w["src_end"]) for w in orig_words[0]],
          str(segs[0]["words"]))
    check("複数文字の word（ちゃん/もん）はそのまま", [w["text"] for w in segs[1]["words"]][3:] == ["ちゃん", "の", "座", "右", "の", "銘", "だ", "もん", "ね"],
          str([w["text"] for w in segs[1]["words"]]))
    w2 = segs[2]["words"]
    check("伸びる置換でも word 数は変わらず、時刻の並びは単調",
          len(w2) == len(orig_words[2]) and all(w2[i]["src_end"] <= w2[i + 1]["src_start"] + 1e-9 for i in range(len(w2) - 1)),
          str(w2))
    check("触らない segment の words は変わらない", segs[3]["words"] == orig_words[3])
    check("連結の先頭にだけ空白がある形も直る", segs[4]["text"] == "ラミィちゃん" and joined(segs[4]) == " ラミィちゃん",
          f"{segs[4]['text']!r} / {joined(segs[4])!r}")
    check("words と text が一致しない segment は text も words も触らず skipped_mismatch に数える",
          segs[5]["text"] == "ラミーちゃん" and segs[5]["words"] == orig_words[5] and r["skipped_mismatch"] == 1,
          f"{segs[5]} / skipped_mismatch={r['skipped_mismatch']}")
    check("連結の末尾に空白がある形も words まで直る", segs[6]["text"] == "おかゆん" and joined(segs[6]) == "おかゆん ",
          f"{segs[6]['text']!r} / {joined(segs[6])!r}")
    check("words が無い segment は text だけ直り、skipped_mismatch に数えない",
          segs[7]["text"] == "ラミィちゃん" and segs[7]["words"] == [], str(segs[7]))

    # 冪等
    snapshot = copy.deepcopy(t)
    r2 = fix_transcript(t, CAST)
    check("冪等: 2 回目は count 0", r2["count"] == 0, str(r2))
    check("冪等: 2 回目で transcript が変わらない", t == snapshot)

    # 表記統一で文字種が変わり語境界が生まれる形も 1 回で収束する
    chain = parse_cast(["天音かなた かなた", "鷹嶺ルイ ルイ", "湊あくあ あくあ", "兎田ぺこら ぺこら ぺこ"])
    for text, want in (("カナタロイちゃん", "かなたルイちゃん"), ("アクアペコちゃん", "あくあぺこちゃん")):
        got, fixes = fix_text(text, chain)
        got2, fixes2 = fix_text(got, chain)
        check(f"収束: {text!r} → {got!r}（2 回目 0 件）", got == want and got2 == got and not fixes2,
              f"{got!r} / round={[f.round for f in fixes]} / second={fixes2}")
        tt = {"segments": [seg(1.0, text)]}
        r1 = fix_transcript(tt, chain)
        rr = fix_transcript(tt, chain)
        check(f"収束（transcript）: {text!r} words == text、2 回目 0 件",
              tt["segments"][0]["text"] == want and joined(tt["segments"][0]) == want and r1["count"] == 2 and rr["count"] == 0,
              f"{tt['segments'][0]['text']!r} / {joined(tt['segments'][0])!r} / {r1['count']} / {rr['count']}")

    # MAX_ROUNDS で収束しなかったら warnings（上限を 1 にして人工的に当てる）
    w: list[str] = []
    got, fixes = fix_text("カナタロイちゃん", chain, max_rounds=1, warnings=w)
    check("fix_text: max_rounds で収束しなければ warnings", got == "かなたロイちゃん" and len(w) == 1 and "収束しなかった" in w[0], str(w))
    w = []
    fix_text("カナタロイちゃん", chain, warnings=w)
    check("fix_text: 収束すれば warnings 無し", w == [], str(w))
    import sidecar.names as names_mod

    saved = names_mod.MAX_ROUNDS
    names_mod.MAX_ROUNDS = 1
    try:
        rr = fix_transcript({"segments": [seg(1.0, "カナタロイちゃん")]}, chain)
    finally:
        names_mod.MAX_ROUNDS = saved
    check("fix_transcript: MAX_ROUNDS で収束しなければ warnings に「セグメント N」",
          rr["count"] == 1 and len(rr["warnings"]) == 1 and rr["warnings"][0].startswith("セグメント 0"), str(rr["warnings"]))

    # 縮む置換（空になった word は時間を隣に足して取り除く）
    shrink = parse_cast([{"name": "ぺこら", "mis_kanji": ["ペコラちゃんさん"]}])
    t = {"segments": [seg(70.0, "あのペコラちゃんさんが来た")]}
    fix_transcript(t, shrink)
    s = t["segments"][0]
    ends_ok = all(s["words"][i]["src_end"] <= s["words"][i + 1]["src_start"] + 1e-9 for i in range(len(s["words"]) - 1))
    check("縮む置換: 連結 == text、空 word 無し、時刻は単調で全体の幅を保つ",
          joined(s) == s["text"] == "あのぺこらが来た" and all(w["text"] for w in s["words"]) and ends_ok
          and abs(s["words"][-1]["src_end"] - (70.0 + 0.2 * 13)) < 1e-6,
          str(s["words"]))

    # ── 実データ（あれば）: words と text が一致し続け、2 回目は 0 ──
    # 🔴 count > 0 は要求しない。compose が一度走ると transcript.json は補正済みになり 0 件で正しい
    real = Path(r"D:\Claude\clip-factory\work\Ok4bk-09gQg\transcript.json")
    if real.exists():
        import json

        tr = json.loads(real.read_text(encoding="utf-8"))
        cast = parse_cast(["白上フブキ フブキ", "猫又おかゆ おかゆ おかゆん", "天音かなた かなた かなたん", "雪花ラミィ ラミィ"])
        r1 = fix_transcript(tr, cast)
        mism = sum(1 for s in tr["segments"] if s.get("words") and joined(s).strip() != s["text"])
        empty = sum(1 for s in tr["segments"] for w in s.get("words", []) if w["text"] == "")
        r2 = fix_transcript(tr, cast)
        check(f"実データ Ok4bk: {r1['count']} 件直して words と text は全 segment で一致、空 word 0、2 回目は 0",
              mism == 0 and empty == 0 and r2["count"] == 0,
              f"count={r1['count']} mismatch={mism} empty={empty} second={r2['count']} skipped={r1['skipped_mismatch']}")
    else:
        print("[names] --   実データ（D:\\Claude\\clip-factory\\work）が無いので飛ばす")

    print()
    print("test-names: 全て通りました" if failed == 0 else f"test-names: {failed} 件失敗")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
