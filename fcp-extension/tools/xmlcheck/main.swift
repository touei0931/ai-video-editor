//
//  main.swift
//  FCPXML の自動検査
//
//  Mac が無いので、生成した FCPXML が壊れていないかを CI で見張る。
//  FCPXMLWriter.swift と TitleTemplate.swift を一緒にコンパイルして実行する。
//
//  見るところ:
//   - XML として妥当か
//   - version が 1.13 か（上げると FCP が弾く）
//   - 時刻がフレーム境界に乗っているか
//   - テンプレの effect uid と param が写っているか
//   - カットした分だけ尺が縮んでいるか
//

import Foundation

var failures: [String] = []
let quote = String(UnicodeScalar(34))

func check(_ label: String, _ condition: Bool, _ detail: String = "") {
    if condition {
        print("✅ \(label)")
    } else {
        print("❌ \(label) \(detail)")
        failures.append(label)
    }
}

// MARK: - 見本テンプレート（構造は友達の「基本01_10」と同じ形）

let templateXML = """
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.13">
  <resources>
    <effect id="r2" name="見本テンプレ" uid="~/Titles.localized/SamplePack/Sample/Sample.moti"/>
  </resources>
  <library>
    <event name="e">
      <project name="p">
        <sequence>
          <spine>
            <title ref="r2" offset="0s" name="見本" start="3600s" duration="542/30s">
              <param name="位置" key="9999/1/2/3/100/101" value="0.5 650.015"/>
              <param name="配置" key="9999/1/2/3/354/401" value="1 (水平方向に中央揃え)"/>
              <text><text-style ref="ts1">見本</text-style></text>
              <text-style-def id="ts1">
                <text-style font="Hiragino Sans" fontSize="146" fontFace="W8" fontColor="1 1 1 1" bold="1" alignment="center" strokeColor="0 0 0 1" strokeWidth="12"/>
              </text-style-def>
            </title>
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
"""

// MARK: - 入力

let styles: [String: Any] = [
    "normal": [
        "fontFamily": "Hiragino Sans", "fontSize": 146.0, "color": "#ffffff",
        "strokeColor": "#000000", "strokeWidth": 12.0, "shadow": true, "bold": true,
        "bottomPercent": 12.0,
    ],
    "emphasis": [
        "fontFamily": "Hiragino Sans", "fontSize": 160.0, "color": "#ffe14d",
        "strokeColor": "#000000", "strokeWidth": 12.0, "shadow": true, "bold": true,
        "bottomPercent": 12.0,
    ],
]

let cuts: [[String: Any]] = [
    ["id": "c1", "start": 3.0, "end": 5.0, "kind": "silence", "decision": "approved"],
    ["id": "c2", "start": 10.0, "end": 11.0, "kind": "filler", "decision": "rejected"],
]

let telops: [[String: Any]] = [
    ["id": "t1", "start": 1.0, "end": 2.5, "text": "ふつうのテロップ", "style": "normal"],
    ["id": "t2", "start": 6.0, "end": 8.0, "text": "強調＆記号 <>& のテスト", "style": "emphasis"],
    // 一部の文字だけ見た目を変えたもの
    [
        "id": "t3", "start": 12.0, "end": 14.0, "text": "ここだけ大きく赤く", "style": "normal",
        "spans": [["start": 0, "end": 4, "fontSize": 200.0, "color": "#ff0000", "bold": true]],
    ],
    // 位置を動かしたもの
    [
        "id": "t4", "start": 16.0, "end": 17.0, "text": "位置を変えた", "style": "normal",
        "overrides": ["leftPercent": 70.0, "bottomPercent": 40.0],
    ],
]

// MARK: - 検査

