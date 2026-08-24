//
//  WorkflowExtensionViewController.swift
//  PAC Workflow Extension
//
//  FCP が Info.plist の ProExtensionPrincipalViewControllerClass を見て
//  このクラスを生成し、FCP のウィンドウ内にパネルとして表示する。
//

import Cocoa
import SwiftUI
import ProExtensionHost

@objc class WorkflowExtensionViewController: NSViewController {

    /// FCP 本体（ホスト）に喋りかけられているかの確認用。
    /// ここが取れれば「登録された」だけでなく「FCP と通信できている」ことまで証明できる。
    private var hostDescription: String {
        guard let host = ProExtensionHostSingleton() as? FCPXHost else {
            return "ホスト情報を取得できませんでした"
        }
        return "\(host.name) \(host.versionString)"
    }

    override func loadView() {
        // FCP はパネルのサイズを自分で決めるので、ここでは仮の大きさでよい
        self.view = NSView(frame: NSRect(x: 0, y: 0, width: 480, height: 360))
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        let hosting = NSHostingView(rootView: ExtensionView(hostDescription: hostDescription))
        hosting.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hosting)

        NSLayoutConstraint.activate([
            hosting.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            hosting.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            hosting.topAnchor.constraint(equalTo: view.topAnchor),
            hosting.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }
}
