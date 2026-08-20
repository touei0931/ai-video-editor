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

/**
 * 手で決めた改行位置。本文の先頭から数えた文字数で持つ。
 *
 * 🔴 「どの文節のあと」ではなく**文字位置**で持つこと。
 *    文節の分かれ方は BudouX のモデルが決めるので、文言を1文字直しただけで
 *    番号がずれる。文字位置なら、直した箇所より前の指定はそのまま生き残る。
 */
export type Breaks = readonly number[];

/**
 * BudouX が返す文節の境界（本文の先頭から数えた文字数）。
 * 先頭と末尾は改行位置になり得ないので含めない。
 *
 * 「改行位置を自分で決める」UI は、ここで返した位置だけを選ばせる。
 * どこでも切れるようにすると、文節の途中で改行できてしまう。
 */
export function phraseBoundaries(text: string): number[] {
  const out: number[] = [];
  let at = 0;
  for (const phrase of parser.parse(text)) {
    at += phrase.length;
    if (at > 0 && at < text.length) out.push(at);
  }
  return out;
}

/** 改行位置の指定で本文を区切る。指定が無ければ本文そのもの1つ。 */
function segmentsOf(text: string, breaks?: Breaks): string[] {
  if (!breaks || breaks.length === 0) return [text];
  const points = [...new Set(breaks)]
    .filter((b) => b > 0 && b < text.length)
    .sort((a, b) => a - b);
  if (points.length === 0) return [text];

  const out: string[] = [];
  let from = 0;
  for (const at of points) {
    out.push(text.slice(from, at));
    from = at;
  }
  out.push(text.slice(from));
  return out.filter((s) => s.length > 0);
}

/** ここで改行すると収まりが良い文字（句読点のあと） */
const BREAK_AFTER = '。、！？!?…';

/**
 * 行の「余り具合」を点数にする。0 に近いほど良い。
 *
 * 幅いっぱいまで詰めた行ほど点が良くなるので、そのまま足し合わせて最小にすると
 * **行の長さが揃う**（片方だけ極端に短い改行を避けられる）。
 */
function lineCost(width: number, maxWidth: number, text: string): number {
  if (width > maxWidth) return Infinity;
  const slack = (maxWidth - width) / maxWidth;
  const cost = slack * slack;
  /*
    句読点のあとで切れているなら、多少不揃いでもそちらを選ぶ。
    読点は元々そこで息を継ぐ場所なので、行の変わり目として自然に読める。

    引く量は「行の長さが3割ほど不揃いになるくらいまでは許す」目安。
    これ以上大きくすると、文頭のすぐ後ろに読点がある文で
    1文字だけの行ができてしまう。
  */
  const last = text[text.length - 1] ?? '';
  return BREAK_AFTER.includes(last) ? Math.max(0, cost - 0.12) : cost;
}

/**
 * 決まった行数のまま、行の長さが揃うように改行位置を選び直す。
 *
 * 🔴 前から詰めるだけ（貪欲）では、2行目が極端に短くなる。
 *    「こんにちは今日はとても / いい」のような改行は、収まってはいても
 *    テロップとしては読みにくく、手で直したくなる。
 *    行数を変えずに配り直すだけなので、縮小率も画面に収まることも変わらない。
 *
 * 文節数は多くても数十なので、総当たりに近い動的計画法で足りる。
 */