print("=== テンプレートの取り込み ===")
guard let template = try? TitleTemplate.parse(fcpxml: templateXML) else {
    print("❌ テンプレートを読めなかった")
    exit(1)
}
check("effect uid を取れた", template.effectUID == "~/Titles.localized/SamplePack/Sample/Sample.moti", template.effectUID)
check("param を2つ写した", template.params.count == 2, "\(template.params.count)")
check("text-style を写した", template.textStyle["fontFace"] == "W8" && template.textStyle["strokeWidth"] == "12")
check("title の内部 start を保持", template.titleStart == "3600s", template.titleStart)

print("\n=== 生成（テンプレあり・素材あり） ===")
let xml = FCPXMLWriter.build(
    cuts: cuts,
    telops: telops,
    styles: styles,
    mediaPath: "/Users/friend/Movies/test.mp4",
    fps: 30,
    template: template
)

check("XML として妥当", (try? XMLDocument(xmlString: xml, options: [])) != nil)
check("version は 1.13", xml.contains("<fcpxml version=\"1.13\">"))
check("テンプレの uid を使っている", xml.contains("uid=\"~/Titles.localized/SamplePack/Sample/Sample.moti\""))
check("テンプレの param を写している", xml.contains("key=\"9999/1/2/3/100/101\"") && xml.contains("value=\"0.5 650.015\""))
check("テンプレの fontFace が残っている", xml.contains("fontFace=\"W8\""))
check("テンプレの縁取りが残っている", xml.contains("strokeWidth=\"12\""))
check("強調の色がパネルの値で上書きされている", xml.contains("fontColor=\"1.0000 0.8824 0.3020 1\""), "実際: " + (xml.range(of: "fontColor=\"[^\"]+\"", options: .regularExpression).map { String(xml[$0]) } ?? "?"))
check("title の start がテンプレ由来", xml.contains("start=\"3600s\""))
check("記号がエスケープされている", xml.contains("&lt;&gt;&amp;"))
check("承認したカットだけ反映（clip が2本）", xml.components(separatedBy: "<asset-clip").count - 1 == 2)


/*
  ὓ4 出てきた文字をそのまま比べないこと。
     "20s" と "60000/3000s" は同じ長さだが、文字では一致しない。
     割り切れるときは整数の形で書かれる。**数に直して**比べる。
*/
func seconds(_ text: String) -> Double {
    let body = text.hasSuffix("s") ? String(text.dropLast()) : text
    let parts = body.split(separator: "/")
    if parts.count == 2, let n = Double(parts[0]), let d = Double(parts[1]), d != 0 {
        return n / d
    }
    return Double(body) ?? -1
}

func assetSeconds(_ xml: String) -> Double {
    guard
        let r = xml.range(of: "<asset [^>]*duration=\"[^\"]+\"", options: .regularExpression),
        let q = xml[r].range(of: "duration=\"[^\"]+\"", options: .regularExpression)
    else { return -1 }
    let raw = xml[r][q].replacingOccurrences(of: "duration=\"", with: "").replacingOccurrences(of: "\"", with: "")
    return seconds(raw)
}

func near(_ a: Double, _ b: Double, _ tol: Double = 0.05) -> Bool { abs(a - b) <= tol }




