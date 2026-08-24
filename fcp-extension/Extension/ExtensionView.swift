//
//  ExtensionView.swift
//  PAC Workflow Extension
//
//  M1（疎通確認）用の最小 UI。ここが FCP の中に出れば実験は成功。
//

import SwiftUI

struct ExtensionView: View {
    let hostDescription: String

    var body: some View {
        VStack(spacing: 16) {
            Text("PAC")
                .font(.system(size: 40, weight: .bold))

            Text("Final Cut Pro の中で動いています")
                .font(.headline)

            GroupBox {
                VStack(alignment: .leading, spacing: 6) {
                    Label(hostDescription, systemImage: "checkmark.seal")
                    Label(versionLine, systemImage: "number")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(6)
            }

            Text("この画面が見えたら成功です。\nスクリーンショットを撮って送ってください。")
                .font(.callout)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var versionLine: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "PAC 拡張 \(short) (\(build))"
    }
}
