"""Final Cut Pro に渡すためのタイムラインを書き出す（FCPXML）。

なぜ要るか:
  このアプリで編集は完結できるが、そこで止まると
  BGM も差し込み映像も足せず、あとからカットを1箇所直すだけで
  テロップが単語の途中で切れる。
  **カットの判断はこのアプリ、仕上げは編集ソフト**という使い分けができないと、
  実際の運用には乗らない。友達は Final Cut を使っている。

  残す区間は keep_ranges で既に持っているので、出すのはテキスト生成だけ。
  追加の依存もライセンス上の制約も無い。

🔴 時刻は必ず有理数で書くこと。
   FCPXML の時刻は「分子s/分母s」という文字列で、分母はフレームレートの分母に
   揃っていないと Final Cut が読み込みで丸める。
   秒を小数で書くと1フレームずれ、テロップの位置が全部ずれる。

🔴 素材の参照は絶対パスの file:// URL。
   相対パスにすると、読み込む側のカレントディレクトリ次第で
   「メディアが見つかりません」になる。

🔴 作りは FCP プラグイン版（fcp-extension/Extension/FCPXMLWriter.swift）と揃えること。
   あちらは友達の実機の Final Cut で踏んだ落とし穴を全部直してある
   （docs/pac-contract.md「FCPXML は借りていない」）。
   片方で見つけた落とし穴は、もう片方にも入れる。ここに写してあるもの:
     - 形式の名前は「決まった大きさ・コマ数」のときだけ名乗る（縦の素材が 0.316 倍になる）
     - コマ数は標準の値に寄せる（59.99 のままだとプロジェクトがカスタム扱いになる）
     - asset に format を書かない（読みが食い違うと映像が半分の大きさで出る）
     - テロップは「いちばん長く乗っているクリップ」にぶら下げる（始まりだけ見ると落ちる）
     - 位置と長さはフレーム（整数）で持ち回す（秒で積むと1フレームの隙間が出る）
     - シーケンスの尺は残したクリップの合計（素材の長さだと終わりに黒みが残る）
     - 速度を変えるときは timeMap を書き、ぶら下げたものの位置も出来上がりの時刻で測る
     - 何で作ったかを1行、コメントで残す（困ったときに送ってもらうのは XML）
"""

from __future__ import annotations

import datetime as _dt
import html
from fractions import Fraction
from pathlib import Path
from typing import Any

#: FCPXML のバージョン。Final Cut Pro 10.6 以降で読める。
FCPXML_VERSION = "1.9"


#: NTSC 系のフレームレート。
#: 🔴 29.97 を 2997/100 や 29970/1000 と書いてはいけない。
#:    正しくは 30000/1001。近似で書くと Final Cut 側で長さが少しずつずれ、
#:    30分の素材では終盤でテロップが1秒近く動く。
_NTSC: dict[int, tuple[int, int]] = {
    23976: (24000, 1001),
    29970: (30000, 1001),
    47952: (48000, 1001),
    59940: (60000, 1001),
    119880: (120000, 1001),
}

#: Final Cut が「決まった形」として扱うコマ数。
#:
#: 🔴 ここから外れた値を渡すと、プロジェクトが「カスタム」になり、
#:    Final Cut のプロジェクト設定で 1080p や 4K を選べなくなる。
STANDARD_FPS = (23.976, 24.0, 25.0, 29.97, 30.0, 50.0, 59.94, 60.0)

#: 決まったコマ数の呼び名（Apple の書き方）。29.97 は「p30」ではなく「p2997」
_RATE_NAME = {
    23.976: "2398",
    24.0: "24",
    25.0: "25",
    29.97: "2997",
    30.0: "30",
    50.0: "50",
    59.94: "5994",
    60.0: "60",
}


def snap_fps(fps: float, tolerance: float = 0.01) -> float:
    """近い標準のコマ数に寄せる。

    🔴 ffmpeg が返すのは**平均**のコマ数。可変フレームレートの素材では
       59.99 や 29.98 のような半端な値になる。そのまま書き出すと、
       名前は「1080p60」なのに中身は 59.99、という食い違った形式になり、
       Final Cut はカスタム扱いにする（プラグイン版の実機で 2026-09-02）。

    🔴 1% を超えて離れていたら寄せないこと。
       48fps を 50 に寄せるような真似をすると、尺がずれる。
       本当に半端な素材は、半端なまま渡すほうが害が小さい。
    """
    if fps <= 0:
        return 0.0
    best = min(STANDARD_FPS, key=lambda s: abs(s - fps))
    return best if abs(best - fps) <= best * tolerance else fps