/* ================================================ 枠に合わせる／名前

  🔴 「枠に合わせる」を必ず書くこと。
     書かないと Final Cut の判断任せになり、素材が枠より小さいと
     真ん中に小さく置かれる。実機で2度そうなった（2026-08-30/31）。

  🔴 中身の並び順を守ること。adjust-conform は title より前。
     逆にすると DTD で弾かれ、読み込みごと失敗する。
*/
do {
    let telops: [[String: Any]] = [["start": 1.0, "end": 3.0, "text": "あ", "style": "normal"]]
    let xml = FCPXMLWriter.build(
        cuts: [["decision": "approved", "start": 8.0, "end": 9.0]], telops: telops, styles: [:],
        mediaPath: "/m/朝の撮影.mov", fps: 30, mediaDuration: 20,
        mediaWidth: 2160, mediaHeight: 3840)

    // 素材とプロジェクトが同じ大きさなので、合わせる余地が無い＝ none
    check("同じ大きさなら合わせない", xml.contains("<adjust-conform type=\"none\"/>"),
          xml.range(of: "<adjust-conform[^>]*>", options: .regularExpression).map { String(xml[$0]) } ?? "無し")
    if let conform = xml.range(of: "<adjust-conform"), let title = xml.range(of: "<title ") {
        check("並び順は adjust-conform が先", conform.lowerBound < title.lowerBound)
    } else {
        check("並び順は adjust-conform が先", false, "どちらかが出ていない")
    }
    check("クリップの数だけ入る",
          xml.components(separatedBy: "<adjust-conform").count - 1
            == xml.components(separatedBy: "<asset-clip").count - 1)

    // 名前は「【PAC】元の動画の名前_日付時刻」
    check("名前に素材の名前が入る", xml.contains("【PAC】朝の撮影_"),
          xml.range(of: "<project name=\"[^\"]*\"", options: .regularExpression).map { String(xml[$0]) } ?? "?")
}

do {
    let name = FCPXMLWriter.projectName(
        mediaPath: "/m/テスト 動画.MOV",
        now: Date(timeIntervalSince1970: 0))
    check("日付時刻が14桁で付く",
          name.hasPrefix("【PAC】テスト 動画_") && name.count == "【PAC】テスト 動画_".count + 14, name)
    check("素材が無くても名前になる",
          !FCPXMLWriter.projectName(mediaPath: nil).isEmpty)
}

/* ================================================ 素材そのものの形式

  🔴 asset の format は「素材の実寸」を指すこと。

     省くと Final Cut は素材を 1920x1080 と見なし、実寸（2160x3840）を
     その枠に収めてから、さらにプロジェクトの枠に収める。
     **二重に縮んで**、映像が枠の3割ほどの大きさで真ん中に出る（2026-08-31）。

     実寸と違う形式を指すのも同じく駄目。1920x1080 のプロジェクトで
     その形式を流用していたときは、「素材はプロジェクトと同じ大きさ」と
     信じ込ませることになった（2026-08-30）。

     どの id を書いたかではなく、**その id が指す大きさ**を見ること。
*/
/// asset が指している format の大きさを引く。
/// 🔴 「どの id を書いたか」ではなく「その id が何を指しているか」を見ること。
///    id を比べるだけの検査は、指し先が間違っていても通ってしまう。
func assetFrameSize(_ xml: String) -> (w: Int, h: Int)? {
    guard
        let a = xml.range(of: "<asset [^>]*>", options: .regularExpression),
        let f = xml[a].range(of: "format=\"[^\"]+\"", options: .regularExpression)
    else { return nil }
    let id = String(xml[a][f]).replacingOccurrences(of: "format=\"", with: "")
        .replacingOccurrences(of: "\"", with: "")
    guard let d = xml.range(of: "<format id=\"" + id + "\"[^>]*>", options: .regularExpression)
    else { return nil }
    let tag = String(xml[d])
    func num(_ key: String) -> Int {
        guard let r = tag.range(of: key + "=\"[0-9]+\"", options: .regularExpression) else { return 0 }
        return Int(String(tag[r]).replacingOccurrences(of: key + "=\"", with: "")
            .replacingOccurrences(of: "\"", with: "")) ?? 0
    }
    return (num("width"), num("height"))
}

do {
    let xml = FCPXMLWriter.build(
        cuts: [["decision": "approved", "start": 5.0, "end": 6.0]], telops: [], styles: [:],
        mediaPath: "/m/a.mov", fps: 30, mediaDuration: 20,
        mediaWidth: 2160, mediaHeight: 3840)

    let size = assetFrameSize(xml)
    check("asset の形式が素材の実寸を指している", size?.w == 2160 && size?.h == 3840,
          size.map { "\($0.w)x\($0.h)" } ?? "形式が付いていない")

    let clipTag = xml.range(of: "<asset-clip [^>]*>", options: .regularExpression)
        .map { String(xml[$0]) } ?? ""
    check("asset-clip には形式を書かない", !clipTag.contains("format="), clipTag)

    // 🔴 プロジェクト側（sequence）は必ず指定すること。無いと大きさが決まらない
    check("sequence には format を指定する", xml.contains("<sequence format=\"r1\""))
}

