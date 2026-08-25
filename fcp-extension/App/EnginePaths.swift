//
//  EnginePaths.swift
//  PAC（コンテナアプリ）
//
//  同梱物の置き場所を知っているのは、このファイルだけにする。
//
//  🔴 PAC 本体で踏んだ罠の予防:
//     サイドカーが ffmpeg を「実行ファイルの隣」で探していたが、実際の置き場所は別だった。
//     手元では**リポジトリの中から**起動していたため気づかず、配布した形で初めて壊れた。
//     置き場所を複数の場所に散らかすと、必ずどこかがずれる。
//

import Foundation

enum EnginePaths {

    /// PAC.app/Contents/Resources
    static var resources: URL {
        Bundle.main.resourceURL ?? Bundle.main.bundleURL
    }

    /// 解析エンジン（PyInstaller で固めたもの）
    static var engine: URL {
        resources.appendingPathComponent("engine/pac-engine/pac-engine")
    }

    /// 同梱の ffmpeg（LGPL ビルド。Homebrew に依存しないもの）
    static var ffmpeg: URL {
        resources.appendingPathComponent("ffmpeg/ffmpeg")
    }

    /// 解析結果の置き場所。パネル（サンドボックス内）からは読めないので、
    /// 中身は返事に載せて渡す。
    static var work: URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pac-fcp", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// 同梱物がそろっているか。足りないものを日本語で返す
    static func missing() -> [String] {
        var out: [String] = []
        if !FileManager.default.isExecutableFile(atPath: engine.path) {
            out.append("解析エンジン（\(engine.lastPathComponent)）")
        }
        if !FileManager.default.isExecutableFile(atPath: ffmpeg.path) {
            out.append("ffmpeg")
        }
        return out
    }
}
