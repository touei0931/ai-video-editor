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
import { cssFont, telopFontSize, type FontChoice } from './render';
import {
  DEFAULT_STYLES,
  type TelopOverride,
  type TelopPosition,
  type TelopStyle,
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
  /**
   * 手で決めた改行位置（本文の先頭から数えた文字数）。
   * 未指定なら、幅に収まらなくなったところで自動的に折り返す。
   */
  breaks?: number[];
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
  /**
   * 今の雛形。省略すると既定の雛形で計算する。
   *
   * 🔴 既定を保存できるようにした以上、ここを省略してはいけない。
   *    利用者が明朝体を既定にしていても、幅の計算だけゴシック体で行われ、
   *    テロップが画面からはみ出したまま作られる。
   */
  styles?: Record<TelopStyleName, TelopStyle>;
}

/**
 * テキストの幅を測る関数。
 *
 * 🔴 書体だけでなく**太字・斜体まで**受け取ること。
 *    太さが変われば字の幅も変わる。普通の太さで測って太字で描くと、
 *    折り返しの位置が実際とずれてテロップが画面からはみ出す。
 *    しかもプレビューと書き出しは同じようにはみ出すので、見比べても気づけない。
 */
export type Measure = (text: string, fontPx: number, font: FontChoice) => number;

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

  const style = (options.styles ?? DEFAULT_STYLES)[unit.style];
  const fontPx = telopFontSize(style, frame);
  const maxWidth = frame.width * (1 - marginRatio * 2);
  const measureAt = (t: string, scale: number) => measure(t, fontPx * scale, style);

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

  return resolveOverlaps(cards);
}

/** 重なりを直したあと、1枚に最低限見せる時間 */
const MIN_VISIBLE = 0.25;

/**
 * テロップが時間的に重ならないように直す。
 *
 * 🔴 **遅らせるのではなく、前を切り上げること。**
 *    書き出しのテロップ列は1本の帯（concat）なので、重なりがあると
 *    「前が消えるまで次が出ない」という形で必ず後ろへずれる。
 *    テロップの開始時刻はその言葉が発せられた時刻そのものなので、
 *    ずらすと声と文字が合わなくなる。**開始時刻は動かさない**のが正しい。
 *    前のテロップは、次が出るまで表示されていれば役目を果たしている。
 *
 * 例外は「次が始まるまでに前が一瞬しか映らない」場合だけ。
 * 切り上げると点滅にしか見えないので、そこだけは次を少し（最大 0.25 秒）待たせる。
 */
export function resolveOverlaps(cards: TelopCard[]): TelopCard[] {
  const out = [...cards]
    .sort((a, b) => a.srcStart - b.srcStart || a.srcEnd - b.srcEnd)
    .map((c) => ({ ...c }));

  for (let i = 0; i < out.length - 1; i++) {
    const cur = out[i];
    const next = out[i + 1];
    if (cur.srcEnd <= next.srcStart) continue;

    if (next.srcStart - cur.srcStart >= MIN_VISIBLE) {
      // 次が出る瞬間まで出しておく。声と文字のずれはここでは生まれない。
      cur.srcEnd = Number(next.srcStart.toFixed(3));
    } else {
      // 前が一瞬になってしまう。ここだけは次を待たせる。
      cur.srcEnd = Number((cur.srcStart + MIN_VISIBLE).toFixed(3));
      next.srcStart = cur.srcEnd;
      if (next.srcEnd < next.srcStart + MIN_VISIBLE) {
        next.srcEnd = Number((next.srcStart + MIN_VISIBLE).toFixed(3));
      }
    }
  }

  return out;
}

/** 全ユニットを画面単位に展開する。隣り合うユニット間の重なりもここで解消する。 */
export function buildCards(
  units: TelopUnit[],
  measure: Measure,
  frame: Frame,
  options: SplitOptions = {},
): TelopCard[] {
  return resolveOverlaps(units.flatMap((u) => splitIntoCards(u, measure, frame, options)));
}

/** Canvas を使った幅の実測関数を作る。フォントの読み込みは呼び出し側で済ませておくこと。 */
export function makeMeasure(): Measure {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas を使えません');

  return (text, fontPx, font) => {
    // 🔴 描くときと同じ cssFont を通す。太字・斜体で字の幅が変わるため
    ctx.font = cssFont(font, fontPx);
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
  /**
   * 今の雛形。省略すると既定の雛形で計算する。
   *
   * 🔴 雛形を編集したら、必ずここに渡すこと。
   *    描画側（resolveStyle）は編集後の値を使うのに、折り返しの計算だけが
   *    DEFAULT_STYLES を見ていた。そのため「大きさ」を 0.085 → 0.16 に上げると
   *    行の幅は 0.085 基準のまま文字だけ大きくなり、**画面外へはみ出したまま書き出される**。
   *    プレビューと書き出しは一致するので、両方おかしいことに気づけない。
   */
  styles?: Record<TelopStyleName, TelopStyle>,
  /**
   * この1枚だけの事情。
   *
   * 🔴 sizeScale を渡さないと、「この1枚の大きさ」を変えたときに折り返しが古いままになる。
   *    小さくしたのに 2行のまま、大きくしたら画面からはみ出す、という形で出る。
   *    描画側（resolveStyle）は sizeScale を掛けるので、測るほうも掛けないと合わない。
   */
  card: { sizeScale?: number; breaks?: number[] } = {},
): { lines: string[]; fontScale: number } {
  const marginRatio = options.marginRatio ?? 0.08;
  const style = styles?.[styleName] ?? DEFAULT_STYLES[styleName];
  const fontPx = telopFontSize(style, frame) * (card.sizeScale ?? 1);
  const fit = fitToLines(
    (t, scale) => measure(t, fontPx * scale, style),
    text,
    frame.width * (1 - marginRatio * 2),
    options.maxLines ?? 2,
    { breaks: card.breaks },
  );
  return { lines: fit.lines.map((l) => l.trim()).filter(Boolean), fontScale: fit.fontScale };
}
