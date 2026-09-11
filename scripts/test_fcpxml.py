"""Final Cut へ渡すタイムライン（FCPXML）の検査。

🔴 ここが守っていること:
   - XML として読めること。壊れた XML は Final Cut が黙って読み込みを失敗する
   - 時刻が**フレーム境界の有理数**であること。
     29.97 を 2997/100 のように近似すると、30分素材の終盤で1秒近くずれる
   - 素材の参照が正しい file:// URL であること。
     Windows で "file://" + pathname2url() を使うと file://///D:/... になり、
     Final Cut が「メディアが見つかりません」になる
   - テロップの位置が、カット後のタイムラインに正しく写っていること

実行: python scripts/test_fcpxml.py
"""

from __future__ import annotations

import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _console import enable_utf8  # noqa: E402

from sidecar.cut import keep_ranges  # noqa: E402
from sidecar.fcpxml import _rate, write_fcpxml  # noqa: E402

failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failed
    if not ok:
        failed += 1
    print(f"[fcpxml] {'OK  ' if ok else 'NG  '} {name}")
    if detail:
        print(f"        {detail}")


def main() -> int:
    enable_utf8()

    # ── フレームレート ────────────────────────────────
    check("29.97 は 30000/1001 になる", _rate(29.97) == (30000, 1001), str(_rate(29.97)))
    check("23.976 は 24000/1001 になる", _rate(23.976) == (24000, 1001), str(_rate(23.976)))
    check("59.94 は 60000/1001 になる", _rate(59.94) == (60000, 1001), str(_rate(59.94)))
    check("30 は 30/1 のまま", _rate(30.0) == (30, 1), str(_rate(30.0)))
    check("25 は 25/1 のまま", _rate(25.0) == (25, 1), str(_rate(25.0)))

    with tempfile.TemporaryDirectory() as tmp:
        video = Path(tmp) / "素材 テスト.mp4"
        video.write_bytes(b"0")

        duration = 60.0
        cuts = [(5.0, 6.2), (20.0, 22.5), (40.0, 40.8)]
        keeps = keep_ranges(duration, cuts)
        telops = [
            {"src_start": 2.0, "src_end": 4.0, "text": "最初のテロップ"},
            {"src_start": 25.0, "src_end": 27.0, "text": "記号 < > & のテスト"},
            # まるごとカットに入ったもの。出してはいけない
            {"src_start": 20.4, "src_end": 21.0, "text": "消えるはず"},
        ]

        out = str(Path(tmp) / "out.fcpxml")
        write_fcpxml(out, str(video), keeps, fps=29.97,
                     width=1080, height=1920, duration=duration, telops=telops)

        try:
            root = ET.parse(out).getroot()
            check("XML として読める", True)
        except ET.ParseError as e:
            check("XML として読める", False, str(e))
            print("\ntest-fcpxml: 失敗")
            return 1

        # ── 素材の参照 ────────────────────────────────
        src = root.find(".//media-rep").get("src")
        check(
            "素材の参照がスラッシュ3本の file:// URL",
            src.startswith("file:///") and not src.startswith("file:////"),
            src,
        )
        check("日本語と空白を含むパスでも壊れない", "%" in src or " " not in src, src)

        # ── 区間 ──────────────────────────────────────
        clips = root.findall(".//asset-clip")
        check("残す区間の数だけクリップが並ぶ", len(clips) == len(keeps),
              f"{len(clips)} 本 / 残す区間 {len(keeps)} 本")

        num, den = _rate(29.97)

        def as_seconds(value: str) -> float:
            a, b = value.rstrip("s").split("/")
            return int(a) / int(b)

        # 先頭は 0、以降は前のクリップの終わりに繋がっている
        offset = 0.0
        gapless = True
        for c in clips:
            if abs(as_seconds(c.get("offset")) - offset) > 1e-6:
                gapless = False
            offset += as_seconds(c.get("duration"))
        check("クリップが隙間なく並ぶ", gapless)

        check(
            "全部の時刻がフレーム境界の有理数",
            all(
                v.endswith("s") and v.rstrip("s").split("/")[1] == str(num)
                for c in clips
                for v in (c.get("offset"), c.get("start"), c.get("duration"))
            ),
            f"分母はすべて {num}",
        )

        # ── 作り（プラグイン版と揃えた所）──────────────
        #
        # 🔴 sequence の尺は残したクリップの合計。素材の長さのままだと終わりに黒みが残る
        seq = root.find(".//sequence")
        check(
            "シーケンスの尺は残したクリップの合計",
            abs(as_seconds(seq.get("duration")) - offset) < 1e-6,
            f"{as_seconds(seq.get('duration')):.4f} / 合計 {offset:.4f}",
        )
        # 🔴 asset に format を書かない（読みが食い違うと映像が半分の大きさで出る）
        check("asset に format を書かない", root.find(".//asset").get("format") is None)
        check(
            "プロジェクト名は【PAC】素材名_日時",
            root.find(".//project").get("name").startswith("【PAC】素材 テスト_"),
            root.find(".//project").get("name"),
        )
        # 🔴 何で作ったかの1行がコメントで入る（困ったときに送ってもらうのは XML）
        head = Path(out).read_text(encoding="utf-8").splitlines()[:5]
        check("由来の1行がコメントで入る", any("<!-- PAC" in ln for ln in head), "\n".join(head))
        check(
            "由来の1行に素材の大きさとコマ数が入る",
            any("素材 1080x1920 29.97fps" in ln for ln in head),
            "\n".join(head),
        )
        # 🔴 縦の素材に「ありそうな名前」を付けない（0.316 倍で真ん中に出る）
        check(
            "縦の素材の形式名は RateUndefined",
            root.find(".//format").get("name") == "FFVideoFormatRateUndefined",
            root.find(".//format").get("name"),
        )
        check(
            "クリップに adjust-conform が入る",
            all(c.find("adjust-conform") is not None for c in clips),
        )

        # ── テロップ ──────────────────────────────────
        titles = root.findall(".//title")
        check("カットに入ったテロップは出ない", len(titles) == 2, f"{len(titles)} 枚")

        texts = [t.find(".//text-style").text for t in titles]
        check("記号がエスケープされて元に戻る", "記号 < > & のテスト" in texts, str(texts))

        # 🔴 テロップはクリップの**中**にぶら下げる（spine に直接置かない）。
        #    offset の原点はそのクリップの start（素材の時刻）。
        check(
            "テロップはクリップの中にある",
            all(t in list(c) for t in titles for c in clips if t in list(c))
            and root.find(".//spine/title") is None,
        )
        one_frame = den / num
        title2 = titles[1]
        parent = next(c for c in clips if title2 in list(c))
        got = as_seconds(title2.get("offset"))
        check(
            "25.0秒のテロップは 22.5〜40.0 のクリップにぶら下がる",
            as_seconds(parent.get("start")) == as_seconds(clips[2].get("start")),
            f"親クリップ start {as_seconds(parent.get('start')):.3f}",
        )
        check(
            "offset は素材の時刻（1フレーム以内）",
            abs(got - 25.0) <= one_frame,
            f"{got:.4f}秒（理想 25.0000秒 / 1フレーム = {one_frame:.4f}秒）",
        )
        p_start = as_seconds(parent.get("start"))
        p_end = p_start + as_seconds(parent.get("duration"))
        check(
            "テロップが親クリップの中に収まる",
            p_start <= got and got + as_seconds(title2.get("duration")) <= p_end + 1e-6,
            f"テロップ {got:.3f}〜{got + as_seconds(title2.get('duration')):.3f} / クリップ {p_start:.3f}〜{p_end:.3f}",
        )
        check("title の start は 0s", title2.get("start") == "0s", str(title2.get("start")))

        # ── またがったテロップは「いちばん長く乗っているクリップ」に1枚だけ ──
        out_s = str(Path(tmp) / "straddle.fcpxml")
        write_fcpxml(out_s, str(video), keeps, fps=30, width=1920, height=1080, duration=duration,
                     telops=[
                         # 19.0〜20.4: 前のクリップ（6.2〜20.0）に 1.0秒、カット（20.0〜22.5）に 0.4秒
                         {"src_start": 19.0, "src_end": 20.4, "text": "またがる"},
                         # 19.9〜24.0: 前に 0.1秒、後ろのクリップ（22.5〜）に 1.5秒 → 後ろに付く
                         {"src_start": 19.9, "src_end": 24.0, "text": "後ろが長い"},
                     ])
        root_s = ET.parse(out_s).getroot()
        clips_s = root_s.findall(".//asset-clip")
        titles_s = root_s.findall(".//title")
        check("またがっても1枚ずつ", len(titles_s) == 2, f"{len(titles_s)} 枚")
        first = next(c for c in clips_s if titles_s[0] in list(c))
        second = next(c for c in clips_s if titles_s[1] in list(c))
        check(
            "長く乗っている側に付く（前）",
            as_seconds(first.get("start")) == 6.2,
            f"start {as_seconds(first.get('start'))}",
        )
        check(
            "長く乗っている側に付く（後ろ）",
            as_seconds(second.get("start")) == 22.5,
            f"start {as_seconds(second.get('start'))}",
        )
        # 後ろに付いたものは、クリップの頭（22.5）で切られる
        check(
            "食い込んだ分はクリップの頭で切る",
            abs(as_seconds(titles_s[1].get("offset")) - 22.5) < 1e-6,
            str(titles_s[1].get("offset")),
        )
        check(
            "横 1920x1080 の 30fps は決まった名前",
            root_s.find(".//format").get("name") == "FFVideoFormat1080p30",
            root_s.find(".//format").get("name"),
        )

        # ── 速度（timeMap）──────────────────────────────
        #
        # 🔴 数を決め打ちせず、等倍と比べて「速度との関係」で見る。
        for sp in (1.25, 2.0):
            out_v = str(Path(tmp) / f"speed{sp}.fcpxml")
            write_fcpxml(out_v, str(video), keeps, fps=30, width=1920, height=1080,
                         duration=duration, speed=sp,
                         telops=[{"src_start": 25.0, "src_end": 27.0, "text": "速い"}])
            root_v = ET.parse(out_v).getroot()
            clips_v = root_v.findall(".//asset-clip")
            base_v = ET.parse(out_s).getroot().findall(".//asset-clip")
            ok_len = all(
                abs(as_seconds(c.get("duration")) - as_seconds(b.get("duration")) / sp) <= 1 / 30 + 1e-6
                for c, b in zip(clips_v, base_v)
            )
            check(f"速度 {sp}: クリップの長さが 1/{sp}", ok_len)
            check(
                f"速度 {sp}: 素材側の時刻（start）は割らない",
                all(c.get("start") == b.get("start") for c, b in zip(clips_v, base_v)),
            )
            gapless_v = True
            off_v = 0.0
            for c in clips_v:
                if abs(as_seconds(c.get("offset")) - off_v) > 1e-9:
                    gapless_v = False
                off_v += as_seconds(c.get("duration"))
            check(f"速度 {sp}: クリップが1フレームの狂いもなく並ぶ", gapless_v)
            check(
                f"速度 {sp}: シーケンスの尺はクリップの合計",
                abs(as_seconds(root_v.find('.//sequence').get('duration')) - off_v) < 1e-9,
            )
            tm = [c.find("timeMap") for c in clips_v]
            check(f"速度 {sp}: 全クリップに timeMap が入る", all(x is not None for x in tm))
            check(
                f"速度 {sp}: timeMap は adjust-conform より前（DTD の並び）",
                all(list(c)[0].tag == "timeMap" for c in clips_v),
            )
            pts = tm[0].findall("timept")
            check(
                f"速度 {sp}: timeMap の値は素材の始まり〜終わり",
                as_seconds(pts[0].get("value")) == as_seconds(clips_v[0].get("start"))
                and abs(as_seconds(pts[1].get("time")) - as_seconds(clips_v[0].get("duration"))) < 1e-9,
            )
            t_v = root_v.find(".//title")
            parent_v = next(c for c in clips_v if t_v in list(c))
            ps = as_seconds(parent_v.get("start"))
            pe = ps + as_seconds(parent_v.get("duration"))
            to = as_seconds(t_v.get("offset"))
            check(
                f"速度 {sp}: テロップは出来上がりの時刻で置く（clip の start から (25-22.5)/{sp}）",
                abs(to - (22.5 + 2.5 / sp)) <= 1 / 30 + 1e-6,
                f"{to:.4f}（理想 {22.5 + 2.5 / sp:.4f}）",
            )
            check(
                f"速度 {sp}: テロップは clip の外に出ない",
                ps <= to and to + as_seconds(t_v.get("duration")) <= pe + 1e-9,
                f"{to:.3f}〜{to + as_seconds(t_v.get('duration')):.3f} / {ps:.3f}〜{pe:.3f}",
            )
            head_v = Path(out_v).read_text(encoding="utf-8").splitlines()[:5]
            check(f"速度 {sp}: 由来の1行に速度が入る", any(f"速度 {sp * 100:g}%" in ln for ln in head_v))

        # 等倍のときは速度の指定を1行も書かない（使わない人の書き出しは今までと同じ）
        check("等倍では timeMap を書かない", root.find(".//timeMap") is None)

        # ── コマ数を標準に寄せる ──────────────────────────
        from sidecar.fcpxml import format_name, snap_fps  # noqa: E402

        check("59.99 は 60 に寄せる", snap_fps(59.99) == 60.0, str(snap_fps(59.99)))
        check("29.98 は 29.97 に寄せる", snap_fps(29.98) == 29.97, str(snap_fps(29.98)))
        check("48 は寄せない（1% を超えて離れている）", snap_fps(48.0) == 48.0, str(snap_fps(48.0)))
        check("59.99 の形式名は 60", format_name(1920, 1080, 59.99) == "FFVideoFormat1080p60")
        check("29.97 の呼び名は p2997", format_name(1920, 1080, 29.97) == "FFVideoFormat1080p2997")
        check("4K は 3840x2160 だけ", format_name(3840, 2160, 30) == "FFVideoFormat4K30"
              and format_name(2160, 3840, 30) == "FFVideoFormatRateUndefined")
        check("半端なコマ数は名乗らない", format_name(1920, 1080, 48) == "FFVideoFormatRateUndefined")

        # ── 見た目（書体・太さ・色・縁・位置）────────────
        #
        # 🔴 同梱書体は macOS の書体名で書くこと。
        #    ctx.font 用の名前（ZenKakuGothicNew）を書くと、Final Cut は
        #    その書体を知らないので**警告も出さずに別の書体で開く**。
        look_a = {
            "font": "Zen Kaku Gothic New",
            "font_face": "Black",
            "font_size": 163,
            "color": [1.0, 1.0, 1.0],
            "stroke_color": [0.0, 0.0, 0.0],
            "stroke_width": 6.0,
            "position": [0.0, 384.0],
        }
        look_b = {**look_a, "font": "Zen Old Mincho", "font_face": "Bold", "italic": True}

        out3 = str(Path(tmp) / "look.fcpxml")
        write_fcpxml(out3, str(video), keeps, fps=30, width=1080, height=1920,
                     duration=duration, telops=[
                         {"src_start": 2.0, "src_end": 4.0, "text": "あ", "look": look_a},
                         {"src_start": 8.0, "src_end": 10.0, "text": "い", "look": look_a},
                         {"src_start": 12.0, "src_end": 14.0, "text": "う", "look": look_b},
                     ])
        root3 = ET.parse(out3).getroot()
        defs = root3.findall(".//text-style-def")
        check("1枚ごとに定義を持つ", len(defs) == 3, f"{len(defs)} 個")
        # 🔴 定義の置き場所は title の中。sequence の中に置くと
        #    Final Cut は XML ごと読み込みを断る（DTD の検証で落ちる）。
        check(
            "定義は title の中にある",
            all(len(t.findall("text-style-def")) == 1 for t in root3.findall(".//title")),
        )
        check("sequence の中には置かない", root3.find(".//sequence/text-style-def") is None)

        st = defs[0].find("text-style")
        check("書体は macOS の名前", st.get("font") == "Zen Kaku Gothic New", str(st.get("font")))
        check("太さは fontFace で指定", st.get("fontFace") == "Black", str(st.get("fontFace")))
        check(
            "太字フラグは立てない（実物の太字をさらに太らせない）",
            st.get("bold") is None,
            str(st.get("bold")),
        )
        check("大きさが入る", st.get("fontSize") == "163", str(st.get("fontSize")))
        check("色は 0〜1 の4つ組", st.get("fontColor").startswith("1.0000 1.0000 1.0000"), str(st.get("fontColor")))
        check("縁の色と太さが入る", st.get("strokeColor") is not None and st.get("strokeWidth") == "6.00",
              f"{st.get('strokeColor')} / {st.get('strokeWidth')}")

        st2 = defs[2].find("text-style")
        check("斜体は italic で指定（日本語に実物が無いため）", st2.get("italic") == "1", str(st2.get("italic")))
        check("別の書体は別の定義になる", st2.get("font") == "Zen Old Mincho", str(st2.get("font")))

        titles = root3.findall(".//title")
        refs = [t.find("text/text-style").get("ref") for t in titles]
        # 🔴 id は書類の中で1つきり。使い回すと定義を持てるのが1つになる
        check("定義の名前は重ならない", len(set(refs)) == len(refs), str(refs))
        check(
            "それぞれ自分の中の定義を指している",
            all(t.find("text/text-style").get("ref") == t.find("text-style-def").get("id")
                for t in titles),
        )

        params = titles[0].findall("param")
        check(
            "位置のパラメータが入る",
            any(x.get("name") == "Position" and x.get("value") == "0.0 384.0" for x in params),
            str([(x.get("name"), x.get("value")) for x in params]),
        )

        # 見た目を渡さなくても壊れないこと（古い呼び出し方）
        out4 = str(Path(tmp) / "nolook.fcpxml")
        write_fcpxml(out4, str(video), keeps, fps=30, width=1080, height=1920,
                     duration=duration, telops=[{"src_start": 2.0, "src_end": 4.0, "text": "あ"}])
        root4 = ET.parse(out4).getroot()
        st4 = root4.find(".//text-style-def/text-style")
        check("見た目を渡さなくても定義は出る", st4 is not None and st4.get("fontSize") is not None,
              ET.tostring(st4).decode() if st4 is not None else "なし")
        check(
            "見た目を渡さなければ位置も入れない",
            root4.find(".//title/param") is None,
        )

        # ── テロップ無し ──────────────────────────────
        out2 = str(Path(tmp) / "notelop.fcpxml")
        write_fcpxml(out2, str(video), keeps, fps=30, width=1920, height=1080,
                     duration=duration)
        root2 = ET.parse(out2).getroot()
        check("テロップ無しでも読める", len(root2.findall(".//asset-clip")) == len(keeps))
        # 🔴 library に name という属性は無い。付けると読み込みごと断られる
        check("library に属性を付けない", root2.find("library").attrib == {},
              str(root2.find("library").attrib))
        check("テロップ無しならタイトルの定義も出ない", root2.find(".//effect") is None)

    print()
    print("test-fcpxml: OK" if failed == 0 else f"test-fcpxml: {failed} 件失敗")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
