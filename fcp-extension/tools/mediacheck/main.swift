//
//  mediacheck
//
//  素材の配り手（pac-media://）の読み方を検める。
//
//  🔴 ここが狂うと「再生はできるが途中へ飛べない」「真っ黒」になる。
//     どちらも実機で触るまで気づけない見え方をする。
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

let size = 10_000_000

// ------------------------------------------------------------ 範囲の読み方

do {
    let (a, b) = MediaSchemeHandler.parseRange(nil, size: size)
    check("指定が無ければ頭から一区切り", a == 0 && b < size, "\(a)-\(b)")
    check("一度に全部は返さない", b - a + 1 < size, "\(b - a + 1) バイト")
}

do {
    let (a, b) = MediaSchemeHandler.parseRange("bytes=100-200", size: size)
    check("開始と終了を読む", a == 100 && b == 200, "\(a)-\(b)")
}

/*
  🔴 終了を書かない指定（bytes=500-）が普通に来る。
     これを「0-」と読むと、飛んだ先ではなく頭が返り、
     動画が毎回先頭に戻る形になる。
*/
do {
    let (a, b) = MediaSchemeHandler.parseRange("bytes=500-", size: size)
    check("終了を省いた指定を読む", a == 500 && b > 500, "\(a)-\(b)")
}

// 🔴 端を越えさせないこと。越えると読み出しで落ちる
do {
    let (a, b) = MediaSchemeHandler.parseRange("bytes=99999999-99999999", size: size)
    check("末尾を越えない", b <= size - 1 && a <= b, "\(a)-\(b)")
}

do {
    let (a, b) = MediaSchemeHandler.parseRange("bytes=0-99999999", size: size)
    check("大きすぎる終了は末尾で止まる", b == size - 1, "\(a)-\(b)")
}

do {
    let (a, b) = MediaSchemeHandler.parseRange("こわれた指定", size: size)
    check("壊れた指定でも数を返す", a == 0 && b >= 0 && b < size, "\(a)-\(b)")
}

do {
    let (a, b) = MediaSchemeHandler.parseRange("bytes=-", size: size)
    check("数が無くても落ちない", a >= 0 && b >= a, "\(a)-\(b)")
}

// ------------------------------------------------------------ 種類

check("mov を動画として渡す", MediaSchemeHandler.mimeType(for: "/a/b.MOV") == "video/quicktime")
check("mp4 を動画として渡す", MediaSchemeHandler.mimeType(for: "/a/b.mp4") == "video/mp4")
check("知らない拡張子でも何か返す", !MediaSchemeHandler.mimeType(for: "/a/b").isEmpty)

// ------------------------------------------------------------ URL の作り方

do {
    let u = MediaSchemeHandler.url(for: "/Users/me/動画 と 空白/a b.mov")
    check("空白を逃がす", !u.contains(" "), u)
    check("scheme が付く", u.hasPrefix("pac-media://"), u)
    let back = URL(string: u)?.path.removingPercentEncoding
    check("元のパスに戻せる", back == "/Users/me/動画 と 空白/a b.mov", back ?? "nil")
}

if failed > 0 {
    print("\n🚫 mediacheck: \(failed) 件")
    exit(1)
}
print("\n🎉 mediacheck: すべて通過")
