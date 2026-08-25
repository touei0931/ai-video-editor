//
//  WorkflowExtensionViewController.swift
//  PAC Workflow Extension
//
//  FCP が Info.plist の ProExtensionPrincipalViewControllerClass を見て
//  このクラスを生成し、FCP のウィンドウ内にパネルとして表示する。
//
//  中身は WKWebView 1枚。UI は webui/(React) をビルドしたものを読み込む。
//  Swift 側は「FCP から情報を読む」「ファイルを扱う」「FCPXML を書き出す」だけを担当する。
//

import Cocoa
import WebKit
import ProExtensionHost

@objc class WorkflowExtensionViewController: NSViewController {

    private var webView: WKWebView!
    private let handlerName = "pac"

    // MARK: - 生成

    override func loadView() {
        view = NSView(frame: NSRect(x: 0, y: 0, width: 900, height: 600))
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        setupWebView()
        loadUI()
    }

    private func setupWebView() {
        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        controller.add(self, name: handlerName)
        config.userContentController = controller
        // ローカルの html から fetch 等をしたときに弾かれないようにする
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")

        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.setValue(false, forKey: "drawsBackground")  // FCP の暗い背景に馴染ませる
        view.addSubview(webView)
    }

    private func loadUI() {
        guard let indexURL = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "webui") else {
            showFallback("UI が見つかりません（webui が同梱されていません）")
            return
        }
        // 読み取りを許すのは UI のフォルダだけ…にしてはいけない。
        // プレビューは利用者が選んだ動画（別の場所にある）を file:// で読むので、
        // ここを狭めると映像が出ない。実際に読めるかはサンドボックスが決めるので、
        // ここを広くしても許可していないファイルは読めない。
        webView.loadFileURL(indexURL, allowingReadAccessTo: URL(fileURLWithPath: "/"))
    }

    /// UI が読めなかったときでも、何が起きているかは分かるようにしておく
    private func showFallback(_ message: String) {
        let label = NSTextField(labelWithString: "PAC\n\n\(message)\n\n\(hostDescription)")
        label.alignment = .center
        label.maximumNumberOfLines = 0
        label.frame = view.bounds
        label.autoresizingMask = [.width, .height]
        view.addSubview(label)
    }

    // MARK: - FCP（ホスト）から読める情報

    private var fcpxHost: FCPXHost? {
        ProExtensionHostSingleton() as? FCPXHost
    }

    private var hostDescription: String {
        guard let host = fcpxHost else { return "ホスト情報を取得できませんでした" }
        return "\(host.name) \(host.versionString)"
    }
}

// MARK: - JavaScript からの呼び出し

extension WorkflowExtensionViewController: WKScriptMessageHandler {

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard
            let body = message.body as? [String: Any],
            let id = body["id"] as? Int,
            let method = body["method"] as? String
        else { return }

        let params = body["params"] as? [String: Any] ?? [:]

        switch method {
        case "loadProject":
            reply(id: id, ok: true, payload: PanelData.project(host: fcpxHost))
        case "listFonts":
            reply(id: id, ok: true, payload: PanelData.fontFamilies())
        case "grantMediaFolder":
            grantMediaFolder { path in
                self.reply(id: id, ok: true, payload: path as Any)
            }
        case "pickVideo":
            pickVideo { payload in
                self.reply(id: id, ok: true, payload: payload)
            }
        case "runAnalysis":
            runAnalysis(params: params) { ok, payload in
                self.reply(id: id, ok: ok, payload: payload)
            }
        case "loadTitleTemplate":
            loadTitleTemplate { ok, payload in
                self.reply(id: id, ok: ok, payload: payload)
            }
        case "clearTitleTemplate":
            TitleTemplate.clear()
            reply(id: id, ok: true, payload: NSNull())
        case "sendToFCP":
            exportToFCP(params: params) { ok, message in
                self.reply(id: id, ok: ok, payload: ["ok": ok, "message": message])
            }
        default:
            reply(id: id, ok: false, payload: ["message": "未知の呼び出し: \(method)"])
        }
    }

    /// 解析の進み具合を JS 側の window.pacProgress に流す
    func sendProgress(stage: String, ratio: Double) {
        let escaped = stage
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        let js = "window.pacProgress && window.pacProgress(\"\(escaped)\", \(ratio));"
        DispatchQueue.main.async {
            self.webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    /// JS 側の window.pacResolve に返す
    private func reply(id: Int, ok: Bool, payload: Any) {
        let json: String
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
           let text = String(data: data, encoding: .utf8) {
            json = text
        } else if let text = payload as? String {
            json = "\"\(text)\""
        } else {
            json = "null"
        }
        let js = "window.pacResolve && window.pacResolve(\(id), \(ok), \(json));"
        DispatchQueue.main.async {
            self.webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}
