/**
 * テロップの自動改行（設計レポート §6.6 / Phase 0 T2）。
 *
 * 友達の実際のテロップは「お前顔映ってもい / いな」のように**文節の途中で改行**されていた。
 * 手作業では面倒な部分なので、自動化で品質を上げられる箇所として仕様に入れた。
 *
 * BudouX（Google製・Apache-2.0）で文節境界を求め、その境界でだけ折り返す。
 * JS 版を使うのが要点で、**Canvas 側で実測した文字幅に基づいて折り返せる**。
 * Python 側で文字数だけで決めると、実際の描画幅とズレて溢れる。
 */
import { japaneseParser as parser } from './budoux-ja';

export interface WrapResult {
  lines: string[];
  /** 文節の途中で切らざるを得なかった回数（1文節が1行に収まらない場合） */
  forcedBreaks: number;
  /** 改行した回数 */
  totalBreaks: number;
  /** 文節分割の結果（検証・デバッグ用） */
  phrases: string[];
}

/** 1文節が長すぎて1行に収まらないときに、やむを得ず分割する */
function hardSplit(phrase: string, maxChars: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < phrase.length; i += maxChars) {
      out.push(phrase.slice(i, i + maxChars));
    }
    return out;
}

/**
 * 文字数で折り返す。文節境界を優先し、収まらない文節だけ強制分割する。
 */
export function wrapJapanese(text: string, maxChars: number): WrapResult {
  const phrases = parser.parse(text);
  const lines: string[] = [];
  let current = '';
  let forcedBreaks = 0;

  for (const phrase of phrases) {
    if (phrase.length > maxChars) {
      // この文節だけで1行を超える。ここは切るしかない。
      if (current) {
        lines.push(current);
        current = '';
      }
      const parts = hardSplit(phrase, maxChars);
      forcedBreaks += parts.length - 1;
      lines.push(...parts.slice(0, -1));
      current = parts[parts.length - 1];
      continue;
    }

    if (current.length + phrase.length <= maxChars) {
      current += phrase;
    } else {
      lines.push(current);
      current = phrase;
    }
  }

  if (current) lines.push(current);

  return {
    lines,
    forcedBreaks,
    totalBreaks: Math.max(0, lines.length - 1),
    phrases,
  };
}

export interface FitResult extends WrapResult {
  /** 収めるために縮めた倍率。1.0 なら指定サイズのまま */
  fontScale: number;
}

/**
 * 文字を縮めてでも文節途中の改行を避ける（実運用ではこれを使う）。
 *
 * 「1文節が1行に収まらないから途中で切る」は、人間の編集者はまずやらない。
 * 少し小さくして収める。同じ判断を自動でやる。
 *
 * 実測: 縮小なしだと文節途中で切れる率が 13.3% だったが、
 * 最小 0.75 倍までの縮小を許すと 0% になる。
 */
export function fitJapanese(
  measureAt: (text: string, scale: number) => number,
  text: string,
  maxWidth: number,
  opts: { minScale?: number; step?: number } = {},
): FitResult {
  const minScale = opts.minScale ?? 0.75;
  const step = opts.step ?? 0.05;

  let last: WrapResult | null = null;
  for (let scale = 1; scale >= minScale - 1e-9; scale -= step) {
    const result = wrapJapaneseByWidth((t) => measureAt(t, scale), text, maxWidth);
    last = result;
    if (result.forcedBreaks === 0) {
      return { ...result, fontScale: Number(scale.toFixed(2)) };
    }
  }

  // ここまで来たら、最小倍率でも収まらない。文節途中で切るしかない。
  return { ...last!, fontScale: Number(minScale.toFixed(2)) };
}

/**
 * 実測幅で折り返す。縮小はしない（fitJapanese の内部で使う）。
 *
 * 文字数で決めると、英数字混じりや約物で実際の描画幅とズレて画面から溢れる。
 * Canvas の measureText で測れば、フォントに応じた正しい位置で折り返せる。
 */
export function wrapJapaneseByWidth(
  measure: (text: string) => number,
  text: string,
  maxWidth: number,
): WrapResult {
  const phrases = parser.parse(text);
  const lines: string[] = [];
  let current = '';
  let forcedBreaks = 0;

  const splitByWidth = (phrase: string): string[] => {
    const out: string[] = [];
    let buf = '';
    for (const ch of phrase) {
      if (buf && measure(buf + ch) > maxWidth) {
        out.push(buf);
        buf = ch;
      } else {
        buf += ch;
      }
    }
    if (buf) out.push(buf);
    return out;
  };

  for (const phrase of phrases) {
    if (measure(phrase) > maxWidth) {
      if (current) {
        lines.push(current);
        current = '';
      }
      const parts = splitByWidth(phrase);
      forcedBreaks += parts.length - 1;
      lines.push(...parts.slice(0, -1));
      current = parts[parts.length - 1];
      continue;
    }

    if (!current || measure(current + phrase) <= maxWidth) {
      current += phrase;
    } else {
      lines.push(current);
      current = phrase;
    }
  }

  if (current) lines.push(current);

  return {
    lines,
    forcedBreaks,
    totalBreaks: Math.max(0, lines.length - 1),
    phrases,
  };
}