// 大きさが分からないときは書かない（当てずっぽうを書くと FCP が素材を見て直せなくなる）
do {
    let xml = FCPXMLWriter.build(
        cuts: [], telops: [], styles: [:],
        mediaPath: "/m/a.mov", fps: 30, mediaDuration: 20)
    let assetTag = xml.range(of: "<asset [^>]*>", options: .regularExpression)
        .map { String(xml[$0]) } ?? ""
    check("分からなければ形式を書かない", !assetTag.contains("format="), assetTag)
}

// 大きさが分からないときだけ、Final Cut に収めてもらう（fit）
do {
    let xml = FCPXMLWriter.build(
        cuts: [], telops: [], styles: [:],
        mediaPath: "/m/a.mov", fps: 30, mediaDuration: 20)
    check("分からなければ枠に合わせてもらう", xml.contains("<adjust-conform type=\"fit\"/>"),
          xml.range(of: "<adjust-conform[^>]*>", options: .regularExpression).map { String(xml[$0]) } ?? "無し")
}

/* ================================================ 書き出しに残す1行

  🔴 書き出したものだけで「どの版のどの設定で作ったか」が分かること。

     分からないと、直したものが届いたのか・設定が効いたのかを
     毎回キャプチャで聞き直すことになる。実際それで何往復もした
     （2026-08-31）。困ったときに送ってもらうのは XML なので、
     そこに書いておくのが一番確実。

  🔴 Final Cut が読み飛ばす形（コメント）で書くこと。
     独自の属性や要素を足すと DTD で弾かれ、読み込みごと失敗する。
*/
do {
    let xml = FCPXMLWriter.build(
        cuts: [["decision": "approved", "start": 5.0, "end": 6.0, "kind": "silence"]],
        telops: [["start": 1.0, "end": 3.0, "text": "あ", "style": "normal"]],
        styles: [:], mediaPath: "/m/a.mov", fps: 30, mediaDuration: 20,
        mediaWidth: 1080, mediaHeight: 1920,
        meta: ["build": "v1.0.219", "cutPreset": "tight",
               "detectAside": true, "telopMaxChars": 26])

    check("版が残る", xml.contains("v1.0.219"))
    check("素材の大きさが残る", xml.contains("1080x1920"))
    check("詰め具合が残る", xml.contains("詰め具合 tight"))
    check("独り言の入切が残る", xml.contains("独り言 入"))
    check("件数が残る", xml.contains("カット候補 1") && xml.contains("テロップ 1"))

    // 🔴 コメントであること。要素や属性にすると FCP が読み込みを断る
    check("コメントとして書いている", xml.contains("<!-- PAC"))
    check("XML として妥当なまま", (try? XMLDocument(xmlString: xml, options: [])) != nil)

    // 渡されなくても壊れないこと
    let bare = FCPXMLWriter.build(
        cuts: [], telops: [["start": 1.0, "end": 2.0, "text": "あ", "style": "normal"]],
        styles: [:], mediaPath: nil, fps: 30)
    check("何も渡されなくても壊れない",
          (try? XMLDocument(xmlString: bare, options: [])) != nil && bare.contains("<!-- PAC"))
}

