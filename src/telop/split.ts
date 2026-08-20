/**
 * テロップを「1画面ぶん」に分ける（②）。
 *
 * 🔴 この分割を Python 側で文字数だけでやってはいけない。
 *    実測すると「これがめちゃく / ちゃかたくて」のように文節の途中で切れる。
 *    sidecar/telop.py が返すのは**文の区切り**までで、
 *    1画面に収める量は BudouX の文節境界と Canvas の実測幅でここが決める。
 *
 * 時刻の対応:
 *    各画面の表示時刻は、単語のタイムスタンプから引く。
 *    そのため「単語列を連結したもの = 本文」という対応が崩れてはいけない
 *    （sidecar/telop.py の _clean_word を参照）。
 */
import { telopFontSize } from './render';
import {
  DEFAULT_STYLES,
  type TelopOverride,
  type TelopPosition,
  type TelopStyleName,
} from './style';
import { fitJapanese, fitToLines } from './wrap';

export interface TelopWord {
  text: string;
  srcStart: number;
  srcEnd: number;
}

/** sidecar/telop.py が返す文単位のテロップ */
export interface TelopUnit {
  id: string;
  srcStart: number;
  srcEnd: number;
  text: string;
  style: TelopStyleName;
  reason: string;
  /** 目立たせる語（「この5文字だけ黄色く大きく」） */
  highlight?: string | null;
  needsCheck: boolean;
  confidence: number;
  /** 確度の低い語の数。「なぜ要確認なのか」を画面に出すために持つ */
  lowWords: number;
  words: TelopWord[];
}

/** 実際に画面に出る1枚 */
export interface TelopCard {
  id: string;
  /** 元になった文単位テロップの id */
  unitId: string;
  srcStart: number;
  srcEnd: number;
  text: string;
  lines: string[];
  style: TelopStyleName;
  /**
   * この1枚だけ位置を変えたいときの上書き。
   * 未指定なら雛形（スタイル）の位置に従う。
   * 🔴 既定を雛形側に置くことで、300枚の位置を1操作で変えられる。
   */
  positionOverride?: TelopPosition;
  reason: string;
  /** 目立たせる語 */
  highlight?: string | null;
  needsCheck: boolean;
  confidence: number;
  lowWords: number;
  /** 文節途中の改行を避けるために縮めた倍率（1.0 なら等倍） */
  fontScale: number;
  /** 既定位置からのずらし量（画面サイズに対する比率） */
  offsetX: number;
  offsetY: number;
  /** この1枚だけのスタイル上書き */
  override?: TelopOverride;
  /** 人間が手で足したテロップか */
  manual?: boolean;
  /**
   * 人間が手を入れたか。
   * カットを直してテロップを作り直したとき、どれを引き継ぐべきかの判断に使う。
   */
  edited?: boolean;
  /**
   * 作られた時点の文言と開始時刻。人が直しても変えない。
   *
   * 🔴 引き継ぎの照合はこちらで行う。
   *    直したあとの文言で照合すると、直したものほど照合できない
   *    （文言を変えたことが、そのまま「別物」の判定になってしまう）。
   *    「作られ方が同じなら、その直しはまだ有効」という判断にしたい。
   */
  baseText?: string;
  baseStart?: number;
}

export interface Frame {
  width: number;
  height: number;
}

export interface SplitOptions {
  /** 1枚に出す最大行数。ショート動画では2行が上限 */
  maxLines?: number;
  /** 左右の余白（画面幅に対する比率） */
  marginRatio?: number;
  /** 1枚あたりの最短表示時間 */
  minDuration?: number;
}

/** テキストの幅を測る関数。フォントは書体ごとに幅が違うので family も受け取る。 */
export type Measure = (text: string, fontPx: number, family: string) => number;

/**
 * 文字位置 → 時刻。
 * 単語の文字数を積み上げて、その位置がどの単語に属するかを引く。
 */
function makeTimeLookup(words: TelopWord[]) {
  const bounds: { start: number; end: number; srcStart: number; srcEnd: number }[] = [];
  let at = 0;
  for (const w of words) {
    bounds.push({ start: at, end: at + w.text.length, srcStart: w.srcStart, srcEnd: w.srcEnd });
    at += w.text.length;
  }

  return {
    total: at,
    /** 文字位置 index から始まる単語の開始時刻 */
    startAt(index: number): number {
      for (const b of bounds) if (index < b.end) return b.srcStart;
      return bounds.length ? bounds[bounds.length - 1].srcEnd : 0;
    },
    /** 文字位置 index の直前で終わる単語の終了時刻 */
    endAt(index: number): number {
      for (let i = bounds.length - 1; i >= 0; i--) {
        if (bounds[i].start < index) return bounds[i].srcEnd;
      }
      return bounds.length ? bounds[0].srcStart : 0;
    },
  };
}

