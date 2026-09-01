//
//  CutMemory.swift
//  PAC Workflow Extension
//
//  「その人の間の好み」を覚える。
//
//  🔴 これは機械学習ではない。**判断の記録と、境目の探索**だけ。
//     モデルは1つも学習しないし、どこにも送らない。全部この Mac の中で終わる。
//     利点は「なぜそう決まったか」を必ず説明できること。
//     ここが説明できないと、候補が減ったときに不具合と区別がつかなくなる。
//
//  やっていること:
//    1. ④カットで下した判断（切る／残す）を、間の長さと一緒に貯める
//    2. 「これより短い間は残す」の境目を、記録といちばん食い違わない値に決める
//    3. 次の解析から、その境目より短い間は候補に挙げない
//

import Foundation

struct CutMemory: Codable {

    /// 判断ひとつぶん
    struct Entry: Codable {
        /// silence / filler / restate / aside
        var kind: String
        /// 詰まる長さ（秒）。候補の区間そのものの長さ
        var length: Double
        /// その区間で喋っている内容（口ぐせを見つけるのに使う）
        var text: String
        /// 切ると決めたか
        var cut: Bool
    }

    var entries: [Entry] = []

    // MARK: - 溜める

    /// 貯めておく上限。
    ///
    /// 🔴 際限なく貯めないこと。UserDefaults に入れているので、
    ///    大きくなるほど読み書きが重くなる。
    /// 🔴 古いものから捨てること。好みは変わる。1年前の判断より
    ///    先週の判断を信じたい。
    static let maxEntries = 2000

    /// 境目を決めるのに要る最低限の件数。
    ///
    /// 🔴 少ない記録で決めないこと。3件の判断で境目を動かすと、
    ///    たまたま押し間違えた1件で候補が消える。
    static let minSamples = 30

    mutating func record(_ new: [Entry]) {
        entries.append(contentsOf: new)
        if entries.count > Self.maxEntries {
            entries.removeFirst(entries.count - Self.maxEntries)
        }
    }

    // MARK: - 境目を決める

    struct Learned {
        /// これより短い間は候補にしない（秒）
        var minGain: Double
        /// 根拠にした件数
        var samples: Int
        /// 記録とどれだけ合っているか（0〜1）
        var agreement: Double
    }

    /// 「これより短い間は残す」の境目を探す。
    ///
    /// 記録といちばん食い違わない値を選ぶだけ。総当たりで足りる
    /// （記録は多くても2000件なので、候補の数もたかが知れている）。
    ///
    /// 🔴 いつも切る人・いつも残す人には境目が無い。
    ///    そのときは覚えない（nil を返す）。無理に線を引くと、
    ///    たまたまの1件で全部の候補が消える。
    func learnedMinGain() -> Learned? {
        let silences = entries.filter { $0.kind == "silence" && $0.length > 0 }
        guard silences.count >= Self.minSamples else { return nil }

        // 判断が片方に寄りきっていたら、境目は引けない
        let cutCount = silences.filter { $0.cut }.count
        guard cutCount > 0, cutCount < silences.count else { return nil }

        // 候補になる境目＝記録に出てきた長さのすぐ上下
        var thresholds = Set<Double>()
        for e in silences {
            thresholds.insert((e.length * 100).rounded() / 100)
        }

        var best: Learned?
        for t in thresholds.sorted() {
            // 「長さ >= t なら切る」と見なしたとき、記録とどれだけ合うか
            let agree = silences.filter { ($0.length >= t) == $0.cut }.count
            let ratio = Double(agree) / Double(silences.count)
            if let b = best, ratio <= b.agreement { continue }
            best = Learned(minGain: t, samples: silences.count, agreement: ratio)
        }

        /*
          🔴 「ただ当てただけ」の線を採らないこと。
             いつも切る／いつも残すに寄っている記録では、
             どこに線を引いてもそこそこ当たる。多数派に合わせただけの線を
             「好みを覚えた」と言うと、候補が理由なく減る。
             多数派より確かに良いときだけ採る。
        */
        let majority = Double(max(cutCount, silences.count - cutCount)) / Double(silences.count)
        guard let b = best, b.agreement > majority + 0.05 else { return nil }
        return b
    }

    /// 何度も切っている短い語＝その人の口ぐせ候補。
    ///
    /// 🔴 提案するだけで、勝手に足さないこと。
    ///    「はい」のような、切ることもあれば残すこともある語を
    ///    黙って口ぐせにすると、本編の返事まで消える。
    func fillerSuggestions(min count: Int = 4) -> [String] {
        var cut: [String: Int] = [:]
        var kept: [String: Int] = [:]
        for e in entries where e.kind == "filler" || e.kind == "restate" {
            let w = e.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !w.isEmpty, w.count <= 8 else { continue }
            if e.cut { cut[w, default: 0] += 1 } else { kept[w, default: 0] += 1 }
        }
        return cut
            .filter { $0.value >= count && $0.value > (kept[$0.key] ?? 0) * 2 }
            .sorted { $0.value > $1.value }
            .map { $0.key }
    }

    // MARK: - 保存

    private static let key = "pac.cutMemory"

    func save() {
        if let data = try? JSONEncoder().encode(self) {
            UserDefaults.standard.set(data, forKey: Self.key)
        }
    }

    static func load() -> CutMemory {
        guard
            let data = UserDefaults.standard.data(forKey: key),
            let m = try? JSONDecoder().decode(CutMemory.self, from: data)
        else { return CutMemory() }
        return m
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: key)
    }

    /// 画面に出す要約。**必ず「なぜ」が分かる形で返すこと**
    var summary: [String: Any] {
        var out: [String: Any] = [
            "decisions": entries.count,
            "silences": entries.filter { $0.kind == "silence" }.count,
            "minSamples": Self.minSamples,
            "fillerSuggestions": fillerSuggestions(),
        ]
        if let l = learnedMinGain() {
            out["minGain"] = (l.minGain * 100).rounded() / 100
            out["samples"] = l.samples
            out["agreement"] = (l.agreement * 100).rounded() / 100
        }
        return out
    }
}
