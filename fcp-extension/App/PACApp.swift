//
//  PACApp.swift
//  PAC（コンテナアプリ）
//
//  役目は2つ。
//   1. Workflow Extension の入れ物（/Applications に置くと macOS が拡張を登録する）
//   2. 解析エンジンを動かす係（パネルはサンドボックスの中なので自分では回せない）
//

import SwiftUI

@main
struct PACApp: App {
    init() {
        // パネルからの注文をいつでも受けられるようにしておく
        EngineServer.shared.start()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .frame(width: 520, height: 380)
        }
        .windowResizability(.contentSize)
    }
}

struct ContentView: View {
    private let missing = EnginePaths.missing()

    var body: some View {
        VStack(spacing: 14) {
            Text("PAC")
                .font(.system(size: 36, weight: .bold))
            Text("Final Cut Pro 用プラグイン")
                .font(.headline)

            Divider()

            if missing.isEmpty {
                Label("解析の準備ができています", systemImage: "checkmark.circle")
                    .foregroundStyle(.green)
            } else {
                Label("同梱物が足りません：\(missing.joined(separator: " / "))", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("使い方")
                    .font(.subheadline).bold()
                Text("1. このアプリは開いたままにしておく（解析はここで動きます）")
                Text("2. Final Cut Pro を起動する")
                Text("3. メニューの「ウィンドウ」→「エクステンション」→「PAC」")
            }
            .font(.callout)
            .frame(maxWidth: .infinity, alignment: .leading)

            Text("初回だけ、文字起こしのモデル（約1.6GB）のダウンロードが走ります。")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(24)
    }
}
