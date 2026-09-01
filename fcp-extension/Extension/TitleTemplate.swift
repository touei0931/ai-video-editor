//
//  TitleTemplate.swift
//  PAC Workflow Extension
//
//  友達が FCP から書き出した FCPXML の <title> を「見本」として読み、
//  effect の uid・param・text-style を丸ごと写して全テロップに適用する。
//
//  なぜこれが要るのか（AutoTelop で確定済み）:
//    テロップの見た目を strokeWidth 等で自作再現することは**できなかった**。
//    専用テンプレ（MP_テロップパック の「基本01_10」など）は Motion の
//    テンプレートなので、uid で参照して本文だけ差し替えるのが唯一の正解。
//

import Foundation

struct TitleTemplate: Codable {
    /// Motion テンプレートの識別子。これが本体
    var effectUID: String
    var effectName: String
    /// 位置・配置など。順番も含めてそのまま写す
    var params: [Param]
    /// font / fontSize / fontFace / fontColor / bold / alignment など
    var textStyle: [String: String]
    /// テンプレの title が持つ内部 start（Motion テンプレは 3600s のことが多い）
    var titleStart: String

    struct Param: Codable {
        var name: String
        var key: String
        var value: String
    }

    /// UI に見せる要約
    var summary: [String: Any] {
        [
            "effectName": effectName,
            "font": textStyle["font"] ?? "",
            "fontFace": textStyle["fontFace"] ?? "",
            "fontSize": Double(textStyle["fontSize"] ?? "") ?? 0,
            "bold": (textStyle["bold"] ?? "0") == "1",
            "paramCount": params.count,
            /*
              🔴 見本に文字の書式が入っていたかを、画面に伝えること。

                 見本のタイトルに**文字を入れずに**書き出すと、FCP は
                 <text/> だけを書き、text-style-def を1つも書かない。
                 こちらは写すものが無いので、書体も大きさも既定に落ちる。
                 「テロップが小さい」の形でしか現れず、原因が見えない
                 （2026-09-02、試験.fcpxml がまさにこれだった）。
            */
            "hasStyle": !textStyle.isEmpty,
        ]
    }

    // MARK: - 読み込み

    enum LoadError: LocalizedError {
        case noTitle, noEffect

        var errorDescription: String? {
            switch self {
            case .noTitle: return "この XML にテロップ（title）が入っていません"
            case .noEffect: return "テロップが参照しているテンプレート（effect）が見つかりません"
            }
        }
    }

    /// 友達が書き出した .fcpxml から見本を取り出す
    static func parse(fcpxml: String) throws -> TitleTemplate {
        let doc = try XMLDocument(xmlString: fcpxml, options: [.nodePreserveWhitespace])

        guard let title = try doc.nodes(forXPath: "//title").first as? XMLElement else {
            throw LoadError.noTitle
        }
        let ref = title.attribute(forName: "ref")?.stringValue ?? ""
        guard
            let effect = try doc.nodes(forXPath: "//effect[@id='\(ref)']").first as? XMLElement,
            let uid = effect.attribute(forName: "uid")?.stringValue
        else {
            throw LoadError.noEffect
        }

        let params: [Param] = (title.elements(forName: "param")).map { p in
            Param(
                name: p.attribute(forName: "name")?.stringValue ?? "",
                key: p.attribute(forName: "key")?.stringValue ?? "",
                value: p.attribute(forName: "value")?.stringValue ?? ""
            )
        }

        var textStyle: [String: String] = [:]
        if let def = title.elements(forName: "text-style-def").first,
           let ts = def.elements(forName: "text-style").first {
            for attr in ts.attributes ?? [] where attr.name != "ref" {
                if let name = attr.name, let value = attr.stringValue {
                    textStyle[name] = value
                }
            }
        }

        return TitleTemplate(
            effectUID: uid,
            effectName: effect.attribute(forName: "name")?.stringValue ?? "テロップ",
            params: params,
            textStyle: textStyle,
            titleStart: title.attribute(forName: "start")?.stringValue ?? "0s"
        )
    }

    // MARK: - 保存

    private static let key = "pac.titleTemplate"

    func save() {
        if let data = try? JSONEncoder().encode(self) {
            UserDefaults.standard.set(data, forKey: Self.key)
        }
    }

    static func load() -> TitleTemplate? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(TitleTemplate.self, from: data)
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: key)
    }
}
