//
//  EngineClient.swift
//  PAC Workflow Extension
//
//  パネル（サンドボックスの中）から、エンジン（サンドボックスの外）に仕事を頼む側。
//
//  なぜソケットなのか:
//    拡張はサンドボックスに閉じ込められていて、Python も ffmpeg も起動できないし、
//    1.6GB のモデルを置く場所も自由にならない。だから解析は
//    コンテナアプリ（PAC.app）側で動かし、127.0.0.1 越しに頼む。
//    Apple の正式な方法（App Groups / XPC）は Team ID を要求するので、
//    アドホック署名（$99/年を払わない）では使えない。
//    ローカルソケットなら network.client の許可だけで済む。
//
//  通信は自分の Mac の中だけで完結する。外のネットには一切出ない。
//

import Foundation

final class EngineClient {

    static let shared = EngineClient()

    /// エンジンが口を開けて待っているポート
    private let port = 47829
    private var base: URL { URL(string: "http://127.0.0.1:\(port)")! }

    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    private var pollTimer: Timer?

    // MARK: - 解析

    func analyze(
        videoPath: String,
        language: String,
        model: String,
        progress: @escaping (String, Double) -> Void,
        completion: @escaping (Bool, Any) -> Void
    ) {
        progress("エンジンに接続しています", 0.01)

        let body: [String: Any] = [
            "videoPath": videoPath,
            "language": language,
            "model": model,
        ]

        post(path: "/analyze", body: body) { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure:
                completion(false, [
                    "message": """
                    解析できませんでした。PAC アプリが起動していないようです。
                    アプリケーションフォルダの PAC を開いてから、もう一度お試しください。
                    """,
                ])
            case .success(let json):
                guard let job = json["jobId"] as? String else {
                    completion(false, ["message": (json["error"] as? String) ?? "エンジンが応答しませんでした"])
                    return
                }
                self.poll(job: job, progress: progress, completion: completion)
            }
        }
    }

    /// 進み具合を聞きに行く。解析は数分〜数十分かかるので、繋ぎっぱなしにはしない。
    private func poll(
        job: String,
        progress: @escaping (String, Double) -> Void,
        completion: @escaping (Bool, Any) -> Void
    ) {
        var url = URLComponents(url: base.appendingPathComponent("progress"), resolvingAgainstBaseURL: false)!
        url.queryItems = [URLQueryItem(name: "job", value: job)]
        let target = url.url!

        func tick() {
            session.dataTask(with: target) { data, _, error in
                guard error == nil,
                      let data,
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                else {
                    // 一度の失敗では諦めない（起動直後は取りこぼすことがある）
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { tick() }
                    return
                }

                let stage = (json["stage"] as? String) ?? "処理中"
                let ratio = (json["ratio"] as? Double) ?? 0
                progress(stage, ratio)

                if let error = json["error"] as? String {
                    completion(false, ["message": error])
                    return
                }
                if (json["done"] as? Bool) == true {
                    if let result = json["result"] as? [String: Any] {
                        completion(true, result)
                    } else {
                        completion(false, ["message": "結果を受け取れませんでした"])
                    }
                    return
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { tick() }
            }.resume()
        }
        tick()
    }

    // MARK: - 小物

    private enum ClientError: Error { case unreachable }

    private func post(
        path: String,
        body: [String: Any],
        completion: @escaping (Result<[String: Any], Error>) -> Void
    ) {
        var request = URLRequest(url: base.appendingPathComponent(path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        session.dataTask(with: request) { data, _, error in
            if error != nil {
                completion(.failure(ClientError.unreachable))
                return
            }
            guard let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                completion(.failure(ClientError.unreachable))
                return
            }
            completion(.success(json))
        }.resume()
    }
}
