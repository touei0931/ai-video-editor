//
//  PanelActions.swift
//  PAC Workflow Extension
//
//  ファイルの許可と、FCPXML の書き出し。
//
//  サンドボックスの中なので、素材ファイルは「利用者が選んだもの」しか読めない。
//  一度選んでもらった場所は security-scoped bookmark で覚えるので、
//  次回以降は許可ダイアログが出ない。
//

import Cocoa
import UniformTypeIdentifiers

extension WorkflowExtensionViewController {

    private static let bookmarkKey = "pac.mediaFolderBookmark"

    /// 素材フォルダの許可をもらう（初回のみ）。
    func grantMediaFolder(completion: @escaping (Any) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "このフォルダを使う"
        panel.message = "動画素材が入っているフォルダを選んでください（次回からは聞かれません）"

        panel.begin { response in
            guard response == .OK, let url = panel.url else {
                completion(NSNull())
                return
            }
            do {
                let bookmark = try url.bookmarkData(
                    options: .withSecurityScope,
                    includingResourceValuesForKeys: nil,
                    relativeTo: nil
                )
                UserDefaults.standard.set(bookmark, forKey: Self.bookmarkKey)
            } catch {
                NSLog("PAC: bookmark の保存に失敗 \(error)")
            }
            completion(url.path)
        }
    }

    /// 覚えてあるフォルダを使えるようにする。使い終わったら stopAccessing を呼ぶこと。
    func restoreMediaFolder() -> URL? {
        guard let data = UserDefaults.standard.data(forKey: Self.bookmarkKey) else { return nil }
        var stale = false
        guard
            let url = try? URL(
                resolvingBookmarkData: data,
                options: .withSecurityScope,
                relativeTo: nil,
                bookmarkDataIsStale: &stale
            )
        else { return nil }
        return url.startAccessingSecurityScopedResource() ? url : nil
    }

    /// 承認したカットとテロップを FCPXML にして書き出す。
    ///
    /// ⚠ Workflow Extension には「タイムラインに書き込む API」が無い（SDK で確認済み）。
    ///   よって .fcpxml を書き出し、FCP の「読み込み」を通す形にする。
    func exportToFCP(params: [String: Any], completion: @escaping (Bool, String) -> Void) {
        let cuts = (params["cuts"] as? [[String: Any]]) ?? []
        let telops = (params["telops"] as? [[String: Any]]) ?? []
        let styles = (params["styles"] as? [String: Any]) ?? PanelData.defaultStyles()
        let media = params["mediaPath"] as? String
        let fps = (params["fps"] as? Double) ?? 30

        if cuts.isEmpty && telops.isEmpty {
            completion(false, "書き出すものがありません")
            return
        }

        let panel = NSSavePanel()
        if let type = UTType(filenameExtension: "fcpxml") {
            panel.allowedContentTypes = [type]
        }
        panel.nameFieldStringValue = "PAC.fcpxml"
        panel.message = "Final Cut Pro に読み込む XML の保存先を選んでください"

        panel.begin { response in
            guard response == .OK, let url = panel.url else {
                completion(false, "中止しました")
                return
            }
            do {
                let xml = FCPXMLWriter.build(
                    cuts: cuts,
                    telops: telops,
                    styles: styles,
                    mediaPath: media,
                    fps: fps,
                    template: TitleTemplate.load()
                )
                try xml.write(to: url, atomically: true, encoding: .utf8)
                completion(
                    true,
                    "書き出しました：\(url.lastPathComponent)（FCP のファイル > 読み込む > XML から開いてください）"
                )
            } catch {
                completion(false, "書き出しに失敗しました：\(error.localizedDescription)")
            }
        }
    }

    /// 友達が FCP から書き出した .fcpxml を「テロップの見本」として取り込む。
    /// effect の uid・param・text-style を丸写しして、以後のテロップに適用する。
    func loadTitleTemplate(completion: @escaping (Bool, Any) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        if let type = UTType(filenameExtension: "fcpxml") {
            panel.allowedContentTypes = [type]
        }
        panel.prompt = "見本にする"
        panel.message = "いつも使っているテロップが1つ入った XML を選んでください（FCP で書き出したもの）"

        panel.begin { response in
            guard response == .OK, let url = panel.url else {
                completion(false, ["message": "中止しました"])
                return
            }
            do {
                let text = try String(contentsOf: url, encoding: .utf8)
                let template = try TitleTemplate.parse(fcpxml: text)
                template.save()
                completion(true, template.summary)
            } catch {
                completion(false, ["message": "読み込めませんでした：\(error.localizedDescription)"])
            }
        }
    }
}
