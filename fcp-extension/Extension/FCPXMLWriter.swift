//
//  FCPXMLWriter.swift
//  PAC Workflow Extension
//
//  パネルの状態から FCPXML を組み立てる。
//
//  重要な前提（AutoTelop で確定済み）:
//  - FCP は自分より新しい FCPXML を弾く。FCP 11/12 は 1.13 なので **1.13 固定**。
//  - 時刻は必ずフレーム境界にスナップし "num/den s" の有理数秒で書く。
//  - テロップの見た目は自作再現できない。友達のテンプレの effect uid と
//    text-style をそのまま写すのが唯一の正解。テンプレが無い場合は
//    Basic Title に落とすが、見た目は一致しない。
//

import Foundation

enum FCPXMLWriter {

    /// FCPXML のバージョン。上げてはいけない（FCP 12 = 1.13）
    static let version = "1.13"

    // MARK: - 時刻

    /// 秒 -> フレーム境界にスナップした "num/den s"
    static func time(_ seconds: Double, fps: Double) -> String {
        guard seconds > 0 else { return "0s" }
        let (num, den) = frameDuration(fps: fps)
        let frames = Int((seconds * Double(den) / Double(num)).rounded())
        let n = num * frames
        return n % den == 0 ? "\(n / den)s" : "\(n)/\(den)s"
    }

    /// fps -> 1フレームの長さ（num/den 秒）。29.97 等の実数 fps を正しく表す
    static func frameDuration(fps: Double) -> (num: Int, den: Int) {
        switch (fps * 100).rounded() / 100 {
        case 23.98, 23.976: return (1001, 24000)
        case 24: return (100, 2400)
        case 25: return (100, 2500)
        case 29.97: return (1001, 30000)
        case 50: return (100, 5000)
        case 59.94: return (1001, 60000)
        case 60: return (100, 6000)
        default: return (100, Int((fps * 100).rounded()))
        }
    }

    // MARK: - カット

    /// カット区間を除いた「残す区間」を求める
    static func keepSegments(duration: Double, cuts: [(start: Double, end: Double)]) -> [(start: Double, end: Double)] {
        let sorted = cuts.sorted { $0.start < $1.start }
        var keeps: [(Double, Double)] = []
        var cursor = 0.0
        for cut in sorted {
            let s = max(cursor, cut.start)
            if s > cursor { keeps.append((cursor, s)) }
            cursor = max(cursor, cut.end)
        }
        if cursor < duration { keeps.append((cursor, duration)) }
        return keeps.filter { $0.1 - $0.0 > 0.001 }
    }

    // MARK: - 組み立て

