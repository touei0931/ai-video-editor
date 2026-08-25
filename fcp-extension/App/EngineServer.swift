//
//  EngineServer.swift
//  PAC（コンテナアプリ）
//
//  パネル（FCP の中・サンドボックス内）からの注文を受けて、
//  解析エンジンを動かして結果を返す係。
//
//  なぜアプリ側でやるのか:
//    パネルはサンドボックスに閉じ込められていて、Python も ffmpeg も起動できない。
//    こちらはサンドボックスの外なので、素材を読み、エンジンを回し、
//    1.6GB のモデルを置いておける。
//
//  なぜソケットなのか:
//    Apple の正式な方法（App Groups / XPC）は Team ID を要求する＝有料。
//    ローカルソケットなら、パネル側の network.client の許可だけで済む。
//    127.0.0.1 なので、通信は自分の Mac から出ない。
//

import Foundation
import Network

final class EngineServer {

    static let shared = EngineServer()

    /// パネル側（EngineClient.swift）と揃えること
    private let port: NWEndpoint.Port = 47829

    private var listener: NWListener?
    private let queue = DispatchQueue(label: "pac.engine.server")

    /// 解析1件分の状態
    private final class Job {
        var stage = "準備しています"
        var ratio = 0.0
        var done = false
        var error: String?
        var result: [String: Any]?
        var process: Process?
    }

    private var jobs: [String: Job] = [:]
    private let jobsLock = NSLock()

    private(set) var lastMessage = "待機中"

    // MARK: - 開始

    func start() {
        guard listener == nil else { return }
        do {
            let params = NWParameters.tcp
            // 自分の Mac の中だけで待つ。外からは繋がらない
            params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: port)
            let listener = try NWListener(using: params, on: port)
            listener.newConnectionHandler = { [weak self] connection in
                self?.handle(connection)
            }
            listener.start(queue: queue)
            self.listener = listener
            lastMessage = "待機中（ポート \(port)）"
        } catch {
            lastMessage = "待ち受けを開始できませんでした：\(error.localizedDescription)"
        }
    }

    // MARK: - 受け取り

    private func handle(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(connection, buffer: Data())
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, isComplete, _ in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }

            // ヘッダの終わりまで来たか
            guard let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else {
                if isComplete { connection.cancel() } else { self.receive(connection, buffer: buffer) }
                return
            }

            let header = String(decoding: buffer[..<headerEnd.lowerBound], as: UTF8.self)
            let length = self.contentLength(in: header)
            let bodyStart = headerEnd.upperBound
            let body = buffer[bodyStart...]

            if body.count < length {
                self.receive(connection, buffer: buffer)
                return
            }

            let response = self.respond(header: header, body: Data(body.prefix(length)))
            connection.send(content: response, completion: .contentProcessed { _ in
                connection.cancel()
            })
        }
    }

    private func contentLength(in header: String) -> Int {
        for line in header.split(separator: "\r\n") {
            let parts = line.split(separator: ":", maxSplits: 1)
            if parts.count == 2, parts[0].lowercased() == "content-length" {
                return Int(parts[1].trimmingCharacters(in: .whitespaces)) ?? 0
            }
        }
        return 0
    }

    private func respond(header: String, body: Data) -> Data {
        let requestLine = header.split(separator: "\r\n").first.map(String.init) ?? ""
        let parts = requestLine.split(separator: " ")
        let method = parts.first.map(String.init) ?? ""
        let path = parts.count > 1 ? String(parts[1]) : "/"

        var payload: [String: Any]

        if method == "POST", path.hasPrefix("/analyze") {
            let params = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
            payload = startAnalysis(params: params)
        } else if method == "GET", path.hasPrefix("/progress") {
            let job = value(of: "job", in: path)
            payload = progress(of: job)
        } else if path.hasPrefix("/ping") {
            payload = ["ok": true]
        } else {
            payload = ["error": "知らない呼び出しです"]
        }

        let json = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data("{}".utf8)
        var head = "HTTP/1.1 200 OK\r\n"
        head += "Content-Type: application/json; charset=utf-8\r\n"
        head += "Content-Length: \(json.count)\r\n"
        head += "Connection: close\r\n\r\n"
        return Data(head.utf8) + json
    }

    private func value(of key: String, in path: String) -> String {
        guard let q = path.firstIndex(of: "?") else { return "" }
        for pair in path[path.index(after: q)...].split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1)
            if kv.count == 2, kv[0] == key {
                return String(kv[1]).removingPercentEncoding ?? String(kv[1])
            }
        }
        return ""
    }

    // MARK: - 解析

    private func startAnalysis(params: [String: Any]) -> [String: Any] {
        let missing = EnginePaths.missing()
        guard missing.isEmpty else {
            return ["error": "同梱物が足りません：\(missing.joined(separator: " / "))"]
        }
        guard let video = params["videoPath"] as? String, !video.isEmpty else {
            return ["error": "動画が指定されていません"]
        }

        let id = UUID().uuidString
        let job = Job()
        jobsLock.lock(); jobs[id] = job; jobsLock.unlock()

        let out = EnginePaths.work.appendingPathComponent("\(id).json")
        let process = Process()
        process.executableURL = EnginePaths.engine
        process.arguments = [
            "--video", video,
            "--out", out.path,
            "--model", (params["model"] as? String) ?? "large-v3-turbo",
            "--language", (params["language"] as? String) ?? "ja",
            "--ffmpeg", EnginePaths.ffmpeg.path,
        ]

        // 進み具合は標準エラーに1行ずつ流れてくる
        let errPipe = Pipe()
        process.standardError = errPipe
        process.standardOutput = Pipe()

        errPipe.fileHandleForReading.readabilityHandler = { handle in
            let text = String(decoding: handle.availableData, as: UTF8.self)
            for line in text.split(separator: "\n") {
                guard
                    let data = line.data(using: .utf8),
                    let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                else { continue }
                if let stage = obj["stage"] as? String { job.stage = stage }
                if let ratio = obj["ratio"] as? Double { job.ratio = ratio }
                if let error = obj["error"] as? String { job.error = error }
            }
        }

        process.terminationHandler = { [weak self] proc in
            errPipe.fileHandleForReading.readabilityHandler = nil
            defer { job.done = true }

            if proc.terminationStatus != 0 && job.error == nil {
                job.error = "解析が途中で終わりました（終了コード \(proc.terminationStatus)）"
                return
            }
            guard
                let data = try? Data(contentsOf: out),
                let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                if job.error == nil { job.error = "結果を読み取れませんでした" }
                return
            }
            job.result = obj
            job.stage = "完了"
            job.ratio = 1.0
            try? FileManager.default.removeItem(at: out)
            self?.lastMessage = "解析が終わりました"
        }

        do {
            try process.run()
            job.process = process
            lastMessage = "解析中…"
        } catch {
            job.error = "エンジンを起動できませんでした：\(error.localizedDescription)"
            job.done = true
        }

        return ["jobId": id]
    }

    private func progress(of id: String) -> [String: Any] {
        jobsLock.lock(); let job = jobs[id]; jobsLock.unlock()
        guard let job else { return ["error": "その解析は見つかりません"] }

        var out: [String: Any] = [
            "stage": job.stage,
            "ratio": job.ratio,
            "done": job.done,
        ]
        if let error = job.error { out["error"] = error }
        if let result = job.result { out["result"] = result }
        return out
    }
}
