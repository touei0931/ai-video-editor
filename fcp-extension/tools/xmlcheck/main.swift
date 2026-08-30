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



/* ================================================ 素材の大きさは決め打ちしない

  🔴 asset に format を書かないこと。

     あそこは「素材そのものの大きさ」を指す所で、プロジェクトの大きさを
     書くと、FCP は「この素材はプロジェクトと同じ大きさだ」と信じ込み、
     拡大せずそのまま置く。実際の素材がそれより小さいと
     **真ん中に小さく出る**（2026-08-30に踏んだ）。
     書かなければ FCP が素材そのものを見て、枠に合わせて収めてくれる。
*/
do {
    let xml = FCPXMLWriter.build(
        cuts: [["decision": "approved", "start": 5.0, "end": 6.0]], telops: [], styles: [:],
        mediaPath: "/m/a.mov", fps: 30, mediaDuration: 20,
        mediaWidth: 2160, mediaHeight: 3840)

    let assetTag = xml.range(of: "<asset [^>]*>", options: .regularExpression)
        .map { String(xml[$0]) } ?? ""
    check("asset に format を決め打ちしない", !assetTag.contains("format="), assetTag)

    let clipTag = xml.range(of: "<asset-clip [^>]*>", options: .regularExpression)
        .map { String(xml[$0]) } ?? ""
    check("asset-clip にも決め打ちしない", !clipTag.contains("format="), clipTag)

    // 🔴 プロジェクト側（sequence）は逆に必ず指定すること。無いと大きさが決まらない
    check("sequence には format を指定する", xml.contains("<sequence format=\"r1\""))
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

// 形式の名前は空にしない（空だと FCP が形式を判別できず警告になる）
check("見慣れない大きさでも名前が付く",
      !FCPXMLWriter.formatName(width: 1234, height: 5678, fps: 30).isEmpty)
check("縦4Kは 4K と呼ぶ",
      FCPXMLWriter.formatName(width: 2160, height: 3840, fps: 60) == "FFVideoFormat4K60")

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