function balance(
  phrases: string[],
  measure: (text: string) => number,
  maxWidth: number,
  lineCount: number,
): string[] | null {
  const m = phrases.length;
  if (m === 0 || lineCount <= 1 || lineCount >= m) return null;

  // join(i, j) = phrases[i..j-1] を繋げた文字列
  const joined: string[][] = [];
  for (let i = 0; i < m; i++) {
    joined[i] = [];
    let buf = '';
    for (let j = i; j < m; j++) {
      buf += phrases[j];
      joined[i][j + 1] = buf;
    }
  }

  const INF = Infinity;
  /** best[i][k] = phrases[i..] を k 行に収めたときの最小点 */
  const best: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(lineCount + 1).fill(INF));
  const pick: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(lineCount + 1).fill(-1));
  best[m][0] = 0;

  for (let i = m - 1; i >= 0; i--) {
    for (let k = 1; k <= lineCount; k++) {
      for (let j = i + 1; j <= m; j++) {
        const rest = best[j][k - 1];
        if (rest === INF) continue;
        const text = joined[i][j];
        const cost = lineCost(measure(text), maxWidth, text);
        if (cost === INF) break; // これ以上伸ばしても収まらない
        if (cost + rest < best[i][k]) {
          best[i][k] = cost + rest;
          pick[i][k] = j;
        }
      }
    }
  }

  if (best[0][lineCount] === INF) return null;

  const lines: string[] = [];
  let i = 0;
  for (let k = lineCount; k > 0; k--) {
    const j = pick[i][k];
    if (j < 0) return null;
    lines.push(joined[i][j]);
    i = j;
  }
  return lines;
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
  opts: { minScale?: number; step?: number; breaks?: Breaks } = {},
): FitResult {
  const minScale = opts.minScale ?? 0.75;
  const step = opts.step ?? 0.05;

  let last: WrapResult | null = null;
  for (let scale = 1; scale >= minScale - 1e-9; scale -= step) {
    const result = wrapJapaneseByWidth((t) => measureAt(t, scale), text, maxWidth, opts.breaks);
    last = result;
    if (result.forcedBreaks === 0) {
      return { ...result, fontScale: Number(scale.toFixed(2)) };
    }
  }

  // ここまで来たら、最小倍率でも収まらない。文節途中で切るしかない。
  return { ...last!, fontScale: Number(minScale.toFixed(2)) };
}

/**
 * 「文節途中で切らない」に加えて「指定の行数に収める」まで満たす倍率を探す。
 *
 * テロップは1画面に出せる行数が決まっている（ショート動画なら2行）。
 * 行数を無視して倍率だけ決めると、収まらないぶんが次の画面に押し出され、
 * 押し出された側で今度は文節が割れる。両方を同時に満たす必要がある。
 */
export function fitToLines(
  measureAt: (text: string, scale: number) => number,
  text: string,
  maxWidth: number,
  maxLines: number,
  opts: { minScale?: number; step?: number; breaks?: Breaks } = {},
): FitResult {
  const minScale = opts.minScale ?? 0.7;
  const step = opts.step ?? 0.05;
  /*
    手で決めた改行のぶんは、行数の上限を必ず超えさせる。
    2行が上限だからと縮め続けても、3箇所で改行しろと言われている以上
    絶対に収まらない。最小倍率まで無駄に縮んだテロップができるだけになる。
  */
  const wanted = Math.max(maxLines, segmentsOf(text, opts.breaks).length);

  let last: WrapResult | null = null;
  for (let scale = 1; scale >= minScale - 1e-9; scale -= step) {
    const result = wrapJapaneseByWidth((t) => measureAt(t, scale), text, maxWidth, opts.breaks);
    last = result;
    if (result.forcedBreaks === 0 && result.lines.length <= wanted) {
      return { ...result, fontScale: Number(scale.toFixed(2)) };
    }
  }

  // どこまで縮めても収まらない。文節優先で妥協する（行数のはみ出しより読みやすい）。
  const fallback = fitJapanese(measureAt, text, maxWidth, opts);
  return fallback.forcedBreaks === 0
    ? fallback
    : { ...last!, fontScale: Number(minScale.toFixed(2)) };
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
  breaks?: Breaks,
): WrapResult {
  const lines: string[] = [];
  const phrases: string[] = [];
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

  // 手で決めた改行位置で先に区切る。指定が無ければ本文まるごと1つ。
  for (const segment of segmentsOf(text, breaks)) {
    const segPhrases = parser.parse(segment);
    phrases.push(...segPhrases);

    // まず前から詰めて、何行必要かを求める
    const greedy: string[] = [];
    let current = '';
    let forcedHere = 0;

    for (const phrase of segPhrases) {
      if (measure(phrase) > maxWidth) {
        if (current) {
          greedy.push(current);
          current = '';
        }
        const parts = splitByWidth(phrase);
        forcedHere += parts.length - 1;
        greedy.push(...parts.slice(0, -1));
        current = parts[parts.length - 1];
        continue;
      }

      if (!current || measure(current + phrase) <= maxWidth) {
        current += phrase;
      } else {
        greedy.push(current);
        current = phrase;
      }
    }
    if (current) greedy.push(current);

    forcedBreaks += forcedHere;

    // 行数はそのままに、長さが揃うよう配り直す。
    // 文節の途中で切った行がある場合は配り直せないので、前から詰めた結果を使う。
    const evened =
      forcedHere === 0 ? balance(segPhrases, measure, maxWidth, greedy.length) : null;
    lines.push(...(evened ?? greedy));
  }

  return {
    lines,
    forcedBreaks,
    totalBreaks: Math.max(0, lines.length - 1),
    phrases,
  };
}