def _rate(fps: float) -> tuple[int, int]:
    """フレームレートを (分子, 分母) にする。標準の値に寄せてから決める。"""
    fps = snap_fps(fps)
    key = int(round(fps * 1000))
    for k, v in _NTSC.items():
        if abs(key - k) <= 2:
            return v
    if abs(fps - round(fps)) < 0.001:
        return int(round(fps)), 1
    # 上のどれでもない半端な値。分母1000で近似する
    approx = Fraction(fps).limit_denominator(1000)
    return approx.numerator, approx.denominator


def format_name(width: int, height: int, fps: float) -> str:
    """Final Cut に見せる形式の名前。

    🔴 決まった名前は「その大きさそのもの」のときだけ使うこと。
       FFVideoFormat1080p / 720p / 4K は、Apple が**横向き**の
       1920x1080 / 1280x720 / 3840x2160 に付けている名前。
       以前は高さだけを見て「FFVideoFormat1920p30」のような
       ありそうな名前を作っていた。名前と中身が食い違うと Final Cut は
       名前の方（16:9）を信じて素材を一度 16:9 に収め、それをまた縦の枠に収める。
       9/16 を2回かけた **0.316倍** で真ん中に小さく出る（プラグイン版で 2026-08-31）。

    🔴 コマ数の方も「決まった値」でなければ名乗らない。
       当てはまらないときは Apple が「決まった形ではない」の意味で使う名前に倒し、
       大きさは width/height だけで決めさせる。
    """
    rate = _RATE_NAME.get(round(snap_fps(fps) * 1000) / 1000)
    if rate is None:
        return "FFVideoFormatRateUndefined"
    if (width, height) == (1920, 1080):
        return f"FFVideoFormat1080p{rate}"
    if (width, height) == (1280, 720):
        return f"FFVideoFormat720p{rate}"
    if (width, height) == (3840, 2160):
        return f"FFVideoFormat4K{rate}"
    return "FFVideoFormatRateUndefined"


def _t(seconds: float, num: int, den: int) -> str:
    """秒 → FCPXML の時刻表記（フレーム境界に丸める）。"""
    frames = int(round(max(0.0, seconds) * num / den))
    return f"{frames * den}/{num}s"


def _dur(seconds: float, num: int, den: int) -> str:
    """長さ。0 にはしない（0 の clip は読み込み時に落ちる）。"""
    frames = max(1, int(round(seconds * num / den)))
    return f"{frames * den}/{num}s"


def _frames(seconds: float, num: int, den: int) -> int:
    """秒 → フレーム数（0 以上）。"""
    return int(round(max(0.0, seconds) * num / den))


def _tf(frames: int, num: int, den: int) -> str:
    """フレーム数 → FCPXML の時刻表記。"""
    return f"{frames * den}/{num}s"


def _rgba(color: Any, fallback: str = "1 1 1 1") -> str:
    """[r, g, b](0〜1) を FCPXML の色表記にする。"""
    if not isinstance(color, (list, tuple)) or len(color) < 3:
        return fallback
    try:
        r, g, b = (max(0.0, min(1.0, float(c))) for c in color[:3])
    except (TypeError, ValueError):
        return fallback
    return f"{r:.4f} {g:.4f} {b:.4f} 1"


def _text_style_def(sid: str, look: dict[str, Any], indent: str = "              ") -> str:
    """見た目ひとつぶんの定義。

    🔴 太字は bold="1" ではなく fontFace で指定すること。
       同梱書体は太さの実物を別ファイルで持っている（Black / Bold）。
       そこへ bold="1" を足すと、Final Cut が**太い字をさらに太らせる**ので、
       画面で見ていたものより明らかに重い字になる。
       斜体だけは実物が無いので italic="1"（傾けて作る）で合っている。
    """
    attrs = [
        f'font="{html.escape(str(look.get("font") or "Hiragino Sans"))}"',
        f'fontSize="{int(round(float(look.get("font_size") or 72)))}"',
        f'fontColor="{_rgba(look.get("color"))}"',
        'alignment="center"',
    ]
    face = look.get("font_face")
    if face:
        attrs.insert(1, f'fontFace="{html.escape(str(face))}"')
    if look.get("italic"):
        attrs.append('italic="1"')
    stroke = _rgba(look.get("stroke_color"), "")
    width = float(look.get("stroke_width") or 0)
    if stroke and width > 0:
        # Final Cut の strokeWidth は外向きが正
        attrs.append(f'strokeColor="{stroke}"')
        attrs.append(f'strokeWidth="{width:.2f}"')
    return f'{indent}<text-style-def id="{sid}"><text-style {" ".join(attrs)}/></text-style-def>'


