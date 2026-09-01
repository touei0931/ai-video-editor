//
//  main.swift
//  「間の好み」の覚え方を検める
//
//  🔴 ここは**候補を減らす**仕組みなので、間違えると
//     「切りたい所が候補に出てこない」という形で現れる。
//     出てこないものには気づけないので、検査で縛る。
//
//  見るところ:
//   - 記録が少ないうちは覚えない
//   - いつも切る／いつも残す人には線を引かない
//   - はっきり分かれている記録では、その境目を当てる
//   - たまたま当たっただけの線を「覚えた」と言わない
//

import Foundation

var failures: [String] = []

func check(_ label: String, _ condition: Bool, _ detail: String = "") {
    if condition {
        print("✅ \(label)")
    } else {
        print("❌ \(label) \(detail)")
        failures.append(label)
    }
}

func entry(_ length: Double, _ cut: Bool, kind: String = "silence", text: String = "") -> CutMemory.Entry {
    CutMemory.Entry(kind: kind, length: length, text: text, cut: cut)
}

// MARK: - 記録が足りないとき

do {
    var m = CutMemory()
    m.record((0..<10).map { entry(0.2 + Double($0) * 0.1, $0 > 4) })
    check("記録が少ないうちは覚えない", m.learnedMinGain() == nil,
          "\(m.learnedMinGain()?.minGain ?? -1)")
    check("要る件数を画面に出せる", (m.summary["minSamples"] as? Int) == CutMemory.minSamples)
    check("覚えていないときは境目を出さない", m.summary["minGain"] == nil)
}

// MARK: - 片方に寄りきっているとき

do {
    var m = CutMemory()
    m.record((0..<60).map { entry(0.2 + Double($0) * 0.05, true) })
    check("いつも切る人には線を引かない", m.learnedMinGain() == nil)

    var k = CutMemory()
    k.record((0..<60).map { entry(0.2 + Double($0) * 0.05, false) })
    check("いつも残す人にも線を引かない", k.learnedMinGain() == nil)
}

// MARK: - はっきり分かれているとき

do {
    /*
      0.5秒を境に、短いものは残し、長いものは切っている人。
      境目は 0.5 付近に来るはず。
    */
    var m = CutMemory()
    var es: [CutMemory.Entry] = []
    for i in 0..<40 { es.append(entry(0.20 + Double(i) * 0.005, false)) }  // 0.20〜0.40 残す
    for i in 0..<40 { es.append(entry(0.55 + Double(i) * 0.010, true)) }   // 0.55〜0.94 切る
    m.record(es)

    guard let l = m.learnedMinGain() else {
        check("はっきり分かれていれば覚える", false, "覚えなかった"); exit(1)
    }
    check("はっきり分かれていれば覚える", true)
    /*
      🔴 決め打ちの範囲で縛らないこと。
         「0.4〜0.6」のような書き方は、正しい答え（0.40）を落とす。
         見たいのは**2つの群を分けていること**そのもの。
         残した中でいちばん長いものより後、切った中でいちばん短いもの以下。
    */
    let 残す最大 = es.filter { !$0.cut }.map(\.length).max() ?? 0
    let 切る最小 = es.filter { $0.cut }.map(\.length).min() ?? 0
    check("境目が2つの群を分けている",
          l.minGain > 残す最大 && l.minGain <= 切る最小,
          "境目 \(l.minGain) / 残す最大 \(残す最大) / 切る最小 \(切る最小)")
    check("記録と食い違わない", l.agreement > 0.95, "\(l.agreement)")
    check("根拠の件数を持つ", l.samples == 80, "\(l.samples)")

    // 画面に出す要約にも、根拠が入っていること
    check("要約に境目が入る", (m.summary["minGain"] as? Double) != nil)
    check("要約に件数が入る", (m.summary["samples"] as? Int) == 80)
}

// MARK: - たまたま当たっただけの線を採らない

do {
    /*
      ほとんど切っているが、短いものを1件だけ残した人。
      どこに線を引いても当たるので、覚えてはいけない。
    */
    var m = CutMemory()
    var es: [CutMemory.Entry] = [entry(0.21, false)]
    for i in 0..<59 { es.append(entry(0.5 + Double(i) * 0.01, true)) }
    m.record(es)
    check("多数派に合わせただけの線は採らない", m.learnedMinGain() == nil,
          "\(m.learnedMinGain()?.minGain ?? -1)")
}

// MARK: - 溜めすぎない

do {
    var m = CutMemory()
    m.record((0..<(CutMemory.maxEntries + 500)).map { entry(0.3, $0 % 2 == 0) })
    check("上限を超えて溜めない", m.entries.count == CutMemory.maxEntries, "\(m.entries.count)")

    // 🔴 古いものから捨てること。好みは変わる
    var n = CutMemory()
    n.record((0..<CutMemory.maxEntries).map { _ in entry(0.9, true, text: "ふるい") })
    n.record([entry(0.9, true, text: "あたらしい")])
    check("捨てるのは古い方", n.entries.last?.text == "あたらしい", n.entries.last?.text ?? "?")
}

// MARK: - 口ぐせの提案

do {
    var m = CutMemory()
    var es: [CutMemory.Entry] = []
    for _ in 0..<6 { es.append(entry(0.3, true, kind: "filler", text: "ですね")) }
    // 「はい」は切ることも残すこともある＝口ぐせとは言えない
    for _ in 0..<5 { es.append(entry(0.3, true, kind: "filler", text: "はい")) }
    for _ in 0..<5 { es.append(entry(0.3, false, kind: "filler", text: "はい")) }
    m.record(es)

    let got = m.fillerSuggestions()
    check("何度も切っている語を提案する", got.contains("ですね"), got.joined(separator: ","))
    check("残すこともある語は提案しない", !got.contains("はい"), got.joined(separator: ","))
}

do {
    check("記録が空でも落ちない",
          CutMemory().learnedMinGain() == nil && CutMemory().fillerSuggestions().isEmpty)
}

print("")
if failures.isEmpty {
    print("🎉 間の好みの覚え方をすべて通過")
} else {
    print("🚫 失敗: \(failures.joined(separator: " / "))")
    exit(1)
}
