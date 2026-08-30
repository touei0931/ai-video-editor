/**
 * 文のまとまりを「1画面ぶん」に割り直す。
 *
 * 🔴 エンジンが返すのは**文のまとまり**であって、1画面に出す量ではない。
 *    あちらの上限（40文字）は「句読点も間も無いまま喋り続けたとき」の保険で、
 *    そこに当たると**文節の途中で切れる**。実機で
 *    「…しづらさを減 / らすこともあります」のように割れた（2026-08-31）。
 *    PAC 本体は同じことを Canvas 側（src/telop/split.ts）でやっている。
 *    こちらは Final Cut のテンプレートが描くので、決めるのは
 *    「1枚に何文字入れるか」と「どこで切るか」の2つだけ。
 *
 * 🔴 切ってよいのは**文節の境目**だけ。文字数で機械的に切らないこと。
 *    BudouX に境目を出してもらう。
 *
 * 🔴 割った先の時刻は、語ごとの時刻から出すこと。
 *    長さで按分すると、早口の所と間の空く所でずれる。
 */

import { loadDefaultJapaneseParser } from 'budoux'
import type { Telop, TelopWord } from './types'

const parser = loadDefaultJapaneseParser()

/**
 * 1枚に入れる全角換算の文字数。
 *
 * 🔴 2行ぶんの目安にすること。テロップは読みながら見るものなので、
 *    1枚が長いと読み終わる前に次へ行く。
 */
export const DEFAULT_TELOP_MAX_CHARS = 26

/**
 * 文字数の下限・上限。
 * 🔴 縛りは「割る側」に置くこと。画面側だけで縛ると、
 *    打ちかけの値のまま解析を始められて素通りする。
 */
export const TELOP_MAX_CHARS_RANGE = { min: 8, max: 60 }

/** これより短い切れ端は前の1枚にくっつける（1枚に1〜2文字だけ出るのを防ぐ） */
const MIN_TAIL_CHARS = 4

/** 半角は 0.5 文字と数える */
function displayLength(text: string): number {
  let n = 0
  for (const ch of text) n += /[\x20-\x7E｡-ﾟ]/.test(ch) ? 0.5 : 1
  return n
}

/** 文節の境目で、maxChars を超えないように束ねる */
export function chunkByPhrase(text: string, maxChars: number): string[] {
  const phrases = parser.parse(text)
  const out: string[] = []
  let current = ''

  for (const phrase of phrases) {
    if (displayLength(phrase) > maxChars) {
      /*
        この文節だけで上限を超える。ここは切るしかない。
        🔴 それでも「切るしかないとき」に限ること。
           先に文字数で切ると、切らなくてよい所まで切れる。
      */
      if (current) {
        out.push(current)
        current = ''
      }
      let rest = phrase
      while (displayLength(rest) > maxChars) {
        let take = ''
        for (const ch of rest) {
          if (displayLength(take + ch) > maxChars) break
          take += ch
        }
        out.push(take)
        rest = rest.slice(take.length)
      }
      current = rest
      continue
    }

    if (displayLength(current + phrase) <= maxChars) {
      current += phrase
    } else {
      if (current) out.push(current)
      current = phrase
    }
  }
  if (current) out.push(current)

  // 最後が短すぎるときは前にくっつける
  if (out.length >= 2 && displayLength(out[out.length - 1]) < MIN_TAIL_CHARS) {
    const tail = out.pop() as string
    out[out.length - 1] += tail
  }
  return out.length > 0 ? out : [text]
}

/**
 * 文字位置から、その位置の時刻を引く。
 *
 * 🔴 語ごとの時刻から出すこと。長さで按分すると、
 *    早口の所と間の空く所でずれる。
 */
function timeLookup(words: TelopWord[], fallback: { start: number; end: number }) {
  const bounds: { from: number; to: number; start: number; end: number }[] = []
  let at = 0
  for (const w of words) {
    const len = w.text.length
    bounds.push({ from: at, to: at + len, start: w.srcStart, end: w.srcEnd })
    at += len
  }
  return {
    startAt(index: number): number {
      for (const b of bounds) if (index < b.to) return b.start
      return bounds.length ? bounds[bounds.length - 1].end : fallback.start
    },
    endAt(index: number): number {
      for (let i = bounds.length - 1; i >= 0; i--) {
        if (bounds[i].from < index) return bounds[i].end
      }
      return bounds.length ? bounds[0].start : fallback.end
    },
  }
}

/**
 * テロップを1画面ぶんに割り直す。
 *
 * 語ごとの時刻が無いものは、そのまま返す（作り物の見立てで時刻をでっち上げない）。
 */
export function splitTelops(telops: Telop[], maxChars = DEFAULT_TELOP_MAX_CHARS): Telop[] {
  /*
    🔴 ここでも範囲で縛ること。
       画面側でも縛っているが、打ちかけの値（3 など）のまま解析を始められる。
       1文字ずつのテロップが数百枚できると、直すのも消すのも手に負えない。
  */
  const limit = Number.isFinite(maxChars)
    ? Math.min(TELOP_MAX_CHARS_RANGE.max, Math.max(TELOP_MAX_CHARS_RANGE.min, Math.round(maxChars)))
    : DEFAULT_TELOP_MAX_CHARS

  const out: Telop[] = []

  for (const t of telops) {
    const chunks = chunkByPhrase(t.text, limit)
    if (chunks.length <= 1) {
      out.push(t)
      continue
    }

    const words = t.words ?? []
    if (words.length === 0) {
      // 🔴 時刻の裏づけが無いまま割らないこと。
      //    出どころの無い時刻でテロップを並べると、声とずれたまま気づけない。
      out.push(t)
      continue
    }

    const look = timeLookup(words, { start: t.start, end: t.end })
    let offset = 0
    chunks.forEach((chunk, i) => {
      const from = offset
      const to = offset + chunk.length
      offset = to

      const start = i === 0 ? t.start : look.startAt(from)
      const end = i === chunks.length - 1 ? t.end : look.endAt(to)
      if (!(end > start)) return

      out.push({
        ...t,
        id: `${t.id}-${i + 1}`,
        text: chunk,
        start: Number(start.toFixed(3)),
        end: Number(end.toFixed(3)),
      })
    })
  }

  // 🔴 前後が重ならないようにすること。重なると FCP で2枚同時に出る
  out.sort((a, b) => a.start - b.start)
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i].end > out[i + 1].start) {
      out[i] = { ...out[i], end: Number((out[i + 1].start - 0.02).toFixed(3)) }
    }
  }
  return out.filter((t) => t.end > t.start)
}