def project_name(video_path: str, now: _dt.datetime | None = None) -> str:
    """書き出すプロジェクトの名前。「【PAC】元の動画の名前_日付時刻」。

    🔴 固定の名前にしないこと。
       何本も下ごしらえすると、Final Cut の中に同じ名前が並び、
       どれがどの素材のものか分からなくなる。
    """
    stamp = (now or _dt.datetime.now()).strftime("%Y%m%d%H%M%S")
    return f"【PAC】{Path(video_path).stem}_{stamp}"


def stamp(
    meta: dict[str, Any] | None,
    width: int,
    height: int,
    fps: float,
    keeps: int,
    telops: int,
    speed: float,
) -> str:
    """書き出しに残す1行。**Final Cut は読み飛ばす**ので中身は自由。

    🔴 人が読める1行にすること。困ったときに送ってもらうのは XML なので、
       ここに要るものが揃っていれば、それ以上聞かなくて済む。
       版・素材の大きさ・使った設定・件数（プラグイン版と同じ並び）。
    """
    m = meta or {}
    parts = ["PAC"]
    if m.get("version"):
        parts.append(f"v{m['version']}")
    parts.append(f"素材 {width}x{height} {snap_fps(fps):g}fps")
    if m.get("cut_preset"):
        parts.append(f"詰め具合 {m['cut_preset']}")
    if "detect_aside" in m:
        parts.append(f"独り言 {'入' if m['detect_aside'] else '切'}")
    if "cut_candidates" in m:
        parts.append(f"カット候補 {int(m['cut_candidates'])}（切る {int(m.get('cuts_applied', 0))}）")
    else:
        parts.append(f"クリップ {keeps}")
    parts.append(f"テロップ {telops}")
    if abs(speed - 1.0) > 1e-9:
        parts.append(f"速度 {speed * 100:g}%")
    if m.get("font_size"):
        size = float(m["font_size"])
        ratio = size / height * 100 if height > 0 else 0
        parts.append(f"文字 {int(round(size))}px（高さの {ratio:.1f}%）")
    # 🔴 コメントの中に "--" があると XML として壊れる
    return " / ".join(parts).replace("--", "—")


