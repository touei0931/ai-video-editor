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
"""

from __future__ import annotations

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


def _rate(fps: float) -> tuple[int, int]:
    """フレームレートを (分子, 分母) にする。"""
    key = int(round(fps * 1000))
    for k, v in _NTSC.items():
        if abs(key - k) <= 2:
            return v
    if abs(fps - round(fps)) < 0.001:
        return int(round(fps)), 1
    # 上のどれでもない半端な値。分母1000で近似する
    approx = Fraction(fps).limit_denominator(1000)
    return approx.numerator, approx.denominator


def _t(seconds: float, num: int, den: int) -> str:
    """秒 → FCPXML の時刻表記（フレーム境界に丸める）。"""
    frames = int(round(max(0.0, seconds) * num / den))
    return f"{frames * den}/{num}s"


def _dur(seconds: float, num: int, den: int) -> str:
    """長さ。0 にはしない（0 の clip は読み込み時に落ちる）。"""
    frames = max(1, int(round(seconds * num / den)))
    return f"{frames * den}/{num}s"


def write_fcpxml(
    out_path: str,
    video_path: str,
    keeps: list[tuple[float, float]],
    fps: float,
    width: int,
    height: int,
    duration: float,
    telops: list[dict[str, Any]] | None = None,
    project_name: str = "AI動画編集",
) -> str:
    """残す区間を並べたタイムラインを FCPXML で書き出す。

    telops を渡すと、字幕トラックとしてタイトルを乗せる。
    位置やフォントまでは再現しない——
    再現できないものを中途半端に持ち込むと、編集ソフト側で直す手間が増える。
    文言と時刻だけを渡し、見た目は向こうで作ってもらう。
    """
    num, den = _rate(fps)
    src = Path(video_path).resolve()
    # 🔴 as_uri() を使う。"file://" + pathname2url() だと
    #    Windows で file://///D:/... のようにスラッシュが増え、Final Cut が素材を見つけられない。
    url = src.as_uri()

    # 素材全体の長さ。実際より短いと、後半の区間が読み込めない。
    asset_dur = _dur(max(duration, keeps[-1][1] if keeps else duration), num, den)

    lines: list[str] = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<!DOCTYPE fcpxml><fcpxml version="{FCPXML_VERSION}">',
        "  <resources>",
        f'    <format id="r1" name="FFVideoFormat{height}p{int(round(fps))}"'
        f' frameDuration="{den}/{num}s" width="{width}" height="{height}"'
        ' colorSpace="1-1-1 (Rec. 709)"/>',
        f'    <asset id="a1" name="{html.escape(src.stem)}" start="0s"'
        f' duration="{asset_dur}" hasVideo="1" hasAudio="1"'
        ' audioSources="1" audioChannels="2" format="r1">',
        f'      <media-rep kind="original-media" src="{html.escape(url)}"/>',
        "    </asset>",
        "  </resources>",
        f'  <library name="{html.escape(project_name)}">',
        f'    <event name="{html.escape(project_name)}">',
        f'      <project name="{html.escape(Path(video_path).stem)}">',
        f'        <sequence format="r1" tcStart="0s" tcFormat="NDF"'
        ' audioLayout="stereo" audioRate="48k">',
        "          <spine>",
    ]

    # 残す区間を順に並べる。offset は編集後タイムライン、start は元素材の時刻。
    #
    # 🔴 積算は必ず**フレーム数**で行うこと。
    #    秒で足していくと、各クリップの長さをフレームに丸めた結果と
    #    積算した秒がずれていき、クリップの間に1フレームの隙間や重なりができる。
    #    Final Cut は隙間をそのまま黒画面として読み込むので、
    #    20分素材なら数十箇所で映像が一瞬途切れる。
    frame = 0
    out_frames: list[int] = []  # 各クリップの開始フレーム。テロップの位置合わせに使う
    for i, (s, e) in enumerate(keeps):
        length = max(1, int(round((e - s) * num / den)))
        out_frames.append(frame)
        lines.append(
            f'            <asset-clip ref="a1" name="cut{i + 1}"'
            f' offset="{frame * den}/{num}s"'
            f' start="{_t(s, num, den)}"'
            f' duration="{length * den}/{num}s"'
            ' format="r1" tcFormat="NDF" audioRole="dialogue"/>'
        )
        frame += length

    # テロップ。元素材の時刻を、カット後のタイムラインへ写す。
    # 🔴 クリップと同じフレーム基準に載せる。秒で計算すると、
    #    上でフレームに丸めたクリップの位置と1フレームずれる。
    def to_frame(t: float) -> int:
        for (s, e), base in zip(keeps, out_frames):
            if t < s:
                return base
            if t <= e:
                return base + int(round((t - s) * num / den))
        return frame

    for i, tel in enumerate(telops or []):
        start = to_frame(float(tel["src_start"]))
        end = to_frame(float(tel["src_end"]))
        if end - start < 1:
            continue
        text = html.escape(str(tel.get("text", "")).replace("\n", " "))
        if not text:
            continue
        lines.append(
            f'            <title name="telop{i + 1}" lane="1"'
            f' offset="{start * den}/{num}s"'
            f' duration="{(end - start) * den}/{num}s"'
            ' ref="r2" role="titles">'
        )
        lines.append(f'              <text><text-style ref="ts1">{text}</text-style></text>')
        lines.append("            </title>")

    lines += [
        "          </spine>",
        "        </sequence>",
        "      </project>",
        "    </event>",
        "  </library>",
        "</fcpxml>",
    ]

    # タイトルを使うなら、その定義（effect）が resources に要る
    if telops:
        effect = (
            '    <effect id="r2" name="Basic Title"'
            ' uid=".../Titles.localized/Bumper:Opener.localized/'
            'Basic Title.localized/Basic Title.moti"/>'
        )
        at = lines.index("  </resources>")
        lines.insert(at, effect)
        style = (
            '          <text-style-def id="ts1">'
            '<text-style font="Hiragino Sans" fontSize="72" fontColor="1 1 1 1"'
            ' bold="1" alignment="center"/></text-style-def>'
        )
        lines.insert(lines.index("          <spine>"), style)

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


__all__ = ["write_fcpxml", "frame_rate_note", "FCPXML_VERSION"]
