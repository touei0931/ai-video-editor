//
//  PACApp.swift
//  PAC for Final Cut（コンテナアプリ）
//
//  役目は2つ。
//   1. Workflow Extension の入れ物
//      （/Applications に置くと macOS が拡張を登録する。これは省けない）
//   2. 解析エンジンを動かす係
//      （パネルはサンドボックスの中なので、Python も ffmpeg も自分では回せない）
//
//  🔴 人が開くアプリではない。
//     Dock にも出さず、窓も出さない（Info.plist の LSUIElement）。
//     必要になった時にパネルが pac-fcp:// で起こす。
//     以前は「使う前にこのアプリを開いてください」と手順書に書いていたが、
//     デスクトップ版 PAC と名前が同じだったこともあり、
//     **別のアプリを開かれて話が食い違った**。開かせないのが一番確実。
//
//  🔴 例外は「同梱物が足りないとき」だけ。
//     エンジンや ffmpeg が入っていない状態は、パネル側からは
//     「アプリが起動していない」と見分けが付かない。ここは姿を見せて理由を出す。
//

import SwiftUI
import AppKit

@main
struct PACApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        // 🔴 WindowGroup を置かないこと。置くと起こされるたびに窓が出る。
        //    Settings は開かれるまで窓を作らないので、裏方の器として使える。
        Settings { EmptyView() }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {

    private var troubleWindow: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // パネルからの注文をいつでも受けられるようにしておく
        EngineServer.shared.start()

        let missing = EnginePaths.missing()
        if !missing.isEmpty {
            showTrouble(missing)
        }
    }

    /// 窓を閉じても終わらない。閉じた後もパネルからの注文を受ける。
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    /// pac-fcp:// で起こされたときに来る。起きること自体が目的なので何もしない。
    func application(_ application: NSApplication, open urls: [URL]) {
        _ = urls
    }

    private func showTrouble(_ missing: [String]) {
        // 裏方のままだと窓を前に出せないので、この時だけ普通のアプリに戻す
        NSApp.setActivationPolicy(.regular)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 240),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "PAC for Final Cut"
        window.contentView = NSHostingView(rootView: TroubleView(missing: missing))
        window.center()
        window.isReleasedWhenClosed = false
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        troubleWindow = window
    }
}

private struct TroubleView: View {
    let missing: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("同梱物が足りません", systemImage: "exclamationmark.triangle")
                .font(.headline)
                .foregroundStyle(.orange)

            Text(missing.joined(separator: "\n"))
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)

            Divider()

            Text("入れ直すと直ることがあります。zip を展開し直して、"
                 + "「インストールと確認」をもう一度実行してください。")
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)

            Spacer()
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