def write_fcpxml(
    out_path: str,
    video_path: str,
    keeps: list[tuple[float, float]],
    fps: float,
    width: int,
    height: int,
    duration: float,
    telops: list[dict[str, Any]] | None = None,
    project_name_: str | None = None,
    speed: float = 1.0,
    meta: dict[str, Any] | None = None,
) -> str:
    """残す区間を並べたタイムラインを FCPXML で書き出す。

    telops を渡すと、クリップにぶら下げたタイトルとして乗せる。
    書体・大きさ・色・縁取り・位置まで写す。

    speed は書き出す再生速度（1.0 = 等倍）。素材側の時刻（どこを使うか）は割らず、
    出来上がりの長さと位置だけを割る。

    🔴 同梱書体は**アプリの中にしか無い**。友達の Mac に入っていなければ、
       Final Cut は警告も出さずに別の書体で開く。
       書き出しのときにフォントファイルも一緒に置いて、一度だけ入れてもらう
       （electron/main の app:exportFonts と docs/はじめての使い方.md）。
    """
    if not keeps:
        raise ValueError("残す区間がありません（全部カットされています）")
    rate = speed if speed and speed > 0 else 1.0
    num, den = _rate(fps)
    src = Path(video_path).resolve()
    # 🔴 as_uri() を使う。"file://" + pathname2url() だと
    #    Windows で file://///D:/... のようにスラッシュが増え、Final Cut が素材を見つけられない。
    url = src.as_uri()
    telops = [t for t in (telops or []) if str(t.get("text", "")).strip()]

    # 素材全体の長さ。実際より短いと、後半の区間が読み込めない。
    asset_dur = _dur(max(duration, keeps[-1][1] if keeps else duration), num, den)

    """
    各クリップの、素材での始まり・終わりと、出来上がりでの長さ（すべてフレーム）。

    🔴 ここで一度だけ決めて、offset も duration も シーケンスの尺も、
       すべてこの数から作ること。秒で足していくと、各クリップの長さを
       フレームに丸めた結果と積算した秒がずれていき、クリップの間に
       1フレームの隙間や重なりができる。Final Cut は隙間をそのまま
       黒画面として読み込むので、20分素材なら数十箇所で映像が一瞬途切れる。
    """
    clips: list[tuple[int, int, int]] = []  # (src_start_f, src_end_f, out_len_f)
    for s, e in keeps:
        sf = _frames(s, num, den)
        ef = max(sf + 1, _frames(e, num, den))
        out_len = max(1, int(round((ef - sf) / rate)))
        clips.append((sf, ef, out_len))
    # 🔴 シーケンスの尺は残したクリップの合計。素材の長さのままだと、
    #    切ったぶんがそのまま終わりの空白（黒み）になる。
    total_out = sum(c[2] for c in clips)

    """
    テロップをどのクリップにぶら下げるか。

    🔴 「始まりが入っているか」で決めないこと。
       カットの終わりと喋り出しは数フレーム重なることがあり、
       始まりだけカットに食い込んだテロップが丸ごと消える
       （プラグイン版の実機で 66枚中 17枚が出ていなかった。2026-09-08）。
    🔴 **いちばん長く乗っているクリップ**に付ける。
       またがったものが2つのクリップに出て二重になるのを防ぐ。
       どのクリップにも乗らないもの（カットの中に収まっているフィラーなど）は出さない。
    """
    owner: dict[int, list[int]] = {}
    for ti, tel in enumerate(telops):
        ts, te = float(tel["src_start"]), float(tel["src_end"])
        best, best_ov = -1, 0.0
        for ci, (s, e) in enumerate(keeps):
            ov = min(te, e) - max(ts, s)
            if ov > best_ov:
                best, best_ov = ci, ov
        if best >= 0:
            owner.setdefault(best, []).append(ti)

    lines: list[str] = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<!DOCTYPE fcpxml>",
        f'<fcpxml version="{FCPXML_VERSION}">',
        # 🔴 何で作ったかを1行残す。困ったときに送ってもらうのは XML なので、ここが一番確実
        f"  <!-- {html.escape(stamp(meta, width, height, fps, len(keeps), len(telops), rate))} -->",
        "  <resources>",
        f'    <format id="r1" name="{format_name(width, height, fps)}"'
        f' frameDuration="{den}/{num}s" width="{width}" height="{height}"'
        ' colorSpace="1-1-1 (Rec. 709)"/>',
    ]
    # タイトルを使うなら、その定義（effect）が resources に要る
    if telops:
        lines.append(
            '    <effect id="r2" name="Basic Title"'
            ' uid=".../Titles.localized/Bumper:Opener.localized/'
            'Basic Title.localized/Basic Title.moti"/>'
        )
    lines += [
        # 🔴 asset に format を書かないこと。**大きさが分かっていても書かない。**
        #    こちらの読みと Final Cut の読みが食い違うことがある（PAC は 1080x1920、
        #    Final Cut は 2160x3840 と表示）。食い違ったまま宣言すると、
        #    Final Cut は2つの数字をすり合わせようとして、映像が枠の半分の大きさで出る。
        #    書かなければ、Final Cut は自分が読んだ素材をこちらの枠に収めるだけになる。
        f'    <asset id="a1" name="{html.escape(src.stem)}" start="0s"'
        f' duration="{asset_dur}" hasVideo="1" videoSources="1" hasAudio="1"'
        ' audioSources="1" audioChannels="2">',
        f'      <media-rep kind="original-media" src="{html.escape(url)}"/>',
        "    </asset>",
        "  </resources>",
        # 🔴 library に name は付けないこと。
        #    そんな属性は無いので、Final Cut は XML ごと読み込みを断る
        #    （「DTD の検証でエラーが起きました」とだけ出る）。
        "  <library>",
        '    <event name="PAC">',
        f'      <project name="{html.escape(project_name_ or project_name(video_path))}">',
        f'        <sequence format="r1" duration="{_tf(total_out, num, den)}"'
        ' tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">',
        "          <spine>",
    ]

    used_titles = 0
    offset_f = 0
    for ci, (sf, ef, out_len) in enumerate(clips):
        inner: list[str] = []
        """
        🔴 速度の指定は、いちばん先に置くこと。
           中身の並びは DTD で決まっていて、時間に関する指定（timeMap）は
           場所に関する指定（adjust-*）やぶら下げたもの（title）より前。
           順番を間違えると読み込みが丸ごと失敗し、「DTD の検証でエラー」としか出ない。
        """
        if abs(rate - 1.0) > 1e-9:
            inner += [
                "              <timeMap>",
                f'                <timept time="0s" value="{_tf(sf, num, den)}" interp="linear"/>',
                f'                <timept time="{_tf(out_len, num, den)}" value="{_tf(ef, num, den)}" interp="linear"/>',
                "              </timeMap>",
            ]
        inner.append('              <adjust-conform type="fit"/>')

        """
        この区間に入るテロップを、このクリップにぶら下げる。

        🔴 offset の原点は「このクリップの start（＝素材の時刻）」。
           シーケンス上の時刻を書くと、頭を切った素材でテロップがまるごとずれる。
        🔴 原点から先は**出来上がりの時刻**で測ること。
           timeMap を付けても、Final Cut はぶら下げたものの offset を読み替えない。
           素材の時刻のまま書くと、速度を上げたぶんだけテロップが後ろへずれ、
           クリップの外へ出たものは「不正な編集」として弾かれる。
        🔴 クリップの終わりで切ること。はみ出した分は次のクリップのテロップと重なる。
        """
        limit_f = sf + out_len
        for ti in owner.get(ci, []):
            tel = telops[ti]
            ts_f = max(_frames(max(float(tel["src_start"]), keeps[ci][0]), num, den), sf)
            te_f = max(min(_frames(float(tel["src_end"]), num, den), ef), ts_f + 1)
            off_f = sf + int(round((ts_f - sf) / rate))
            if off_f >= limit_f:
                off_f = limit_f - 1
            dur_f = max(1, int(round((te_f - ts_f) / rate)))
            if off_f + dur_f > limit_f:
                dur_f = limit_f - off_f
            if dur_f < 1:
                continue

            text = html.escape(str(tel.get("text", "")).replace(chr(10), " "))
            look = tel.get("look") or {}
            used_titles += 1
            sid = f"ts{used_titles}"
            # 🔴 同じ時間に重なるテロップは別のレーンに置くこと。
            #    同じレーンに重ねると、Final Cut では後の1枚が前を押しのける。
            lane = 1 + int(tel.get("lane") or 0)
            inner.append(
                f'              <title ref="r2" lane="{lane}" name="telop{ti + 1}"'
                f' offset="{_tf(off_f, num, den)}" start="0s"'
                f' duration="{_tf(dur_f, num, den)}" role="titles">'
            )
            # 位置。Final Cut の座標は画面中央が原点で、上が正。
            # 🔴 key は Basic Title の Position パラメータのもの。
            #    知らないパラメータは読み飛ばされるので、合わなくても
            #    読み込みそのものは失敗しない（中央に出るだけ）。
            # 🔴 title の中の並びは param → adjust-transform → text → text-style-def
            pos = look.get("position")
            if isinstance(pos, (list, tuple)) and len(pos) >= 2:
                inner.append(
                    '                <param name="Position"'
                    ' key="9999/999166631/999166633/1/100/101"'
                    f' value="{float(pos[0]):.1f} {float(pos[1]):.1f}"/>'
                )
            inner.append(f'                <text><text-style ref="{sid}">{text}</text-style></text>')
            # 🔴 見た目の定義は**それを使う title の中**、text の後。
            #    sequence の中に置くと Final Cut は XML ごと読み込みを断る。
            #    id は書類の中で1つきりなので、1枚ごとに作る。
            inner.append(_text_style_def(sid, look, indent="                "))
            inner.append("              </title>")

        lines.append(
            f'            <asset-clip ref="a1" name="cut{ci + 1}"'
            f' offset="{_tf(offset_f, num, den)}"'
            f' start="{_tf(sf, num, den)}"'
            f' duration="{_tf(out_len, num, den)}"'
            ' tcFormat="NDF" audioRole="dialogue">'
        )
        lines += inner
        lines.append("            </asset-clip>")
        # 🔴 積むのは出来上がりの長さ。素材の長さを積むと、速度を変えたときにクリップの間が空く
        offset_f += out_len

    lines += [
        "          </spine>",
        "        </sequence>",
        "      </project>",
        "    </event>",
        "  </library>",
        "</fcpxml>",
    ]

    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text("\n".join(lines) + "\n", encoding="utf-8")
    return out_path


def _map_to_output(t: float, keeps: list[tuple[float, float]]) -> float:
    """元素材の時刻 → カット後の時刻（§11.2 の座標変換）。"""
    acc = 0.0
    for s, e in keeps:
        if t < s:
            return acc
        if t <= e:
            return acc + (t - s)
        acc += e - s
    return acc


def frame_rate_note(fps: float) -> str:
    """診断用。読み込み時にずれたときの切り分けに使う。"""
    num, den = _rate(fps)
    return f"{num}/{den} ({num / den:.3f}fps)" if den != 1 else f"{num}fps"