export function splitIntoCards(
  unit: TelopUnit,
  measure: Measure,
  frame: Frame,
  options: SplitOptions = {},
): TelopCard[] {
  const maxLines = options.maxLines ?? 2;
  const marginRatio = options.marginRatio ?? 0.08;
  const minDuration = options.minDuration ?? 0.5;

  const style = DEFAULT_STYLES[unit.style];
  const fontPx = telopFontSize(style, frame);
  const maxWidth = frame.width * (1 - marginRatio * 2);
  const measureAt = (t: string, scale: number) => measure(t, fontPx * scale, style.fontFamily);

  const text = unit.words.map((w) => w.text).join('');
  if (!text.trim()) return [];

  // 🔴 まず「文節途中で切らない」倍率を求めてから折り返す。
  //    等倍で折り返してから2行ずつ束ねると、束ねる前に文節途中の改行が確定してしまい、
  //    あとから縮めても直せない（「めちゃくちゃかた / くて」になる）。
  const all = fitJapanese(measureAt, text, maxWidth);

  // maxLines 行ずつまとめて1枚にする
  const chunks: string[] = [];
  for (let i = 0; i < all.lines.length; i += maxLines) {
    chunks.push(all.lines.slice(i, i + maxLines).join(''));
  }
  if (chunks.length === 0) chunks.push(text);

  const lookup = makeTimeLookup(unit.words);
  const cards: TelopCard[] = [];
  let offset = 0;

  chunks.forEach((chunk, i) => {
    const from = offset;
    const to = offset + chunk.length;
    offset = to;
    if (!chunk.trim()) return;

    // 1枚に決まったので、行数にも収まる範囲で一番大きい倍率を選び直す
    const fit = fitToLines(measureAt, chunk, maxWidth, maxLines);

    // 1枚だけなら、元の単位が持つ時間をそのまま使う（余韻の調整が入っているため）
    const srcStart = chunks.length === 1 ? unit.srcStart : lookup.startAt(from);
    let srcEnd = chunks.length === 1 ? unit.srcEnd : lookup.endAt(to);
    if (srcEnd - srcStart < minDuration) srcEnd = srcStart + minDuration;

    cards.push({
      id: chunks.length === 1 ? unit.id : `${unit.id}-${i}`,
      unitId: unit.id,
      srcStart: Number(srcStart.toFixed(3)),
      srcEnd: Number(srcEnd.toFixed(3)),
      text: chunk.trim(),
      baseText: chunk.trim(),
      baseStart: Number(srcStart.toFixed(3)),
      lines: fit.lines.map((l) => l.trim()).filter(Boolean),
      style: unit.style,
      reason: unit.reason,
      highlight: unit.highlight,
      needsCheck: unit.needsCheck,
      confidence: unit.confidence,
      lowWords: unit.lowWords,
      fontScale: fit.fontScale,
      offsetX: 0,
      offsetY: 0,
    });
  });

  // 分割で伸ばした結果、隣と重なることがある。後ろを優先して押し戻す。
  for (let i = 0; i < cards.length - 1; i++) {
    if (cards[i].srcEnd > cards[i + 1].srcStart) {
      cards[i].srcEnd = Number(Math.max(cards[i].srcStart + 0.1, cards[i + 1].srcStart - 0.02).toFixed(3));
    }
  }

  return cards;
}

/** 全ユニットを画面単位に展開する。隣り合うユニット間の重なりもここで解消する。 */
export function buildCards(
  units: TelopUnit[],
  measure: Measure,
  frame: Frame,
  options: SplitOptions = {},
): TelopCard[] {
  const cards = units.flatMap((u) => splitIntoCards(u, measure, frame, options));
  cards.sort((a, b) => a.srcStart - b.srcStart);

  for (let i = 0; i < cards.length - 1; i++) {
    if (cards[i].srcEnd > cards[i + 1].srcStart) {
      cards[i].srcEnd = Number(Math.max(cards[i].srcStart + 0.1, cards[i + 1].srcStart - 0.02).toFixed(3));
    }
  }
  return cards;
}

/** Canvas を使った幅の実測関数を作る。フォントの読み込みは呼び出し側で済ませておくこと。 */
export function makeMeasure(): Measure {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas を使えません');

  return (text, fontPx, family) => {
    ctx.font = `${fontPx}px "${family}"`;
    return ctx.measureText(text).width;
  };
}

/**
 * 1枚ぶんのテキストを折り返し直す。
 * 画面で文言やスタイルを直したときに使う（分割はやり直さない）。
 */
export function rewrapCard(
  text: string,
  styleName: TelopStyleName,
  measure: Measure,
  frame: Frame,
  options: SplitOptions = {},
): { lines: string[]; fontScale: number } {
  const marginRatio = options.marginRatio ?? 0.08;
  const style = DEFAULT_STYLES[styleName];
  const fontPx = telopFontSize(style, frame);
  const fit = fitToLines(
    (t, scale) => measure(t, fontPx * scale, style.fontFamily),
    text,
    frame.width * (1 - marginRatio * 2),
    options.maxLines ?? 2,
  );
  return { lines: fit.lines.map((l) => l.trim()).filter(Boolean), fontScale: fit.fontScale };
}