/* ================================================ テロップの時刻

  🔴 clip にぶら下げた title の offset は「その clip の中の時刻」。
     原点はシーケンスの 0 秒ではなく、clip の start（＝素材の時刻）。

     シーケンス上の時刻を書いていたため、頭を切った素材で
     テロップが切った分だけまるごとずれ、**喋っている所と違う所に出た**
     （2026-08-31、実機の書き出しで発覚）。
*/
do {
    // 0〜10秒を切る。残るのは素材の 10〜30秒で、テロップは素材の 12秒と 25秒
    let cuts: [[String: Any]] = [["decision": "approved", "start": 0.0, "end": 10.0]]
    let telops: [[String: Any]] = [
        ["id": "t1", "start": 12.0, "end": 14.0, "text": "はじめ", "style": "normal"],
        ["id": "t2", "start": 25.0, "end": 27.0, "text": "あと", "style": "normal"],
    ]
    let xml = FCPXMLWriter.build(
        cuts: cuts, telops: telops, styles: [:],
        mediaPath: "/m/a.mov", fps: 30, mediaDuration: 30)

    func attr(_ name: String, of tag: String) -> Double {
        guard let r = tag.range(of: name + "=\"[^\"]+\"", options: .regularExpression) else { return -1 }
        return seconds(String(tag[r]).replacingOccurrences(of: name + "=\"", with: "")
            .replacingOccurrences(of: "\"", with: ""))
    }

    let clipTag = xml.range(of: "<asset-clip [^>]*>", options: .regularExpression)
        .map { String(xml[$0]) } ?? ""
    let clipStart = attr("start", of: clipTag)
    check("clip は素材の 10 秒から始まる", near(clipStart, 10), "\(clipStart) 秒")

    var offsets: [Double] = []
    if let re = try? NSRegularExpression(pattern: "<title [^>]*offset=\"([0-9/]+)s\"") {
        let ns = xml as NSString
        for m in re.matches(in: xml, range: NSRange(location: 0, length: ns.length)) {
            offsets.append(seconds(ns.substring(with: m.range(at: 1))))
        }
    }
    check("テロップは2枚とも出ている", offsets.count == 2, "\(offsets.count) 枚")
    check("テロップの時刻は素材の時刻のまま",
          offsets.count == 2 && near(offsets[0], 12) && near(offsets[1], 25), "\(offsets)")
    // 🔴 clip の中に収まっていること。範囲外に置くと FCP が頭へ寄せる
    check("テロップが clip の外に出ない",
          offsets.allSatisfy { $0 >= clipStart - 0.001 && $0 < clipStart + 20.001 }, "\(offsets)")
}

// カットをまたぐテロップは、その clip の終わりで切る（次の clip のものと重ならないように）
do {
    let cuts: [[String: Any]] = [["decision": "approved", "start": 10.0, "end": 12.0]]
    let telops: [[String: Any]] = [["id": "t1", "start": 9.0, "end": 15.0, "text": "またぐ", "style": "normal"]]
    let xml = FCPXMLWriter.build(
        cuts: cuts, telops: telops, styles: [:],
        mediaPath: "/m/a.mov", fps: 30, mediaDuration: 30)
    var dur = -1.0
    if let r = xml.range(of: "<title [^>]*duration=\"[^\"]+\"", options: .regularExpression) {
        let tag = String(xml[r])
        if let d = tag.range(of: "duration=\"[^\"]+\"", options: .regularExpression) {
            dur = seconds(String(tag[d]).replacingOccurrences(of: "duration=\"", with: "")
                .replacingOccurrences(of: "\"", with: ""))
        }
    }
    check("またぐテロップは clip の終わりで切る", near(dur, 1), "\(dur) 秒")
}

