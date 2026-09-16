"""出演者名の後処理補正。Whisper が聞き違えた出演者の名前を、出演者リストで直す。

なぜ後処理か
    上流（Whisper の hotwords / initial_prompt）に出演者名を入れる案は不採用。
    hotwords は温度フォールバックが暴走し、実測で直ったのは 2 件だけなのに
    「あくあく」×56 のような繰り返しが新たに出た（2026-09-16 hotword_experiment）。
    文字起こしが終わった transcript.json に対して、出演者リストを手掛かりに
    決定的な規則で直すほうが、壊れ方が読めて元にも戻せる。

やり方
    1. text を 1 文字→1 文字で正規化（カタカナ→ひらがな、小書き母音 ィ→イ、
       長音 ー→直前の母音）。位置対応を保つので、置換位置がそのまま使える
    2. かな連（ひらがな・カタカナ・ー の連続）の部分文字列を、各 alias の読みと
       Levenshtein で照合する
    3. 候補を 距離小 → 長い → 左 の順で貪欲に採用（重なり禁止）
    4. 候補が無くなるまで繰り返す（上限 MAX_ROUNDS=3 回）。表記統一で文字種が変わると
       隣に語境界が生まれ、2 回目に別の置換が起きることがあるため
       （'カナタロイちゃん'→'かなたロイちゃん'→'かなたルイちゃん'）。1 回の呼び出しで収束させる

🔴 規則を緩めてはいけない。4 配信 9,456 行・誤変換 145 箇所で測った数字（name_fix_result.md）:
    - 距離は 1 まで。2 を許すと 5 件直して 21 件壊す。壊れ方が最悪で、
      対戦相手（オリー→おかゆ、コボ→ぺこら、カリ→おかゆ）を出演者に書き換える
    - 3 モーラ以下の alias は直後に敬称が必須。モーラ規則を外すと誤爆 6 → 548
      （こよ/ルイ/ぺこ/おかゆ/かなた が日本語の普通の語に当たる）
    - 「文頭・!?・直前の あ/え」のような弱い呼びかけ文脈は信用しない。
      V2 で 90 件誤爆（素晴らしい→素晴ラミィ、面白かった→面白かなた、あなた→かなた）
    - 語境界を外すと誤爆 6 → 26（スリオちゃま→シオ、けっこちゃん→ぺこ）
    - 敬称文脈を外すと誤爆 6 → 33
    V3（この実装）は 65/145 を直して実質の誤爆 2 件（「おかん」→おかゆん、疑い）。
    別人化は 4 配信の実測では 0 件。ただし距離 1 の相手（コボ→こよ、かなえ→かなた、
    あくま→あくあ）は規則では防げない。その人を cast に入れる（正解表記になり保護される）
    しか手が無い。既知の限界は scripts/test_names.py の「V3 の既知の限界」に
    現状の出力を期待値として固定してある（挙動が変わったら気づける）。

敬称込みの alias
    「フブちゃん」「すいちゃん」のように敬称まで書かれた alias は、そのまま読みにすると
    5 モーラの語として評価され「3 モーラ以下は敬称必須」を素通りする
    （ルイちゃん→すいちゃん、ふみちゃん→フブちゃん、しろちゃま→シオちゃま の別人化）。
    _build_targets で末尾の敬称を剥がし、語幹（フブ/すい/シオ）を曖昧照合に、
    敬称込みの表記は距離 0 の保護にだけ使う。愛称の接尾（たん・ち・姉）は敬称ではないので剥がさない。
    剥がした語幹が 2 モーラ以下なら距離 0（表記統一）だけ（strict と同じ扱い）。

strict（愛称ごとに人が決める。2026-09-16）
    2 モーラの愛称に「直後に敬称があれば距離 1 を許す」規則は、ラプラスの正しい補正 28 件のうち
    22 件（こゆ→こよ ×9、ラク/ラブ/ラフ/ラップ→ラプ ×8、こー/コロ→こよ ×4、こえ→こよ）を支える一方、
    本人が cast に居ないとき 1 音違いの一般語や他メンバーを書き換える（ルイちゃん→すいちゃん、
    ふみちゃん→フブちゃん、しろちゃま→シオちゃま、ごろさん→ころさん）。構造では区別できないので、
    cast の dict に `strict: [alias, ...]`（str 形式では alias の末尾に「!」: "星街すいせい すいせい すい!"）
    を書いた alias は**距離 0（表記統一）だけ**に使う。1 音違いの隣人が一般語や他の人の愛称になる
    愛称（すい・フブ・シオ・ころ）を strict にし、誤爆が出ていないもの（ラプ・こよ・ねね）は距離 1 のまま。

保護区間
    既に正解表記になっている区間は「その位置を占める人」で保護する。別人の候補は跨げないが、
    同じ人の距離 1 の候補は跨いでよい（[フブキ, フブ] で 'フブヒちゃん' の頭 2 文字が フブ で保護されても、
    同じ人の フブキ への距離 1 補正は通る。長い候補が貪欲採用で勝つ）。距離 0 の表記統一は同じ人でも
    跨がない（こぼ/コボ の両表記を alias に持つと コボ⇄こぼ で振動する）。

読みについて
    漢字→かな変換の辞書は入っていないので、alias の読みは alias 自体を正規化したもの。
    漢字を含む alias（フルネームなど）は距離 0 の完全一致（＝保護）にしか使わない。
    漢字の聞き違い（彼方→かなた、お粥→おかゆ）は mis_kanji で表記を直接与える。
    置換先は、mis_kanji が名の部分だけ（彼方・お粥）なら name の末尾にあたる alias
    （かなた・おかゆ）、フルネーム型（猫股おかゆ・大沢すばる: 読みが alias で終わる）なら name。
    直前に name の頭部分（姓: 天音・猫又）が付いていれば、姓ごと name に置き換える
    （天音彼方→天音かなた、猫又お粥→猫又おかゆ。天音天音かなた にしない）。alias の有無に依らない。
    名の部分だけの mis_kanji（吹雪・昴・彼方・お粥）は一般語と同じ表記なので、直後が敬称か
    直前に姓が付いているときだけ置換する（'吹雪の中' は不変、'吹雪先輩'→'フブキ先輩'、
    '白上吹雪'→'白上フブキ'）。フルネーム型と alias 無しの entry の mis_kanji は無条件。
    mis_kanji が漢字を 1 字も含まない、または他の人の alias / name と同じなら warnings に入れる
    （後者は置換しない）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Iterable

# ---------------------------------------------------------------------------
# カナ正規化
# ---------------------------------------------------------------------------

_SMALL_VOWEL = {"ぁ": "あ", "ぃ": "い", "ぅ": "う", "ぇ": "え", "ぉ": "お"}
_ROWS = {
    "あ": "あかさたなはまやらわがざだばぱぁゃ",
    "い": "いきしちにひみりぎじぢびぴぃ",
    "う": "うくすつぬふむゆるぐずづぶぷぅゅっゔ",
    "え": "えけせてねへめれげぜでべぺぇ",
    "お": "おこそとのほもよろをごぞどぼぽぉょ",
}
_VOWEL_OF = {c: v for v, s in _ROWS.items() for c in s}
_SMALL_YAYUYO = set("ゃゅょ")


def _kata_to_hira(ch: str) -> str:
    o = ord(ch)
    if 0x30A1 <= o <= 0x30F6:  # ァ..ヶ
        return chr(o - 0x60)
    return ch


def _is_hira(ch: str) -> bool:
    return "ぁ" <= ch <= "ゖ"


def _is_kata(ch: str) -> bool:
    return "ァ" <= ch <= "ヶ"


def _is_kanji(ch: str) -> bool:
    return "一" <= ch <= "鿿" or ch in "々〆"


def _is_kana_like(ch: str) -> bool:
    return _is_hira(ch) or _is_kata(ch) or ch in "ーヽヾゝゞ"


def normalize_chars(text: str) -> list[str]:
    """1 文字→1 文字で正規化（位置対応を保つ）。カナ→かな、小書き母音→大、ー→直前の母音。"""
    out: list[str] = []
    for ch in text:
        c = _kata_to_hira(ch)
        c = _SMALL_VOWEL.get(c, c)
        if c == "ー":
            prev = out[-1] if out else ""
            c = _VOWEL_OF.get(prev, "ー")
        out.append(c)
    return out


def normalize(text: str) -> str:
    return "".join(normalize_chars(text))


def _mora(reading: str) -> int:
    return sum(1 for c in reading if c not in _SMALL_YAYUYO)


def _levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    la, lb = len(a), len(b)
    if la == 0:
        return lb
    if lb == 0:
        return la
    prev = list(range(lb + 1))
    for i in range(1, la + 1):
        cur = [i] + [0] * lb
        ca = a[i - 1]
        for j in range(1, lb + 1):
            cost = 0 if ca == b[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        prev = cur
    return prev[lb]


# ---------------------------------------------------------------------------
# 出演者リスト
# ---------------------------------------------------------------------------


@dataclass
class CastEntry:
    name: str
    aliases: list[str] = field(default_factory=list)
    mis_kanji: list[str] = field(default_factory=list)
    strict: list[str] = field(default_factory=list)  # 距離 0（表記統一）だけに使う alias


@dataclass
class _Target:
    surface: str  # 置換後の表記
    reading: str  # 正規化した読み
    mora: int
    person: str
    fuzzy: bool  # かな連との曖昧照合に使うか（漢字を含むもの・敬称込みの表記は完全一致＝保護のみ）
    maxd: int = 1  # 許す距離。敬称を剥がした 2 モーラ以下の語幹は 0（表記統一だけ）


@dataclass
class Fix:
    before: str
    after: str
    rule: str  # "fix"（距離1の補正）/ "kana"（表記統一）/ "mis_kanji"
    span: tuple[int, int]  # その回の置換前 text 上の [start, end)（round 1 なら入力 text 上）
    round: int = 1  # 何回目の走査で見つけたか（fix_text は収束まで最大 MAX_ROUNDS 回走る）


#: 候補が無くなるまで繰り返す上限。表記統一で生まれた語境界の連鎖は実測で 2 回目に収束する
MAX_ROUNDS = 3


def _str_list(v: Any, label: str) -> list[str]:
    """dict の aliases / mis_kanji。str 1 つなら [str] に包む。それ以外の非 list は ValueError。"""
    if v is None:
        return []
    if isinstance(v, str):
        return [v.strip()]
    if isinstance(v, (list, tuple)):
        out: list[str] = []
        for a in v:
            if a is None:
                continue
            if not isinstance(a, str):
                raise ValueError(f"cast の {label} は文字列にしてください: {a!r}")
            out.append(a.strip())
        return out
    raise ValueError(f"cast の {label} は文字列かそのリストにしてください: {v!r}")


def parse_cast(items: Iterable[Any] | None) -> list[CastEntry]:
    """出演者リストを受ける。要素は str か dict。

    str: "天音かなた かなた かなたん" → 空白区切りで先頭が name、残りが aliases。
         末尾に「!」を付けた alias（"星街すいせい すいせい すい!"）は strict
    dict: {"name": ..., "aliases": [...], "mis_kanji": [...], "strict": [...]}
          （aliases / mis_kanji / strict は str 1 つでもよい）
    name は必ず aliases に含める。strict の alias は aliases にも含める。
    strict の alias は距離 0（表記統一）だけに使う（_build_targets 参照）。

    🔴 items そのものが str（"天音かなた かなた" をリストに包まず渡す誤り）は ValueError。
       黙って受けると 1 文字ずつ CastEntry になり「あさん→ラさん」の 1 文字置換が起きる。
       None / 数値の要素も ValueError（YAML の空行や手打ちミス）。heavy._analyze は
       ASR の前にこれを呼んで、不正な cast で数十分の文字起こしを無駄にしないようにしている。
    """
    if isinstance(items, (str, bytes)):
        raise ValueError(f"cast はリストにしてください（str をそのまま渡さない）: {items!r}")
    out: list[CastEntry] = []
    for item in items or []:
        if isinstance(item, str):
            parts = item.split()
            if not parts:
                continue
            aliases: list[str] = []
            strict: list[str] = []
            for a in parts[1:]:
                bare = a.rstrip("!")
                if not bare:  # 「!」だけ
                    continue
                if bare != a:
                    strict.append(bare)
                aliases.append(bare)
            entry = CastEntry(name=parts[0].rstrip("!") or parts[0], aliases=aliases, strict=strict)
        elif isinstance(item, dict):
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            entry = CastEntry(
                name=name,
                aliases=[a for a in _str_list(item.get("aliases"), "aliases") if a],
                mis_kanji=[k for k in _str_list(item.get("mis_kanji"), "mis_kanji") if k],
                strict=[a for a in _str_list(item.get("strict"), "strict") if a],
            )
        else:
            raise ValueError(f"cast の要素は str か dict にしてください: {item!r}")
        # strict の alias は aliases にも含める（name そのものは strict にしない）
        for a in entry.strict:
            if a != entry.name and a not in entry.aliases:
                entry.aliases.append(a)
        if entry.name not in entry.aliases:
            entry.aliases.insert(0, entry.name)
        # 重複を落とす（順序は保つ）
        entry.aliases = list(dict.fromkeys(entry.aliases))
        entry.mis_kanji = list(dict.fromkeys(entry.mis_kanji))
        entry.strict = [a for a in dict.fromkeys(entry.strict) if a != entry.name]
        out.append(entry)
    return out


def _strip_honorific(surf: str) -> str | None:
    """alias の末尾が敬称なら語幹を返す（フブちゃん→フブ）。敬称で終わらなければ None。

    愛称の接尾（かなたん の「たん」、ねねち の「ち」、ルイ姉 の「姉」）は敬称ではないので剥がさない
    （HONORIFICS に入っていない）。
    """
    for h in sorted(HONORIFICS, key=len, reverse=True):
        if surf.endswith(h) and len(surf) > len(h):
            return surf[: -len(h)]
    return None


def _build_targets(cast: list[CastEntry], warnings: list[str] | None = None) -> list[_Target]:
    """alias を照合対象に組む。

    🔴 敬称込みの alias（フブちゃん・すいちゃん・シオちゃま）は語幹だけを曖昧照合に使う。
       敬称込みのまま読みにすると 5 モーラの語として評価され、「3 モーラ以下は敬称必須」を
       素通りして ルイちゃん→すいちゃん、ふみちゃん→フブちゃん の別人化が起きる。
       敬称込みの表記そのものは距離 0 の保護（fuzzy=False）にだけ使う。
       語幹が 2 モーラ以下（フブ/すい/シオ/ころ/ラプ）は距離 0（表記統一）だけに使う。
       2 モーラで距離 1 は半分が違う音で、実データの別人化（ふみ/ふう→フブ、しろ→シオ、
       カプ/らっ→ラプ、るい/ゆい/すー→すい）が全部この型。3 モーラ以上の語幹は
       敬称無しの alias と同じ規則（敬称必須・距離 1）。
    🔴 entry.strict に入った alias（すい / フブ / シオ / ころ）も距離 0 だけ。敬称無しで書かれた
       2 モーラの愛称は既定では距離 1 を許す（こゆ→こよ ×9 など正しい補正の 22/28 を支える）ので、
       1 音違いに一般語や他の人が居るものだけ人が strict にする（モジュール docstring 参照）。
    重複は (surface, person) で見る。別人物が同じ alias を持っていたら warnings に入れる
    （_find_candidates の「同区間同距離で別人物なら置換しない」がそのまま効く）。
    mis_kanji の検査（漢字を含まない / 他の人の alias・name と同じ）もここで warnings に入れる。
    """
    targets: list[_Target] = []
    seen: set[tuple[str, str]] = set()
    owner: dict[str, str] = {}

    def add(surf: str, person: str, *, fuzzy_ok: bool, maxd: int = 1) -> None:
        key = (surf, person)
        if key in seen:
            return
        seen.add(key)
        if surf in owner and owner[surf] != person:
            if warnings is not None:
                warnings.append(f"alias '{surf}' が {owner[surf]} と {person} の両方にある（同区間の候補は置換しない）")
        else:
            owner.setdefault(surf, person)
        rd = normalize(surf)
        fuzzy = fuzzy_ok and all(_is_hira(c) for c in rd)
        targets.append(_Target(surf, rd, _mora(rd), person, fuzzy, maxd))

    for entry in cast:
        for surf in entry.aliases:
            strict = surf in entry.strict
            stem = _strip_honorific(surf) if surf != entry.name else None
            if stem is None:
                add(surf, entry.name, fuzzy_ok=True, maxd=0 if strict else 1)
                continue
            # 敬称込みの表記は保護だけ。語幹を照合に使う（2 モーラ以下は表記統一だけ）
            add(surf, entry.name, fuzzy_ok=False)
            add(stem, entry.name, fuzzy_ok=True, maxd=1 if (_mora(normalize(stem)) >= 3 and not strict) else 0)
    if warnings is not None:
        for entry in cast:
            for mk in entry.mis_kanji:
                if not any(_is_kanji(c) for c in mk):
                    warnings.append(f"{entry.name} の mis_kanji '{mk}' に漢字が無い（読みの揺れは aliases に書く）")
                other = _mis_kanji_owner(mk, entry, cast)
                if other:
                    warnings.append(f"{entry.name} の mis_kanji '{mk}' は {other} の alias / name と同じ（置換しない）")
    return targets


def _mis_kanji_owner(mk: str, entry: CastEntry, cast: list[CastEntry]) -> str | None:
    """mis_kanji が他の entry の alias / name と同じなら、その人の name。無ければ None。"""
    for e in cast:
        if e is entry:
            continue
        if mk == e.name or mk in e.aliases:
            return e.name
    return None


def _surname_before(text: str, i: int, name: str) -> int:
    """text[i:] の直前に name の頭部分（姓）が付いていれば、その文字数。無ければ 0。

    name[:k] を長い k から試す。ひらがなだけの頭部分（ときのそら の「と」）は助詞と紛れるので数えない。
    """
    for k in range(len(name) - 1, 0, -1):
        head = name[:k]
        if all(_is_hira(c) for c in head):
            continue
        if i >= k and text[i - k : i] == head:
            return k
    return 0


def _given_alias(entry: CastEntry) -> str | None:
    """name の末尾にあたる alias（天音かなた → かなた）。無ければ None。最長を選ぶ。"""
    best: str | None = None
    for a in entry.aliases:
        if a != entry.name and len(a) < len(entry.name) and entry.name.endswith(a):
            if best is None or len(a) > len(best):
                best = a
    return best


# ---------------------------------------------------------------------------
# 文脈ガード
# ---------------------------------------------------------------------------

# 敬称。たん/姉/ち は愛称側（かなたん/あくたん/ルイ姉/ねねち）で持つのでここには入れない
HONORIFICS = ["先輩", "せんぱい", "ちゃま", "ちゃん", "さん", "くん", "君", "殿", "様", "さま"]
# 敬称が付く一般語（親族語など）。候補+敬称 がこれなら名前ではない
_HONORIFIC_WORDS = {
    "おかあさん", "おとうさん", "おにいさん", "おねえさん", "おじさん", "おばさん", "おじいさん", "おばあさん",
    "みなさん", "みんなさん", "おきゃくさん", "おっさん", "ごくろうさん", "おつかれさん", "おいしゃさん", "おまわりさん",
    "あかちゃん", "ねこちゃん", "いぬちゃん", "おばあちゃん", "おじいちゃん", "おにいちゃん", "おねえちゃん", "おかあちゃん",
    "おとうちゃん", "おっちゃん", "おばちゃん", "おじちゃん", "おうさま", "かみさま", "おひめさま", "おきゃくさま",
    "おうじさま", "せんぱい", "こうはい", "おくさん", "だんなさん", "しゅじんさん",
}
_CALL_PUNCT = "!?！？…♪"
# 右隣がこれなら語末とみなす（助詞・助動詞・接続の頭）
_RIGHT_OK = set("はがのもとにをでへやかねよさぞっだじなみて")
# 左隣がこれなら語頭とみなす（1 字助詞・記号）。ひらがな原文で判定する（カタカナ「ノ」を助詞にしない）
_LEFT_OK = set("とやもがはのにで、。!?！？…・ 　「『(（")
# 末尾がこれで、その手前が読みの頭部分なら「ラミの」→ラミィ のような助詞食い
_PARTICLE_TAIL = "のがはをにともでへ"


def _honorific_after(after: str) -> str | None:
    for h in HONORIFICS:
        if after.startswith(h):
            # 副詞「ちゃんと」は敬称ではない（これちゃんと→こよちゃんと ×2 を防ぐ）
            if h == "ちゃん" and after[len(h) : len(h) + 1] == "と":
                return None
            return h
    return None


def _ctx_strong(text: str, i: int, j: int, norm: str) -> bool:
    """直後が敬称。ただし 候補+敬称 が一般語（おかあさん等）なら不可。"""
    h = _honorific_after(text[j:])
    if not h:
        return False
    return (norm[i:j] + normalize(h)) not in _HONORIFIC_WORDS


def _script_of(ch: str) -> str | None:
    """かな連の中での文字種: h=ひらがな k=カタカナ。長音・踊り字は None（前の文字に従う）。"""
    if _is_hira(ch):
        return "h"
    if _is_kata(ch):
        return "k"
    return None


def _script_at(text: str, k: int) -> str | None:
    while k >= 0:
        sc = _script_of(text[k])
        if sc:
            return sc
        if text[k] in "ーヽヾゝゞ":
            k -= 1
            continue
        return None
    return None


def _ctx_boundary(text: str, i: int, j: int, run_s: int, run_e: int) -> tuple[bool, bool]:
    """語境界。
    左: かな連の先頭（ただし直前が漢字で候補がひらがな始まりなら送り仮名とみなして不可）
        or 1 字助詞/記号 or 文字種の切り替わり（ひらがな⇄カタカナ）
    右: かな連の末尾 or 助詞 or 敬称 or 記号 or 文字種の切り替わり
    """
    if i == run_s:
        left_ok = True
        if i > 0 and _is_kanji(text[i - 1]) and _is_hira(text[i]):
            # 素晴らしい の「らしい」を語頭にしない（カタカナ始まりは送り仮名になり得ないので通す）
            left_ok = False
    else:
        left_ok = text[i - 1] in _LEFT_OK
        if not left_ok:
            a, b = _script_at(text, i - 1), _script_of(text[i])
            left_ok = a is not None and b is not None and a != b  # なんかイルハちゃん
    if j >= len(text):
        right_ok = True
    else:
        right_ok = (
            (j == run_e)
            or (text[j] in _RIGHT_OK)
            or bool(_honorific_after(text[j:]))
            or (text[j] in _CALL_PUNCT)
        )
        if not right_ok:
            a, b = _script_at(text, j - 1), _script_of(text[j])
            right_ok = a is not None and b is not None and a != b
    return left_ok, right_ok


def _kana_runs(text: str, normc: list[str]) -> list[tuple[int, int]]:
    runs: list[tuple[int, int]] = []
    s: int | None = None
    for k, ch in enumerate(text):
        if _is_kana_like(ch) and _is_hira(normc[k]):
            if s is None:
                s = k
        elif s is not None:
            runs.append((s, k))
            s = None
    if s is not None:
        runs.append((s, len(text)))
    return runs


# ---------------------------------------------------------------------------
# 候補の探索と採用
# ---------------------------------------------------------------------------

#: (start, end, distance, surface, rule, person)
_Cand = tuple[int, int, int, str, str, str]


def _find_candidates(text: str, targets: list[_Target], cast: list[CastEntry], protect: bool) -> list[_Cand]:
    normc = normalize_chars(text)
    norm = "".join(normc)
    runs = _kana_runs(text, normc)
    n = len(text)

    # 既に正解表記の区間は、その位置を占める人で保護する（シオン→シオ、こより→こよ、かなたん→かなた を防ぐ）。
    # 🔴 別人の候補は跨げない。同じ人の距離 1 の候補は跨いでよい（[フブキ, フブ] の 'フブヒちゃん'→'フブキちゃん'）
    protected: list[str | None] = [None] * (n + 1)
    if protect:
        for t in targets:
            for mm in re.finditer(re.escape(t.surface), text):
                for k in range(mm.start(), mm.end()):
                    protected[k] = t.person

    def crosses_other(i: int, j: int, person: str) -> bool:
        return any(p is not None and p != person for p in protected[i:j])

    cands: list[_Cand] = []

    # mis_kanji: 完全一致で置換。
    #   置換先は、mis_kanji が名の部分だけ（彼方・お粥）なら name 末尾の alias（かなた・おかゆ）、
    #   フルネーム型（猫股おかゆ・大沢すばる: 読みが alias で終わる）か alias 無しなら name。
    #   直前に姓（name の頭部分）が付いていれば姓ごと name に置き換える（天音彼方→天音かなた、猫又お粥→猫又おかゆ）。
    #   名の部分だけの mis_kanji は一般語と同じ表記（吹雪・昴）なので、直後が敬称か直前に姓が付くときだけ。
    #   別人の正解表記を跨ぐ形（かなた を mis_kanji に書いた 金田一）は置換しない。
    for entry in cast:
        given = _given_alias(entry)
        for mk in entry.mis_kanji:
            if mk == entry.name or _mis_kanji_owner(mk, entry, cast):
                continue
            fullname_type = given is None or normalize(mk).endswith(normalize(given))
            repl = entry.name if fullname_type else given
            if repl == mk:
                continue
            for mm in re.finditer(re.escape(mk), text):
                i, j = mm.start(), mm.end()
                if crosses_other(i, j, entry.name):
                    continue
                k = _surname_before(text, i, entry.name)
                if k:
                    cands.append((i - k, j, -1, entry.name, "mis_kanji", entry.name))
                else:
                    # 🔴 名の部分だけの mis_kanji（彼方・お粥）にも敬称や姓の条件は付けない。
                    #    付けると実素材で正しい補正 6 件（「お粥が一番暫定1位」「この彼方も相手も」）を失い、
                    #    防げた誤爆は 0 件だった（2026-09-16）。一般語と紛れる表記を mis_kanji に
                    #    書かない、という辞書側の運用で受ける。
                    cands.append((i, j, -1, repl, "mis_kanji", entry.name))

    for t in targets:
        if not t.fuzzy:
            continue
        rd, L, m = t.reading, len(t.reading), t.mora
        # 🔴 距離は 1 まで。2 を許すと 5 件直して 21 件壊す（対戦相手を出演者に書き換える）
        maxd = min(1, t.maxd)
        for rs, re_ in runs:
            for i in range(rs, re_):
                for length in range(max(1, L - maxd), L + maxd + 1):
                    j = i + length
                    if j > re_:
                        break
                    cand = norm[i:j]
                    d = _levenshtein(cand, rd)
                    if d > maxd:
                        continue
                    orig = text[i:j]
                    if orig == t.surface:  # 既に正解表記
                        continue
                    # 🔴 別人の正解表記は跨げない。同じ人の正解表記は「距離 1 かつ直後に敬称」の
                    #    補正だけ跨いでよい（[フブキ, フブ] の 'フブヒちゃん'→'フブキちゃん'）。
                    #    距離 0（表記統一）は同じ人でも跨がない: こぼ/コボ の両表記が alias にあると
                    #    コボ⇄こぼ で振動する。
                    #    敬称の条件が無いと、短い alias（おかゆ）に 1 文字付いただけの普通の文が
                    #    長い alias（おかゆん）に化ける: 「おかゆやったんか?」→「おかゆんったんか?」
                    #    「おかゆめっちゃ速くない?」→「おかゆんっちゃ速くない?」（実素材で 17 件、
                    #    3 件は日本語が壊れた。2026-09-16 の最終確認）
                    crosses_self = any(p is not None for p in protected[i:j])
                    if crosses_other(i, j, t.person):
                        continue
                    if crosses_self and (d == 0 or not _ctx_strong(text, i, j, norm)):
                        continue
                    if length > L and rd in cand:  # 前後にゴミが付いただけ（ルイルイに）
                        continue
                    if orig.count("ー") >= 2:  # 「あーー」→あくあ の類
                        continue
                    if d >= 1:
                        # 候補が敬称を食っている（かなさん→かなたん ×2）なら不可
                        if any(orig.endswith(h) and not rd.endswith(normalize(h)) for h in HONORIFICS):
                            continue
                        # 末尾が助詞で、その手前が読みの頭部分（ラミの→ラミィ、ルイルイに→ルイルイ）
                        if orig[-1] in _PARTICLE_TAIL and rd.startswith(cand[:-1]) and length - 1 < L:
                            continue
                    # 読みの真部分文字列だけの一致は不可（シオン の「シオ」）
                    if length < L and cand in rd:
                        continue

                    rule = "kana" if d == 0 else "fix"
                    strong = _ctx_strong(text, i, j, norm)
                    lb, rb = _ctx_boundary(text, i, j, rs, re_)
                    bnd = lb and rb
                    if rule == "fix":
                        # 🔴 3 モーラ以下は敬称必須。外すと誤爆 6 → 548。
                        #    4 モーラ以上は距離 1 まで無条件（おかゆん/かなたん/ルイルイ）
                        if m <= 3 and not strong:
                            continue
                        # 敬称無しで 4 モーラ以上に当てるとき、聞こえた音が読みより短い
                        # （1 音落ちている）ものは不可。試作 V3 で唯一の実質誤爆
                        # 「おかん召喚」→おかゆん ×2 がこの型で、直せた側にこの型は 0 件
                        if not strong and length < L:
                            continue
                    else:
                        # 表記統一（距離 0）でも 2 モーラ以下は敬称必須（わるい→わルイ、ここよ→こよ）
                        if m <= 2 and not strong:
                            continue
                    # 🔴 語境界。外すと誤爆 6 → 26。表記統一で 3 モーラ以上は左だけ見る（ラミーなんも を通す）
                    need_bnd = bnd if (rule == "fix" or m <= 2) else lb
                    if not need_bnd:
                        continue
                    cands.append((i, j, d, t.surface, rule, t.person))

    # 同じ区間・同じ距離で別人物の候補が並んだら曖昧なので置換しない（ナミちゃん→ラミィ/かなた）
    by_span: dict[tuple[int, int, int], set[str]] = {}
    for c in cands:
        by_span.setdefault((c[0], c[1], c[2]), set()).add(c[5])
    cands = [c for c in cands if len(by_span[(c[0], c[1], c[2])]) == 1]

    # 距離小 → 長い → 左 の順で貪欲に採用（重なり禁止）
    cands.sort(key=lambda c: (c[2], -(c[1] - c[0]), c[0]))
    taken: list[_Cand] = []
    used = [False] * (n + 1)
    for c in cands:
        i, j = c[0], c[1]
        if any(used[i:j]):
            continue
        taken.append(c)
        for k in range(i, j):
            used[k] = True
    taken.sort(key=lambda c: c[0])
    return taken


def _fix_once(text: str, targets: list[_Target], cast: list[CastEntry], protect: bool) -> tuple[str, list[Fix]]:
    """1 走査ぶんの補正。Fix の span は入力 text 上の位置。"""
    cands = _find_candidates(text, targets, cast, protect)
    if not cands:
        return text, []
    out: list[str] = []
    pos = 0
    fixes: list[Fix] = []
    for i, j, _d, surf, rule, _person in cands:
        out.append(text[pos:i])
        out.append(surf)
        fixes.append(Fix(before=text[i:j], after=surf, rule=rule, span=(i, j)))
        pos = j
    out.append(text[pos:])
    return "".join(out), fixes


def _not_converged(text: str, targets: list[_Target], cast: list[CastEntry], protect: bool) -> bool:
    """max_rounds 回当てた後にまだ候補が残っているか（＝次の呼び出しでまた変わる）。"""
    return bool(_find_candidates(text, targets, cast, protect))


def fix_text(
    text: str,
    cast: list[CastEntry],
    *,
    protect: bool = True,
    max_rounds: int = MAX_ROUNDS,
    warnings: list[str] | None = None,
) -> tuple[str, list[Fix]]:
    """1 文を補正する。候補が無くなるまで繰り返す（上限 max_rounds）。

    返す Fix の span は**その回の置換前 text 上**の位置（round 1 は入力 text 上）。
    words にも写すときは fix_transcript のように 1 回ずつ当てること。
    max_rounds 回当ててもまだ候補が残る（収束しない）なら warnings に入れる（渡されたとき）。
    """
    if not text or not cast:
        return text, []
    targets = _build_targets(cast)
    all_fixes: list[Fix] = []
    cur = text
    for rnd in range(1, max_rounds + 1):
        cur, fixes = _fix_once(cur, targets, cast, protect)
        if not fixes:
            break
        for f in fixes:
            f.round = rnd
        all_fixes.extend(fixes)
        if rnd == max_rounds and warnings is not None and _not_converged(cur, targets, cast, protect):
            warnings.append(f"補正が MAX_ROUNDS={max_rounds} 回で収束しなかった: {text!r} → {cur!r}")
    return cur, all_fixes


# ---------------------------------------------------------------------------
# transcript への適用（text と words の両方）
# ---------------------------------------------------------------------------


def _word_offset(seg: dict[str, Any]) -> int | None:
    """words の連結が seg.text とどう対応するか。

    実データ（4 配信 9,456 セグメント）では連結 == text が 9,453、残り 3 は
    連結の先頭に空白が 1 つ付いているだけだった。faster_whisper の word は前後に
    空白が付くことがある（seg.text は strip 済み、w.word は生）ので、前後の空白を
    無視して一致を見る。それ以外の形は触らない（None）。
    返り値は「text の 0 文字目が連結の何文字目か」＝先頭空白の数。words が無ければ 0。
    """
    words = seg.get("words") or []
    text = seg.get("text", "")
    if not words:
        return 0
    joined = "".join(str(w.get("text", "")) for w in words)
    if joined == text:
        return 0
    if joined.strip() == text:
        return len(joined) - len(joined.lstrip())
    return None


def _apply_to_words(words: list[dict[str, Any]], offset: int, span: tuple[int, int], new: str) -> None:
    """text 上の [i, j) を new に置き換えたのと同じ変更を words に写す。

    🔴 時刻の並びを壊さない。
       置換範囲にかかる word の「範囲内の部分」に new を文字数比で配り直す。
       範囲外の前後（word の頭や尻）はそのまま残す。
       配り直しで文字が無くなった word は、時間を隣の word に足してから取り除く
       （空の word を残すと、cut.py の間検出が「そこに間があった」と読む）。
    """
    i, j = span[0] + offset, span[1] + offset
    starts: list[int] = []
    pos = 0
    for w in words:
        starts.append(pos)
        pos += len(str(w.get("text", "")))
    ends = starts[1:] + [pos]

    hit = [k for k in range(len(words)) if ends[k] > i and starts[k] < j and ends[k] > starts[k]]
    if not hit:
        return
    a, b = hit[0], hit[-1]
    # 各 word の「置換範囲にかかっている文字数」
    inside = [min(ends[k], j) - max(starts[k], i) for k in hit]
    total = sum(inside)
    # new を inside の比で配る（最大剰余法。合計が len(new) になるようにする）
    shares = [0] * len(hit)
    if total > 0 and new:
        raw = [len(new) * x / total for x in inside]
        shares = [int(x) for x in raw]
        rest = len(new) - sum(shares)
        order = sorted(range(len(hit)), key=lambda k: raw[k] - shares[k], reverse=True)
        for k in order[:rest]:
            shares[k] += 1

    cursor = 0
    for idx, k in enumerate(hit):
        wt = str(words[k].get("text", ""))
        head = wt[: max(0, i - starts[k])] if k == a else ""
        tail = wt[len(wt) - max(0, ends[k] - j) :] if (k == b and ends[k] > j) else ""
        piece = new[cursor : cursor + shares[idx]]
        cursor += shares[idx]
        words[k]["text"] = head + piece + tail

    # 空になった word を、時間を隣に足してから取り除く（後ろから）
    for k in range(b, a - 1, -1):
        if words[k].get("text", ""):
            continue
        if k > 0:
            words[k - 1]["src_end"] = max(float(words[k - 1].get("src_end", 0)), float(words[k].get("src_end", 0)))
        elif k + 1 < len(words):
            words[k + 1]["src_start"] = min(float(words[k + 1].get("src_start", 0)), float(words[k].get("src_start", 0)))
        del words[k]


def _fix_time(seg: dict[str, Any], words: list[dict[str, Any]], offset: int, span: tuple[int, int]) -> float:
    """置換範囲に掛かる最初の word の src_start。words が無ければ seg の src_start。"""
    i = span[0] + offset
    pos = 0
    for w in words:
        n = len(str(w.get("text", "")))
        if n > 0 and pos + n > i:
            return float(w.get("src_start", seg.get("src_start", 0.0)))
        pos += n
    return float(seg.get("src_start", 0.0))


def fix_transcript(transcript: dict[str, Any], cast: list[CastEntry] | list[Any] | None) -> dict[str, Any]:
    """segments[].text と segments[].words[].text の両方を破壊的に直す。

    🔴 words も直すこと。PAC のテロップは words を見て息継ぎで分けるので、
       text だけ直すと字幕と本文がずれる。
    🔴 words と text が一致しないセグメントは text も触らない（skipped_mismatch に数える）。
       ずれた字幕を出すより直さない方が安全。
    冪等: 各セグメントで候補が無くなるまで（上限 MAX_ROUNDS 回）繰り返すので、
       同じ transcript に 2 回当てても 2 回目は count 0。

    report: {"count", "fixes": [{"time", "before", "after", "rule", "segment_text"}],
             "skipped_mismatch", "warnings"}
       before / after は語単位。segment_text はその回の置換前のセグメント全文。
       time は該当 word の src_start（words が無ければ seg の src_start）。
       warnings: 別人と同じ alias / mis_kanji の検査 / MAX_ROUNDS で収束しなかったセグメント。
    """
    if isinstance(cast, (str, bytes)):
        raise ValueError(f"cast はリストにしてください（str をそのまま渡さない）: {cast!r}")
    if cast and not isinstance(cast[0], CastEntry):
        cast = parse_cast(cast)
    warnings: list[str] = []
    report: dict[str, Any] = {"count": 0, "fixes": [], "skipped_mismatch": 0, "warnings": warnings}
    if not cast:
        return report
    targets = _build_targets(cast, warnings)
    for idx, seg in enumerate(transcript.get("segments", [])):
        for rnd in range(1, MAX_ROUNDS + 1):
            text = seg.get("text", "")
            if not text:
                break
            new_text, fixes = _fix_once(text, targets, cast, True)
            if not fixes:
                break
            if rnd == MAX_ROUNDS and _not_converged(new_text, targets, cast, True):
                warnings.append(f"セグメント {idx}: 補正が MAX_ROUNDS={MAX_ROUNDS} 回で収束しなかった: {new_text!r}")
            offset = _word_offset(seg)
            if offset is None:
                report["skipped_mismatch"] += 1
                break
            words = seg.get("words") or []
            for f in fixes:
                report["fixes"].append({
                    "time": _fix_time(seg, words, offset, f.span),
                    "before": f.before,
                    "after": f.after,
                    "rule": f.rule,
                    "segment_text": text,
                })
            # 右から当てれば、左側の文字位置はずれない
            for f in sorted(fixes, key=lambda f: f.span[0], reverse=True):
                _apply_to_words(words, offset, f.span, f.after)
            seg["text"] = new_text
            report["count"] += len(fixes)
    return report
