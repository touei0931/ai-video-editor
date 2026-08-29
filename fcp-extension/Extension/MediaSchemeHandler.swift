//
//  MediaSchemeHandler.swift
//  PAC Workflow Extension
//
//  パネルの中で素材の動画を出すための配り手。
//
//  🔴 file:// で動画を渡さないこと。
//
//     パネルの中身（WKWebView）は**別のプロセス**で動いていて、拡張とは
//     別のサンドボックスに入っている。利用者がダイアログで選んだファイルを
//     読めるのは**拡張の側だけ**で、その許可は WebView まで届かない。
//     結果、映像だけが真っ黒になる（音の波形はエンジンが送った数値なので出る）。
//     エラーも出ないので「動画が無い」のか「読めない」のか分からない。
//     実際に友達の Mac でそうなった（2026-08-30）。
//
//     そこで、読むのは拡張の側にして、中身を pac-media:// で画面へ流す。
//
//  🔴 途中から読めるようにすること（Range）。
//     動画は頭から順に落とすものではない。真ん中へ飛ぶたびに
//     全部を読み直していては、数百MBの素材で待たされる。
//     206 と Content-Range を返せば、再生位置の前後だけを渡せる。
//

import Foundation
import WebKit

/// パネル側から見た動画の入口。`pac-media:///再生したいファイルの絶対パス`
let PACMediaScheme = "pac-media"

final class MediaSchemeHandler: NSObject, WKURLSchemeHandler {

    /// 出してよいファイル。利用者が選んだものだけを入れる。
    ///
    /// 🔴 何でも配らないこと。ここは「拡張の権限でファイルを読んで外へ渡す」道なので、
    ///    渡す相手を絞らないと、パネルの中の JavaScript から
    ///    Mac の中のどのファイルでも読み出せることになる。
    private var allowed = Set<String>()
    private let lock = NSLock()

    func allow(path: String) {
        lock.lock()
        allowed.insert(path)
        lock.unlock()
    }

    private func isAllowed(_ path: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return allowed.contains(path)
    }

    /// 素材のパスから、パネルに渡す URL を作る
    static func url(for path: String) -> String {
        var allowedChars = CharacterSet.urlPathAllowed
        allowedChars.remove("?")
        allowedChars.remove("#")
        let escaped = path.addingPercentEncoding(withAllowedCharacters: allowedChars) ?? path
        return "\(PACMediaScheme)://media\(escaped.hasPrefix("/") ? "" : "/")\(escaped)"
    }

    // MARK: - WKURLSchemeHandler

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(err("URL がありません"))
            return
        }
        let path = url.path.removingPercentEncoding ?? url.path

        guard isAllowed(path) else {
            task.didFailWithError(err("このファイルは渡せません"))
            return
        }
        guard let handle = FileHandle(forReadingAtPath: path) else {
            task.didFailWithError(err("ファイルを開けません: \(path)"))
            return
        }
        defer { try? handle.close() }

        let attrs = try? FileManager.default.attributesOfItem(atPath: path)
        let size = (attrs?[.size] as? Int) ?? 0
        guard size > 0 else {
            task.didFailWithError(err("中身が空です"))
            return
        }

        /*
          Range（この範囲だけください）への返事。
          🔴 これを返さないと、動画の途中へ飛べない。
             Safari は範囲で要求してくるので、全部返すと
             「シークできない動画」として扱われる。
        */
        let requested = task.request.value(forHTTPHeaderField: "Range")
        let (start, end) = Self.parseRange(requested, size: size)
        let length = end - start + 1

        do {
            try handle.seek(toOffset: UInt64(start))
        } catch {
            task.didFailWithError(err("読み出しに失敗しました"))
            return
        }
        let data = handle.readData(ofLength: length)

        var headers = [
            "Content-Type": Self.mimeType(for: path),
            "Content-Length": "\(data.count)",
            "Accept-Ranges": "bytes",
            // パネルは file:// で読み込まれているので、素通しにしておく
            "Access-Control-Allow-Origin": "*",
        ]
        var status = 200
        if requested != nil {
            status = 206
            headers["Content-Range"] = "bytes \(start)-\(start + data.count - 1)/\(size)"
        }

        guard
            let response = HTTPURLResponse(
                url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)
        else {
            task.didFailWithError(err("応答を作れません"))
            return
        }
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        // 1回で返しきっているので、途中で止めるものは無い
    }

    // MARK: - 小物

    /// "bytes=100-200" を読む。省略や壊れた指定は「頭から一区切り」に倒す。
    ///
    /// 🔴 一度に全部返さないこと。数百MBの素材をまるごとメモリに載せることになる。
    static func parseRange(_ header: String?, size: Int, chunk: Int = 4 * 1024 * 1024)
        -> (Int, Int)
    {
        guard let header, header.hasPrefix("bytes=") else {
            return (0, min(chunk, size) - 1)
        }
        let body = header.dropFirst("bytes=".count)
        let parts = body.split(separator: "-", omittingEmptySubsequences: false)
        let start = parts.count > 0 ? Int(parts[0]) ?? 0 : 0
        let wantedEnd = parts.count > 1 ? Int(parts[1]) : nil

        let from = max(0, min(start, size - 1))
        let to = min(wantedEnd ?? (from + chunk - 1), size - 1)
        return (from, max(from, to))
    }

    static func mimeType(for path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "mov", "qt": return "video/quicktime"
        case "m4v": return "video/x-m4v"
        case "mp4": return "video/mp4"
        case "m4a": return "audio/mp4"
        case "wav": return "audio/wav"
        default: return "application/octet-stream"
        }
    }

    private func err(_ message: String) -> NSError {
        NSError(
            domain: "PAC", code: -1,
            userInfo: [NSLocalizedDescriptionKey: message])
    }
}