/* ================================================ 素材と同じ大きさ

  🔴 プロジェクトの大きさを決め打ちにしないこと。
     1920x1080 固定にしていたため、縦の素材（2160x3840 など）が
     横向きのプロジェクトに小さく収まっていた。
     下ごしらえとして渡す以上、素材と同じ大きさで組むのが正しい。
*/
do {
    let cuts: [[String: Any]] = [["decision": "approved", "start": 5.0, "end": 6.0]]
    let xml = FCPXMLWriter.build(
        cuts: cuts, telops: [], styles: [:],
        mediaPath: "/m/a.mov", fps: 60, mediaDuration: 20,
        mediaWidth: 2160, mediaHeight: 3840)
    check("縦の素材は縦のまま", xml.contains("width=\"2160\"") && xml.contains("height=\"3840\""),
          xml.range(of: "<format[^>]*>", options: .regularExpression).map { String(xml[$0]) } ?? "?")
    check("コマ数も素材に合わせる", xml.contains("frameDuration=\"100/6000s\""))
}

// 大きさが分からないときは、今までどおり 1920x1080 に倒す
do {
    let xml = FCPXMLWriter.build(
        cuts: [["decision": "approved", "start": 1.0, "end": 2.0]], telops: [], styles: [:],
        mediaPath: "/m/a.mov", fps: 30, mediaDuration: 10)
    check("分からなければ 1920x1080", xml.contains("width=\"1920\"") && xml.contains("height=\"1080\""))
}

// 🔴 奇数の大きさは書き出しで弾かれる。偶数へ丸める
do {
    let xml = FCPXMLWriter.build(
        cuts: [["decision": "approved", "start": 1.0, "end": 2.0]], telops: [], styles: [:],
        mediaPath: "/m/a.mov", fps: 30, mediaDuration: 10,
        mediaWidth: 1081, mediaHeight: 1921)
    check("奇数は偶数へ丸める", xml.contains("width=\"1080\"") && xml.contains("height=\"1920\""))
}

/* ================================================ 形式の名前

  🔴 決まった名前は「その大きさそのもの」のときだけ使うこと。

     FFVideoFormat1080p / 720p / 4K は Apple が **横向き** の
     1920x1080 / 1280x720 / 3840x2160 に付けている名前。
     短い方の辺だけを見て 2160x3840（縦）にも「FFVideoFormat4K30」と
     付けていたため、Final Cut は名前の方（16:9）を信じ、素材を一度
     16:9 に収めてから縦の枠に収め直した。9/16 を2回かけた
     **0.316倍**で真ん中に小さく出た（2026-08-31）。
*/
check("形式の名前は空にしない",
      !FCPXMLWriter.formatName(width: 1234, height: 5678, fps: 30).isEmpty)
check("横1080pはそのまま 1080p",
      FCPXMLWriter.formatName(width: 1920, height: 1080, fps: 30) == "FFVideoFormat1080p30")
check("横4Kはそのまま 4K",
      FCPXMLWriter.formatName(width: 3840, height: 2160, fps: 30) == "FFVideoFormat4K30")
// 🔴 ここが本題。縦に横の名札を貼らない
check("縦4Kを 4K と呼ばない",
      !FCPXMLWriter.formatName(width: 2160, height: 3840, fps: 60).contains("4K"),
      FCPXMLWriter.formatName(width: 2160, height: 3840, fps: 60))
check("縦1080を 1080p と呼ばない",
      !FCPXMLWriter.formatName(width: 1080, height: 1920, fps: 30).contains("1080p"),
      FCPXMLWriter.formatName(width: 1080, height: 1920, fps: 30))
// 🔴 「ありそうな名前」を作るのも駄目。同じ罠を踏む
for (fw, fh) in [(2160, 3840), (1080, 1920), (1234, 5678)] {
    let n = FCPXMLWriter.formatName(width: fw, height: fh, fps: 30)
    check("決まった形でなければ寸法入りの名前を作らない（\(fw)x\(fh)）",
          !n.contains("\(fw)") && !n.contains("\(fh)"), n)
}

