//
//  JSONSafe.swift
//  PAC Workflow Extension
//
//  パネル（WebView）へ返す値を、JSON に直せる形へ均す。
//
//  🔴 JSONSerialization に生の値を渡さないこと。
//     あれは値が JSON に直せないとき **Objective-C の例外**を投げる。
//     Swift の `try?` や `do/catch` では受け止められないので、
//     受け止めたつもりのまま**プロセスごと落ちる**。
//
//     実際に落ちた（2026-08-30、友達の Mac）。
//     再生位置が未確定のときに CMTimeGetSeconds が NaN を返し、
//     それを辞書に入れて渡していた。パネルは開くが、画面から最初の
//     問い合わせが来た瞬間に拡張が死に、Final Cut 側は
//     「読み込み中…」のまま止まる。**理由はどこにも出ない。**
//
//  🔴 ここは Foundation だけに頼ること。
//     検査から単体で組み立てられるようにしておく。
//

import Foundation

enum JSONSafe {

    /// JSON に直せる形へ均す。直せないものは捨てずに文字へ落とす。
    ///
    /// 🔴 数でない値（NaN・無限大）は null にすること。
    ///    捨てると「項目が無い」と区別が付かず、画面側で
    ///    「まだ来ていない」のか「値が無い」のかが分からなくなる。
    static func value(_ any: Any) -> Any {
        switch any {
        case let dict as [String: Any]:
            return dict.mapValues { value($0) }
        case let array as [Any]:
            return array.map { value($0) }
        case is NSNull:
            return any
        case let number as NSNumber:
            // Double / Float / Int / Bool はすべてここに来る
            return number.doubleValue.isFinite ? number : NSNull()
        case let string as String:
            return string
        default:
            // 日付や URL など、JSON に直せないもの。捨てずに読める形で残す
            return String(describing: any)
        }
    }

    /// JavaScript に埋め込める文字列にする。
    ///
    /// 🔴 文字列や数を単体で渡してくることがある（フォルダの場所など）。
    ///    JSONSerialization は単体の値を受け付けず、ここでも例外を投げる。
    ///    いったん配列に包んでから外側を外せば、囲みも逃がしも Foundation に任せられる。
    ///    自前で `"\(text)"` と囲むと、引用符や `\` の入った経路で壊れる。
    static func text(_ any: Any) -> String {
        let safe = value(any)
        guard
            JSONSerialization.isValidJSONObject([safe]),
            let data = try? JSONSerialization.data(withJSONObject: [safe], options: []),
            let wrapped = String(data: data, encoding: .utf8),
            wrapped.count >= 2
        else {
            return "null"
        }
        let inner = String(wrapped.dropFirst().dropLast())
        /*
          🔴 U+2028 / U+2029 を逃がすこと。
             JSON では文字列の中に置けるが、JavaScript では**改行**として扱われる。
             そのまま埋め込むと、そこで式が切れて構文エラーになる。
        */
        return inner
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }
}
