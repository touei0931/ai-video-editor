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
        fps: Double
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
            <effect id="r2" name="Basic Title" uid=".../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti"/>

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
                    xml += titleElement(t, styles: styles, offsetSec: offset + (s - seg.start), durationSec: max(e - s, Double(fdNum) / Double(fdDen)), fps: fps, indent: "          ")
                }
                xml += "        </asset-clip>\n"
                offset += dur
            }
        } else {
            xml += "        <gap name=\"Gap\" offset=\"0s\" start=\"0s\" duration=\"\(time(total, fps: fps))\">\n"
            for t in telops {
                guard let s = t["start"] as? Double, let e = t["end"] as? Double else { continue }
                xml += titleElement(t, styles: styles, offsetSec: s, durationSec: max(e - s, Double(fdNum) / Double(fdDen)), fps: fps, indent: "          ")
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
        indent: String
    ) -> String {
        let text = (telop["text"] as? String) ?? ""
        let styleName = (telop["style"] as? String) ?? "normal"
        let style = (styles[styleName] as? [String: Any]) ?? [:]

        let font = (style["fontFamily"] as? String) ?? "ヒラギノ角ゴシック W6"
        let size = (style["fontSize"] as? Double) ?? 48
        let color = rgba(from: (style["color"] as? String) ?? "#ffffff")
        let strokeColor = rgba(from: (style["strokeColor"] as? String) ?? "#000000")
        let strokeWidth = (style["strokeWidth"] as? Double) ?? 6
        let bold = (style["bold"] as? Bool) ?? false
        let shadow = (style["shadow"] as? Bool) ?? true

        let styleId = "ts\(abs(text.hashValue % 100000))_\(Int(offsetSec * 1000))"

        var s = """
        \(indent)<title ref="r2" lane="1" offset="\(time(offsetSec, fps: fps))" name="\(escape(text))" start="0s" duration="\(time(durationSec, fps: fps))">
        \(indent)  <text>
        \(indent)    <text-style ref="\(styleId)">\(escape(text))</text-style>
        \(indent)  </text>
        \(indent)  <text-style-def id="\(styleId)">
        \(indent)    <text-style font="\(escape(font))" fontSize="\(Int(size))" fontColor="\(color)" alignment="center"\(bold ? " bold=\"1\"" : "") strokeColor="\(strokeColor)" strokeWidth="\(strokeWidth)"
        """
        if shadow {
            s += " shadowColor=\"0 0 0 0.75\" shadowOffset=\"20 315\""
        }
        s += """
        />
        \(indent)  </text-style-def>
        \(indent)</title>

        """
        return s
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