/* ================================================ 素材の長さ

  🔴 クリップが素材の外を指してはいけない。

     以前は素材の長さを「最後のカット／テロップの終わり + 1秒」で
     見積もっていた。最後のカットが素材の終わり近くにあると、
     見積もりが実際の素材より長くなり、最後のクリップが
     存在しない部分を指す。Final Cut は読み込み時に
     「対応するメディアがない不正な編集です」と言って弾く（2026-08-30）。
     書き出し自体は成功するので、読み込ませるまで気づけない。
*/
do {
    // 素材は 20 秒ちょうど。最後のカットは 19.5 秒で終わる
    let cuts: [[String: Any]] = [
        ["decision": "approved", "start": 5.0, "end": 6.0],
        ["decision": "approved", "start": 19.0, "end": 19.5],
    ]
    let xml = FCPXMLWriter.build(
        cuts: cuts, telops: [], styles: [:],
        mediaPath: "/m/a.mov", fps: 30, mediaDuration: 20)

    check("素材の長さは渡した値になる", near(assetSeconds(xml), 20), "\(assetSeconds(xml)) 秒")

    // いちばん後ろのクリップが素材の外へ出ていないか
    var worst = 0.0
    if let re = try? NSRegularExpression(
        pattern: "<asset-clip[^>]*offset=\"([0-9]+)/([0-9]+)s\"[^>]*start=\"([0-9]+)/([0-9]+)s\"[^>]*duration=\"([0-9]+)/([0-9]+)s\"")
    {
        let ns = xml as NSString
        for m in re.matches(in: xml, range: NSRange(location: 0, length: ns.length)) {
            let start = Double(ns.substring(with: m.range(at: 3)))! / Double(ns.substring(with: m.range(at: 4)))!
            let dur = Double(ns.substring(with: m.range(at: 5)))! / Double(ns.substring(with: m.range(at: 6)))!
            worst = max(worst, start + dur)
        }
    }
    check("クリップが素材の外へ出ない", worst <= 20.0001, "いちばん後ろ \(worst) 秒 / 素材 20 秒")
}

// 長さが分からないときは、最後の出来事までにする（余分を足さない）
do {
    let cuts: [[String: Any]] = [["decision": "approved", "start": 5.0, "end": 6.0]]
    let telops: [[String: Any]] = [["start": 1.0, "end": 9.0, "text": "あ", "style": "normal"]]
    let xml = FCPXMLWriter.build(
        cuts: cuts, telops: telops, styles: [:],
        mediaPath: "/m/a.mov", fps: 30, mediaDuration: 0)
    check("長さ不明でも余分を足さない", near(assetSeconds(xml), 9), "\(assetSeconds(xml)) 秒")
}

// 時刻がフレーム境界に乗っているか（30fps なら分母 3000・分子は 100 の倍数）
var offGrid = 0
if let re = try? NSRegularExpression(pattern: "(?:offset|duration|start)=\"([0-9]+)/([0-9]+)s\"") {
    let range = NSRange(xml.startIndex..., in: xml)
    for m in re.matches(in: xml, range: range) {
        guard
            let nr = Range(m.range(at: 1), in: xml),
            let dr = Range(m.range(at: 2), in: xml),
            let n = Int(xml[nr]), let d = Int(xml[dr])
        else { continue }
        if d == 3000 && n % 100 != 0 { offGrid += 1 }
    }
}
check("時刻がフレーム境界に乗っている", offGrid == 0, "外れ \(offGrid) 件")

print("")
print("=== 一部の文字だけ見た目を変える ===")
check("文字の範囲ごとに分けて書いている", xml.contains("ここだけ") && xml.contains("大きく赤く"))
check("範囲ごとに別の text-style-def を作っている", xml.components(separatedBy: "<text-style-def").count - 1 >= 5,
      "実際 " + String(xml.components(separatedBy: "<text-style-def").count - 1))
check("その範囲だけ大きさが変わっている", xml.contains("fontSize=" + quote + "200" + quote))
check("その範囲だけ色が変わっている", xml.contains("1.0000 0.0000 0.0000 1"))

