//
//  PanelData.swift
//  PAC Workflow Extension
//
//  UI(React) に渡す JSON を組み立てるところ。
//  webui/src/lib/types.ts の型と対応させること。
//

import Cocoa
import AVFoundation
import ProExtensionHost

enum PanelData {

    /// UI の初期状態。
    /// 素材の解析結果（波形・カット候補・テロップ）はエンジン側の仕事なのでまだ空。
    /// ここでは FCP から読める本物の情報だけを詰める。
    static func project(host: FCPXHost?) -> [String: Any] {
        var duration: Double = 0
        var info: [String: Any] = [:]

        if let host {
            info["hostName"] = host.name
            info["hostVersion"] = host.versionString
            info["hostBundleId"] = host.bundleIdentifier

            if let timeline = host.timeline {
                let range = timeline.sequenceTimeRange
                let seconds = CMTimeGetSeconds(range.duration)
                if seconds.isFinite && seconds > 0 { duration = seconds }
                info["playheadSec"] = CMTimeGetSeconds(timeline.playheadTime())  // ヘッダ上メソッド

                if let seq = timeline.activeSequence {
                    info["sequenceName"] = seq.name
                    let fd = CMTimeGetSeconds(seq.frameDuration)
                    if fd > 0 { info["fps"] = (1.0 / fd).rounded() }
                    if let project = seq.container as? FCPXProject {
                        info["projectName"] = project.name
                    }
                }
            }
        }

        return [
            "videoUrl": NSNull(),
            "durationSec": duration > 0 ? duration : 60,
            "waveform": [Double](),
            "cuts": [[String: Any]](),
            "telops": [[String: Any]](),
            "styles": defaultStyles(),
            "fonts": fontFamilies(),
            "host": info,
        ]
    }

    /// macOS のフォント一覧。サンドボックス内でも取得できる。
    /// 日本語フォントを上に寄せておく（テロップで使うのはほぼこちらのため）。
    static func fontFamilies() -> [String] {
        let all = NSFontManager.shared.availableFontFamilies
        let japanese = all.filter { name in
            name.contains("ヒラギノ") || name.contains("Hiragino") || name.contains("Noto Sans")
                || name.contains("Osaka") || name.contains("游") || name.contains("YuGothic")
                || name.contains("Klee") || name.contains("Toppan")
        }
        let rest = all.filter { !japanese.contains($0) }
        return japanese.sorted() + rest.sorted()
    }

    static func defaultStyles() -> [String: Any] {
        [
            "normal": [
                "fontFamily": "ヒラギノ角ゴシック W6",
                "fontSize": 48,
                "color": "#ffffff",
                "strokeColor": "#000000",
                "strokeWidth": 6,
                "shadow": true,
                "bold": false,
                "bottomPercent": 12,
            ],
            "emphasis": [
                "fontFamily": "ヒラギノ角ゴシック W8",
                "fontSize": 60,
                "color": "#ffe14d",
                "strokeColor": "#000000",
                "strokeWidth": 8,
                "shadow": true,
                "bold": true,
                "bottomPercent": 12,
            ],
        ]
    }
}
