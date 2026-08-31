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

    /// FCP に見せる形式の名前。決まった形に当てはまるものは、その名前を使う。
    ///
    /// 🔴 当てはまらないときも何か名前を付けること。
    ///    空にすると Final Cut が形式を判別できず、読み込みで警告が出る。
    static func formatName(width: Int, height: Int, fps: Double) -> String {
        let r = Int(fps.rounded())
        // 縦横どちらでも、短い方の辺で「1080p」などと呼ぶのが FCP の流儀
        let shortSide = min(width, height)
        switch shortSide {
        case 1080: return "FFVideoFormat1080p\(r)"
        case 720: return "FFVideoFormat720p\(r)"
        case 2160: return "FFVideoFormat4K\(r)"
        default: return "FFVideoFormat\(width)x\(height)p\(r)"
        }
    }

    /// 書き出すプロジェクトの名前。「【PAC】元の動画の名前_日付時刻」。
    ///
    /// 🔴 固定の名前にしないこと。
    ///    何本も下ごしらえすると、Final Cut の中に同じ名前が並び、
    ///    どれがどの素材のものか分からなくなる。
    static func projectName(mediaPath: String?, now: Date = Date()) -> String {
        let stamp = DateFormatter()
        stamp.locale = Locale(identifier: "en_US_POSIX")
        stamp.dateFormat = "yyyyMMddHHmmss"
        let base = mediaPath.map {
            URL(fileURLWithPath: $0).deletingPathExtension().lastPathComponent
        } ?? "素材なし"
        return "【PAC】\(base)_\(stamp.string(from: now))"
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
        /// 素材の本当の長さ（秒）。0 なら分からない
        ///
        /// 🔴 見積もりで代用しないこと。
        ///    以前は「最後のカット／テロップの終わり + 1秒」を素材の長さとしていた。
        ///    最後のカットが素材の終わり近くにあると、この見積もりが
        ///    **実際の素材より長く**なり、最後のクリップが存在しない部分を指す。
        ///    Final Cut は読み込み時に
        ///    「対応するメディアがない不正な編集です」と言って弾く（2026-08-30に踏んだ）。
        mediaDuration: Double = 0,
        /// 素材の大きさ。0 なら分からない
        ///
        /// 🔴 決め打ちにしないこと。
        ///    1920x1080 固定にしていたため、縦の素材（2160x3840 など）が
        ///    横向きのプロジェクトに小さく収まっていた。
        ///    素材と同じ大きさで組むのが、下ごしらえとして正しい。
        mediaWidth: Int = 0,
        mediaHeight: Int = 0,
        template: TitleTemplate? = nil
    ) -> String {
        let (fdNum, fdDen) = frameDuration(fps: fps)
        let frameDur = "\(fdNum)/\(fdDen)s"
        /*
          プロジェクトの大きさ。
          🔴 素材と同じにすること。決め打ちにすると、
             縦の素材が横向きのプロジェクトに小さく収まる。
          🔴 偶数にすること。奇数の幅・高さは書き出しで弾かれる。
        */
        let w = mediaWidth > 0 ? (mediaWidth / 2) * 2 : 1920
        let h = mediaHeight > 0 ? (mediaHeight / 2) * 2 : 1080

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
        /*
          素材の長さ。
          🔴 分かっているならそれを使い、**それより長くしない**こと。
             超えた分は「素材の無い所」なので、Final Cut が読み込みを拒む。
          🔴 分からないときだけ見積もる。その場合も、
             最後の出来事ちょうどまでにして余分を足さない。
        */
        let guessed = max(telopEnd, cutEnd)
        let total = mediaDuration > 0 ? mediaDuration : guessed

        var xml = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE fcpxml>
        <fcpxml version="\(version)">
          <resources>
            <format id="r1" name="\(formatName(width: w, height: h, fps: fps))" frameDuration="\(frameDur)" width="\(w)" height="\(h)" colorSpace="1-1-1 (Rec. 709)"/>
            <effect id="r2" name="\(escape(template?.effectName ?? "Basic Title"))" uid="\(escape(template?.effectUID ?? ".../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti"))"/>

        """

        /*
          素材がある場合だけ asset を作る（無い場合はテロップだけの XML になる）。

          🔴 asset の format は「**素材の実寸**」を指すこと。
             プロジェクトの大きさではなく、素材そのものの大きさ。
             いまはプロジェクトを素材と同じ大きさで組んでいるので
             r1 がそのまま実寸を表すが、食い違う日が来たら別に書くこと。

             省くと Final Cut は素材を 1920x1080 と見なす。実際の素材
             （2160x3840）をその枠に収め、さらにその枠を 2160x3840 の
             プロジェクトに収める**二重の縮小**が起き、映像が枠の3割ほどの
             大きさで真ん中に出た（2026-08-31）。
             1080/3840 の縮小 → 2160/1920 の拡大 で、ちょうど 0.316 倍。

             逆に、実寸と違う形式を書くのも駄目。1920x1080 のプロジェクトに
             r1 を書いていたときは「素材はプロジェクトと同じ大きさだ」と
             信じ込ませることになった（2026-08-30に踏んだ）。
             どちらも「実寸を書く」で防げる。

          🔴 大きさが分からないときは書かないこと。
             当てずっぽうの数字を書くと、Final Cut が素材を見て直すこともできなくなる。
        */
        if let mediaPath, !mediaPath.isEmpty {
            let url = URL(fileURLWithPath: mediaPath)
            let mw = (mediaWidth / 2) * 2
            let mh = (mediaHeight / 2) * 2
            var assetFormat = ""
            if mw > 0, mh > 0 {
                if mw == w && mh == h {
                    // プロジェクトを素材と同じ大きさで組んでいるので、r1 が素材の実寸そのもの
                    assetFormat = " format=\"r1\""
                } else {
                    // 食い違うときは素材の側を別に書く（r1 を流用すると実寸を偽ることになる）
                    xml += """
                        <format id="r4" name="\(formatName(width: mw, height: mh, fps: fps))" frameDuration="\(frameDur)" width="\(mw)" height="\(mh)" colorSpace="1-1-1 (Rec. 709)"/>

                    """
                    assetFormat = " format=\"r4\""
                }
            }
            xml += """
                <asset id="r3" name="\(escape(url.deletingPathExtension().lastPathComponent))" start="0s" duration="\(time(total, fps: fps))"\(assetFormat) hasVideo="1" videoSources="1" hasAudio="1" audioSources="1" audioChannels="2">
                  <media-rep kind="original-media" src="\(escape(url.absoluteString))"/>
                </asset>

            """
        }
        xml += "  </resources>\n"

        xml += """
          <library>
            <event name="PAC">
              <project name="\(escape(projectName(mediaPath: mediaPath)))">
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
                        <asset-clip ref="r3" name="clip\(i + 1)" offset="\(time(offset, fps: fps))" start="\(time(seg.start, fps: fps))" duration="\(time(dur, fps: fps))" tcFormat="NDF">
                          <adjust-conform type="fit"/>

                """
                /*
                  この区間に入るテロップを、この clip にぶら下げる。

                  🔴 offset は「**この clip の中の時刻**」で書くこと。
                     clip にぶら下げたものの原点は、シーケンスの 0 秒ではなく
                     clip の start（＝素材の時刻）になる。
                     シーケンス上の時刻を書いていたため、頭を 11 秒切った素材で
                     テロップが**まるごと 11 秒ずれ**、喋っている所と
                     違う所に出ていた（2026-08-31）。素材の時刻をそのまま書けばよい。

                  🔴 clip の終わりで切ること。
                     はみ出した分は、次の clip のテロップと重なって2枚同時に出る。
                */
                for t in telops {
                    guard
                        let s = t["start"] as? Double,
                        let e = t["end"] as? Double,
                        s >= seg.start, s < seg.end
                    else { continue }
                    let oneFrame = Double(fdNum) / Double(fdDen)
                    let shown = max(min(e, seg.end) - s, oneFrame)
                    xml += titleElement(t, styles: styles, offsetSec: s, durationSec: shown, fps: fps, template: template, indent: "          ")
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
        let baseStyle = (styles[styleName] as? [String: Any]) ?? [:]
        let overrides = (telop["overrides"] as? [String: Any]) ?? [:]
        var style = baseStyle
        for (k, v) in overrides { style[k] = v }

        let spans = (telop["spans"] as? [[String: Any]]) ?? []
        let runs = splitRuns(text: text, spans: spans)
        let idBase = "ts\(abs(text.hashValue % 100000))_\(Int(offsetSec * 1000))"

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

        // 位置を動かしている場合だけ、既定からのずれ分を足す。
        // テンプレ自身の位置指定を壊さないよう、絶対位置ではなく差分で書く。
        //
        // 🔴 param のすぐ後、text より前に置くこと。
        //    title の中身の並びは決まっていて（param → adjust-transform → text →
        //    text-style-def）、後ろに回すと Final Cut が読み込みを丸ごと断る。
        if let transform = positionOffset(base: baseStyle, overrides: overrides) {
            s += "\(indent)  <adjust-transform position=\"\(transform)\"/>\n"
        }

        // 本文。一部だけ見た目を変えている場合は、その範囲ごとに分けて書く
        s += "\(indent)  <text>\n"
        for (i, run) in runs.enumerated() {
            s += "\(indent)    <text-style ref=\"\(idBase)_\(i)\">\(escape(run.text))</text-style>\n"
        }
        s += "\(indent)  </text>\n"

        for (i, run) in runs.enumerated() {
            var runStyle = style
            if let size = run.fontSize { runStyle["fontSize"] = size }
            if let color = run.color { runStyle["color"] = color }
            if let bold = run.bold { runStyle["bold"] = bold }
            s += "\(indent)  <text-style-def id=\"\(idBase)_\(i)\">\n"
            s += "\(indent)    <text-style \(textStyleAttributes(style: runStyle, template: template))/>\n"
            s += "\(indent)  </text-style-def>\n"
        }

        s += "\(indent)</title>\n"
        return s
    }

    /// 一部だけ見た目を変える指定を、書き出せる「連なり」に分ける
    struct Run {
        var text: String
        var fontSize: Double?
        var color: String?
        var bold: Bool?
    }

    static func splitRuns(text: String, spans: [[String: Any]]) -> [Run] {
        let chars = Array(text)
        guard !chars.isEmpty else { return [Run(text: "", fontSize: nil, color: nil, bold: nil)] }
        if spans.isEmpty { return [Run(text: text, fontSize: nil, color: nil, bold: nil)] }

        let sorted = spans.compactMap { s -> (Int, Int, [String: Any])? in
            guard let a = s["start"] as? Int ?? (s["start"] as? Double).map({ Int($0) }),
                  let b = s["end"] as? Int ?? (s["end"] as? Double).map({ Int($0) })
            else { return nil }
            return (max(0, a), min(chars.count, b), s)
        }
        .filter { $0.1 > $0.0 }
        .sorted { $0.0 < $1.0 }

        var runs: [Run] = []
        var cursor = 0
        for (a, b, s) in sorted {
            if a > cursor {
                runs.append(Run(text: String(chars[cursor..<a]), fontSize: nil, color: nil, bold: nil))
            }
            runs.append(Run(
                text: String(chars[a..<b]),
                fontSize: (s["fontSize"] as? Double) ?? (s["fontSize"] as? Int).map(Double.init),
                color: s["color"] as? String,
                bold: s["bold"] as? Bool
            ))
            cursor = b
        }
        if cursor < chars.count {
            runs.append(Run(text: String(chars[cursor...]), fontSize: nil, color: nil, bold: nil))
        }
        return runs
    }

    /// 既定の位置からどれだけ動かしたか。1920x1080 の画素で返す（中心が原点・上が+）
    static func positionOffset(base: [String: Any], overrides: [String: Any]) -> String? {
        let baseLeft = (base["leftPercent"] as? Double) ?? 50
        let baseBottom = (base["bottomPercent"] as? Double) ?? 12
        guard overrides["leftPercent"] != nil || overrides["bottomPercent"] != nil else { return nil }
        let left = (overrides["leftPercent"] as? Double) ?? baseLeft
        let bottom = (overrides["bottomPercent"] as? Double) ?? baseBottom
        let dx = (left - baseLeft) / 100 * 1920
        let dy = (bottom - baseBottom) / 100 * 1080
        if abs(dx) < 0.5 && abs(dy) < 0.5 { return nil }
        return String(format: "%.1f %.1f", dx, dy)
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
