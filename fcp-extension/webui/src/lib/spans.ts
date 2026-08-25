// テロップの「一部の文字だけ見た目を変える」指定を扱う。
//
// 日本語テロップの作法は「その語だけを目立たせる」なので、
// 文の一部にだけ大きさ・色・太さを当てられるようにしておく。

import type { TelopSpan } from './types'

/** 範囲が重なっているか */
function overlaps(a: TelopSpan, start: number, end: number): boolean {
  return a.start < end && start < a.end
}

/**
 * 指定した範囲に見た目を当てる。
 * 既にある指定と重なる部分は、新しいほうで置き換える（重ねて持たない）。
 */
export function applySpan(
  spans: TelopSpan[] | undefined,
  start: number,
  end: number,
  style: Omit<TelopSpan, 'start' | 'end'>,
): TelopSpan[] {
  if (end <= start) return spans ?? []
  const out: TelopSpan[] = []

  for (const s of spans ?? []) {
    if (!overlaps(s, start, end)) {
      out.push(s)
      continue
    }
    // 重なった分だけ削って、残りは残す
    if (s.start < start) out.push({ ...s, end: start })
    if (s.end > end) out.push({ ...s, start: end })
  }

  out.push({ start, end, ...style })
  return out.sort((a, b) => a.start - b.start)
}

/** 指定した範囲の見た目指定を外す */
export function clearSpan(
  spans: TelopSpan[] | undefined,
  start: number,
  end: number,
): TelopSpan[] {
  const out: TelopSpan[] = []
  for (const s of spans ?? []) {
    if (!overlaps(s, start, end)) {
      out.push(s)
      continue
    }
    if (s.start < start) out.push({ ...s, end: start })
    if (s.end > end) out.push({ ...s, start: end })
  }
  return out.sort((a, b) => a.start - b.start)
}

/** 本文が変わったとき、範囲を本文の長さに収める（はみ出した指定は捨てる） */
export function clampSpans(spans: TelopSpan[] | undefined, length: number): TelopSpan[] {
  return (spans ?? [])
    .map((s) => ({ ...s, start: Math.min(s.start, length), end: Math.min(s.end, length) }))
    .filter((s) => s.end > s.start)
}

/** その範囲に当たっている指定（最初のもの）を返す */
export function spanAt(
  spans: TelopSpan[] | undefined,
  start: number,
  end: number,
): TelopSpan | undefined {
  return (spans ?? []).find((s) => overlaps(s, start, end))
}
