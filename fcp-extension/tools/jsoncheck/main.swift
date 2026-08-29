//
//  jsoncheck
//
//  パネルへ返す値の均し方を検める。
//
//  🔴 ここが抜けると、拡張が**丸ごと落ちる**形で現れる。
//     JSONSerialization は Objective-C の例外を投げるので、
//     Swift 側では受け止められず、パネルは「読み込み中…」のまま止まる。
//     エラー画面も出ないし、ログにも理由は出ない。
//     実際に友達の Mac で1週間気付けなかった（2026-08-30）。
//

import Foundation

var failed = 0

func check(_ label: String, _ ok: Bool, _ detail: String = "") {
    if ok {
        print("✅ \(label)")
    } else {
        print("❌ \(label)\(detail.isEmpty ? "" : "  → \(detail)")")
        failed += 1
    }
}

// ------------------------------------------------------------ 数でない値

/*
  🔴 本命。NaN を渡しても落ちないこと。
     落ちていたのはここ。再生位置が未確定のとき CMTimeGetSeconds が
     NaN を返し、そのまま辞書に入れて渡していた。
*/
do {
    let out = JSONSafe.text(["playheadSec": Double.nan, "ok": 1])
    check("NaN を渡しても落ちない", out.contains("null"), out)
    check("となりの値は残る", out.contains("\"ok\":1"), out)
}

do {
    let out = JSONSafe.text(["a": Double.infinity, "b": -Double.infinity])
    check("無限大も null になる", !out.contains("inf") && out.contains("null"), out)
}

// 入れ子の奥にあっても効くこと（落ちたときは host の中の値だった）
do {
    let out = JSONSafe.text(["host": ["playheadSec": Double.nan, "name": "FCP"]])
    check("入れ子の奥でも効く", out.contains("null") && out.contains("FCP"), out)
}

do {
    let out = JSONSafe.text(["waveform": [1.0, Double.nan, 3.0]])
    check("配列の中でも効く", out.contains("null"), out)
}

// ------------------------------------------------------------ 単体の値

/*
  🔴 文字列や数を単体で渡してくる呼び口がある（フォルダの場所など）。
     JSONSerialization は単体の値を受け付けず、ここでも例外を投げる。
*/
/*
  🔴 出てきた文字をそのまま比べないこと。
     Foundation は `/` を `\/` と書く（JSON として正しく、読み戻せば同じ）。
     見た目で比べると、正しいものを不合格にする。**読み戻して**比べる。
*/
func roundTrip(_ json: String) -> Any? {
    let parsed = (try? JSONSerialization.jsonObject(
        with: Data("[\(json)]".utf8), options: [])) as? [Any]
    return parsed?.first
}

do {
    let out = JSONSafe.text("/Users/me/動画")
    check("単体の文字列を返せる", (roundTrip(out) as? String) == "/Users/me/動画", out)
}

do {
    let out = JSONSafe.text(42)
    check("単体の数を返せる", out == "42", out)
}

do {
    let out = JSONSafe.text(NSNull())
    check("空も返せる", out == "null", out)
}

// 🔴 引用符や \ の入った経路を自前で囲むと壊れる。Foundation に任せること
do {
    let out = JSONSafe.text("彼は\"これ\"と言った\\終")
    check("引用符や \\ が入っても読み戻せる",
          (roundTrip(out) as? String) == "彼は\"これ\"と言った\\終", out)
}

// 🔴 JavaScript に埋め込むので、行が切れる文字は逃がすこと
do {
    let out = JSONSafe.text("前\u{2028}後")
    check("U+2028 を逃がす", out.contains("\\u2028"), out)
}

// ------------------------------------------------------------ 直せないもの

do {
    let out = JSONSafe.text(["when": Date(timeIntervalSince1970: 0)])
    check("直せないものは捨てずに文字へ落とす", out.contains("when") && !out.isEmpty, out)
}

// ------------------------------------------------------------ 素通し

do {
    let out = JSONSafe.text(["a": 1, "b": "x", "c": true])
    let back = (try? JSONSerialization.jsonObject(with: Data(out.utf8))) as? [String: Any]
    check("ふつうの値はそのまま通る", back?.count == 3, out)
}

if failed > 0 {
    print("\n🚫 jsoncheck: \(failed) 件")
    exit(1)
}
print("\n🎉 jsoncheck: すべて通過")
