//
//  PACApp.swift
//  PAC（コンテナアプリ）
//
//  Workflow Extension は単体では配れない。この .app の Contents/PlugIns に
//  同梱して /Applications に置くことで、macOS の PluginKit が拡張を登録する。
//  このアプリ自体は「一度起動して登録させる」ための入れ物。
//

import SwiftUI

@main
struct PACApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .frame(width: 460, height: 320)
        }
        .windowResizability(.contentSize)
    }
}

struct ContentView: View {
    var body: some View {
        VStack(spacing: 14) {
            Text("PAC")
                .font(.system(size: 36, weight: .bold))
            Text("Final Cut Pro 用プラグイン（動作テスト版）")
                .font(.headline)

            Divider()

            VStack(alignment: .leading, spacing: 8) {
                Text("この画面が出ていれば準備完了です。")
                Text("1. このアプリを開いたまま、Final Cut Pro を起動")
                Text("2. メニューの「ウィンドウ」→「エクステンション」")
                Text("3. 「PAC」があるか確認")
            }
            .font(.callout)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(24)
    }
}
