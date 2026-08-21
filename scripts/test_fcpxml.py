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

        # ── テロップ ──────────────────────────────────
        titles = root.findall(".//title")
        check("カットに入ったテロップは出ない", len(titles) == 2, f"{len(titles)} 枚")

        texts = [t.find(".//text-style").text for t in titles]
        check("記号がエスケープされて元に戻る", "記号 < > & のテスト" in texts, str(texts))

        # 25.0秒のテロップは、5.0-6.2 と 20.0-22.5 が切られているので 21.3秒あたり。
        # 🔴 完全一致は求めない。区間ごとにフレーム境界へ載せるので、
        #    「秒で計算した理想値」とは最大1フレームずれる。
        #    ずれてよいのは1フレームまで、が守りたい条件。
        one_frame = den / num
        got = as_seconds(titles[1].get("offset"))
        check(
            "テロップの位置がカット後の時刻に写っている（1フレーム以内）",
            abs(got - 21.3) <= one_frame,
            f"{got:.4f}秒（理想 21.3000秒 / 1フレーム = {one_frame:.4f}秒）",
        )

        # そのテロップが、対応するクリップの中に収まっていること
        clip3 = clips[2]
        c_start = as_seconds(clip3.get("offset"))
        c_end = c_start + as_seconds(clip3.get("duration"))
        check(
            "テロップが対応するクリップの中にある",
            c_start <= got < c_end,
            f"テロップ {got:.3f}秒 / クリップ {c_start:.3f}〜{c_end:.3f}秒",
        )

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
        check("同じ見た目はまとめて1つの定義", len(defs) == 2, f"{len(defs)} 個")

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

        st2 = defs[1].find("text-style")
        check("斜体は italic で指定（日本語に実物が無いため）", st2.get("italic") == "1", str(st2.get("italic")))
        check("別の書体は別の定義になる", st2.get("font") == "Zen Old Mincho", str(st2.get("font")))

        titles = root3.findall(".//title")
        refs = [t.find("text/text-style").get("ref") for t in titles]
        check("同じ見た目のテロップは同じ定義を指す", refs[0] == refs[1] and refs[0] != refs[2], str(refs))

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
        check("テロップ無しならタイトルの定義も出ない", root2.find(".//effect") is None)

    print()
    print("test-fcpxml: OK" if failed == 0 else f"test-fcpxml: {failed} 件失敗")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