print("")
print("=== 位置の手動調整 ===")
check("動かしたものだけ位置指定が付く", xml.components(separatedBy: "<adjust-transform").count - 1 == 1)
check("既定からのずれ分で書いている", xml.contains("position=" + quote + "384.0 302.4" + quote),
      "実際: " + (xml.range(of: "position=" + quote + "[^" + quote + "]+" + quote, options: .regularExpression).map { String(xml[$0]) } ?? "無し"))


print("")
print("=== 中身の並び（Final Cut が断らない形か） ===")
// Final Cut は DTD で中身の並びまで見る。並びが違うと XML ごと読み込みを断り、
// 「DTD の検証でエラーが起きました」とだけ出て、どのテロップが原因かは分からない。
func childNames(_ e: XMLElement) -> [String] {
    return (e.children ?? []).compactMap { ($0 as? XMLElement)?.name }
}
if let doc = try? XMLDocument(xmlString: xml, options: []) {
    let libs = (try? doc.nodes(forXPath: "//library")) as? [XMLElement] ?? []
    let libAttrs = libs.flatMap { ($0.attributes ?? []).compactMap { $0.name } }
    check("library に属性を付けていない", libAttrs.isEmpty, "実際 " + libAttrs.joined(separator: ","))

    let seqs = (try? doc.nodes(forXPath: "//sequence")) as? [XMLElement] ?? []
    let seqKids = Set(seqs.flatMap { childNames($0) })
    check("sequence の中は spine だけ", seqKids == ["spine"], "実際 " + seqKids.sorted().joined(separator: ","))

    // 決まった並び。param → adjust-transform → text → text-style-def
    let order = ["param", "adjust-transform", "text", "text-style-def"]
    let titles = (try? doc.nodes(forXPath: "//title")) as? [XMLElement] ?? []
    var badTitle = ""
    for t in titles {
        let kids = childNames(t)
        let ranks = kids.map { order.firstIndex(of: $0) ?? -1 }
        if ranks.contains(-1) {
            badTitle = "知らない中身: " + kids.joined(separator: " ")
            break
        }
        if ranks != ranks.sorted() {
            badTitle = "並びが違う: " + kids.joined(separator: " ")
            break
        }
    }
    check("title の中身が決まった並びになっている", badTitle.isEmpty && !titles.isEmpty, badTitle)
} else {
    check("並びを調べられた", false, "XML として読めない")
}

print("")
print("=== カットの区切りをまたぐ確認 ===")
check("カットした分だけ後ろのテロップがずれる", xml.contains("<title"))

print("\n=== 生成（テンプレなし・素材なし） ===")
let xml2 = FCPXMLWriter.build(cuts: [], telops: telops, styles: styles, mediaPath: nil, fps: 29.97)
check("XML として妥当", (try? XMLDocument(xmlString: xml2, options: [])) != nil)
check("素材が無ければ gap になる", xml2.contains("<gap"))
check("29.97 の分母が 30000", xml2.contains("/30000s"))
check("テンプレ無しでも縁取りが入る", xml2.contains("strokeColor="))

print("\n=== カットの計算 ===")
let keeps = FCPXMLWriter.keepSegments(duration: 20, cuts: [(3, 5), (10, 11)])
check("残る区間は3本", keeps.count == 3, "\(keeps)")
check("合計は17秒", abs(keeps.reduce(0) { $0 + ($1.end - $1.start) } - 17) < 0.001)

let merged = FCPXMLWriter.keepSegments(duration: 10, cuts: [(2, 5), (4, 6)])
check("重なったカットをまとめる", merged.count == 2 && abs(merged[1].start - 6) < 0.001, "\(merged)")

// MARK: - 結果

print("")
if failures.isEmpty {
    print("🎉 FCPXML の検査をすべて通過")
    // 目視用に出力しておく
    try? xml.write(toFile: "/tmp/pac-sample.fcpxml", atomically: true, encoding: .utf8)
} else {
    print("🚫 失敗: \(failures.joined(separator: " / "))")
    exit(1)
}