    static func build(
        cuts: [[String: Any]],
        telops: [[String: Any]],
        styles: [String: Any],
        mediaPath: String?,
        fps: Double,
        template: TitleTemplate? = nil
    ) -> String {
        let (fdNum, fdDen) = frameDuration(fps: fps)
        let frameDur = "\(fdNum)/\(fdDen)s"

        let approvedCuts: [(start: Double, end: Double)] = cuts.compactMap { c in
            guard
                (c["decision"] as? String) == "approved",
                let s = c["start"] as? Double,
                let e = c["end"] as? Double
            else { return nil }
            return (s, e)
        }

        let telopEnd = telops.compactMap { $0["end"] as? Double }.max() ?? 0
        let cutEnd = cuts.compactMap { $0["end"] as? Double }.max() ?? 0
        let total = max(telopEnd, cutEnd) + 1

        var xml = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE fcpxml>
        <fcpxml version="\(version)">
          <resources>
            <format id="r1" name="FFVideoFormat1080p\(Int(fps.rounded()))" frameDuration="\(frameDur)" width="1920" height="1080" colorSpace="1-1-1 (Rec. 709)"/>
            <effect id="r2" name="\(escape(template?.effectName ?? "Basic Title"))" uid="\(escape(template?.effectUID ?? ".../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti"))"/>

        """

        // 素材がある場合だけ asset を作る（無い場合はテロップだけの XML になる）
        if let mediaPath, !mediaPath.isEmpty {
            let url = URL(fileURLWithPath: mediaPath)
            xml += """
                <asset id="r3" name="\(escape(url.deletingPathExtension().lastPathComponent))" start="0s" duration="\(time(total, fps: fps))" hasVideo="1" hasAudio="1" format="r1">
                  <media-rep kind="original-media" src="\(escape(url.absoluteString))"/>
                </asset>

            """
        }
        xml += "  </resources>\n"

        xml += """
          <library>
            <event name="PAC">
              <project name="PAC 下ごしらえ">
                <sequence format="r1" duration="\(time(total, fps: fps))" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
                  <spine>

        """

        // 本体（カット済みの映像、または空の gap）
        if let mediaPath, !mediaPath.isEmpty {
            _ = mediaPath
            let keeps = approvedCuts.isEmpty
                ? [(start: 0.0, end: total)]
                : keepSegments(duration: total, cuts: approvedCuts)
            var offset = 0.0
            for (i, seg) in keeps.enumerated() {
                let dur = seg.end - seg.start
                xml += """
                        <asset-clip ref="r3" name="clip\(i + 1)" offset="\(time(offset, fps: fps))" start="\(time(seg.start, fps: fps))" duration="\(time(dur, fps: fps))" format="r1" tcFormat="NDF">

                """
                // この区間に入るテロップを、この clip にぶら下げる
                for t in telops {
                    guard
                        let s = t["start"] as? Double,
                        let e = t["end"] as? Double,
                        s >= seg.start, s < seg.end
                    else { continue }
                    xml += titleElement(t, styles: styles, offsetSec: offset + (s - seg.start), durationSec: max(e - s, Double(fdNum) / Double(fdDen)), fps: fps, template: template, indent: "          ")
                }
                xml += "        </asset-clip>\n"
                offset += dur
            }
        } else {
            xml += "        <gap name=\"Gap\" offset=\"0s\" start=\"0s\" duration=\"\(time(total, fps: fps))\">\n"
            for t in telops {
                guard let s = t["start"] as? Double, let e = t["end"] as? Double else { continue }
                xml += titleElement(t, styles: styles, offsetSec: s, durationSec: max(e - s, Double(fdNum) / Double(fdDen)), fps: fps, template: template, indent: "          ")
            }
            xml += "        </gap>\n"
        }

        xml += """
                  </spine>
                </sequence>
              </project>
            </event>
          </library>
        </fcpxml>

        """
        return xml
    }

    // MARK: - タイトル

    private static func titleElement(
        _ telop: [String: Any],
        styles: [String: Any],
        offsetSec: Double,
        durationSec: Double,
        fps: Double,
        template: TitleTemplate?,
        indent: String
    ) -> String {
        let text = (telop["text"] as? String) ?? ""
        let styleName = (telop["style"] as? String) ?? "normal"
        let style = (styles[styleName] as? [String: Any]) ?? [:]
        let styleId = "ts\(abs(text.hashValue % 100000))_\(Int(offsetSec * 1000))"

        // テンプレがある場合、title の内部 start はテンプレのものに合わせる
        // （Motion テンプレは 3600s のことが多く、ここを変えると表示が壊れる）
        let titleStart = template?.titleStart ?? "0s"

        var s = """
        \(indent)<title ref="r2" lane="1" offset="\(time(offsetSec, fps: fps))" name="\(escape(text))" start="\(titleStart)" duration="\(time(durationSec, fps: fps))">

        """

        // テンプレの param（位置・配置など）をそのまま写す。DTD 上 param は先頭
        if let template {
            for p in template.params {
                s += "\(indent)  <param name=\"\(escape(p.name))\" key=\"\(escape(p.key))\" value=\"\(escape(p.value))\"/>\n"
            }
        }

        s += """
        \(indent)  <text>
        \(indent)    <text-style ref="\(styleId)">\(escape(text))</text-style>
        \(indent)  </text>
        \(indent)  <text-style-def id="\(styleId)">
        \(indent)    <text-style \(textStyleAttributes(style: style, template: template))/>
        \(indent)  </text-style-def>
        \(indent)</title>

        """
        return s
    }

    /// テンプレの text-style を土台に、パネルで変えた分（フォント・大きさ・色・太字）だけ上書きする。
    /// 縁取り・影・その他はテンプレの値をそのまま残す。テンプレが無ければパネルの値だけで組む。
    static func textStyleAttributes(style: [String: Any], template: TitleTemplate?) -> String {
        var attrs: [String: String] = template?.textStyle ?? [:]

        if attrs.isEmpty {
            attrs["alignment"] = "center"
            attrs["strokeColor"] = rgba(from: (style["strokeColor"] as? String) ?? "#000000")
            attrs["strokeWidth"] = String(format: "%g", (style["strokeWidth"] as? Double) ?? 6)
            if (style["shadow"] as? Bool) ?? true {
                attrs["shadowColor"] = "0 0 0 0.75"
                attrs["shadowOffset"] = "20 315"
            }
        }

        if let family = style["fontFamily"] as? String, !family.isEmpty {
            // テンプレと違うフォントを選んだときは fontFace（W8 等）を持ち越さない
            if attrs["font"] != family {
                attrs["font"] = family
                attrs.removeValue(forKey: "fontFace")
            }
        }
        if let size = style["fontSize"] as? Double, size > 0 {
            attrs["fontSize"] = String(Int(size))
        }
        if let color = style["color"] as? String {
            attrs["fontColor"] = rgba(from: color)
        }
        if let bold = style["bold"] as? Bool {
            if bold { attrs["bold"] = "1" } else { attrs.removeValue(forKey: "bold") }
        }

        return attrs
            .sorted { $0.key < $1.key }
            .map { "\($0.key)=\"\(escape($0.value))\"" }
            .joined(separator: " ")
    }

    // MARK: - 小物

    /// #rrggbb -> FCP の "r g b a"（0〜1）
    static func rgba(from hex: String) -> String {
        var h = hex.trimmingCharacters(in: .whitespaces)
        if h.hasPrefix("#") { h.removeFirst() }
        guard h.count == 6, let v = Int(h, radix: 16) else { return "1 1 1 1" }
        let r = Double((v >> 16) & 0xff) / 255
        let g = Double((v >> 8) & 0xff) / 255
        let b = Double(v & 0xff) / 255
        return String(format: "%.4f %.4f %.4f 1", r, g, b)
    }

    static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }
}
