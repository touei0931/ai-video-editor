/**
 * テロップを「1画面ぶん」に分ける（②）。
 *
 * 🔴 この分割を Python 側で文字数だけでやってはいけない。
 *    実測すると「これがめちゃく / ちゃかたくて」のように文節の途中で切れる。
 *    sidecar/telop.py が返すのは**文の区切り**までで、
 *    1画面に収める量は BudouX の文節境界と Canvas の実測幅でここが決める。
 *
 * 🔴 割る場所は、幅ではなく**話し手の区切り**から先に選ぶこと。
 *    幅だけで割ると「俺はサイヤ人になり / たいんだけどやっぱり自信がなくて」の
 *    ように、喋りと関係ない所で切れる。直すのに手間がかかると言われた
 *    （FCP プラグイン版で 2026-09-02。fcp-extension/webui/src/lib/splitTelop.ts）。
 *    優先順は、話し手の間 → 弱い間 → 文節の切れ目と幅。
 *
 * 時刻の対応:
 *    各画面の表示時刻は、単語のタイムスタンプから引く。
 *    そのため「単語列を連結したもの = 本文」という対応が崩れてはいけない
 *    （sidecar/telop.py の _clean_word を参照）。
 */
import { japaneseParser } from './budoux-ja';
import { cssFont, telopFontSize, type FontChoice } from './render';
import {
  DEFAULT_STYLES,
  effectiveStyle,
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
  /** この語のあとに息継ぎがある（エンジンが音で確かめた）。長さに関わらずここで割る */
  breakAfter?: boolean;
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
  /**
   * 誰の声か（登録した人の id）。無ければ null / 未判定は undefined。
   * 🔴 色は override.color が持つ（雛形は触らない）。ここは「誰か」の記録。
   */
  speaker?: string | null;
  /** 登録済みの声との類似度（0〜1）。低いものは画面で ⚠ を出す */
  speakerScore?: number;
  /** 誰にも当たらなかったときの声のまとまり（v1, v2…）。画面で名前を付ける手がかり */
  voice?: string | null;
  /** 人が「この声は◯◯」と決めた。見分け直しても動かさない */
  manualSpeaker?: boolean;
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

/**
 * これ以上の間があいたら、話し手がそこで区切ったとみなす。
 *
 * 🔴 エンジン（sidecar/telop.py）は 0.5秒を超える間で別のまとまりにする。
 *    そこまで行かない 0.3〜0.5秒の間が、まとまりの中に残る。人はそこで区切って喋っている。
 *    値はプラグイン版（splitTelop.ts の SPEECH_PAUSE）と同じ。
 */
export const SPEECH_PAUSE = 0.3;

/** 長すぎて割るしかないときに、区切りとして使ってよい最小の間 */
export const WEAK_PAUSE = 0.12;

/**
 * 語の並びの中で、間が空いている「文字位置」を返す。
 *
 * 🔴 時刻の隙間だけで見ないこと。Whisper の語の時刻は隣と隙間なく繋がるので、
 *    息継ぎは時刻に現れない。エンジンが音で確かめた印（breakAfter）を、
 *    間の長さに関わらず区切りとして扱う（プラグイン版 splitTelop.ts と同じ）。
 */
function pausePoints(words: TelopWord[], minPause: number): { at: number; gap: number }[] {
  const out: { at: number; gap: number }[] = [];
  let at = 0;
  for (let i = 0; i < words.length - 1; i++) {
    at += words[i].text.length;
    const gap = words[i + 1].srcStart - words[i].srcEnd;
    if (gap >= minPause || words[i].breakAfter) out.push({ at, gap });
  }
  return out;
}

/** 幅で割るしかないときの割り方。maxLines 行ずつまとめて1枚にする */
function chunkByWidth(
  measureAt: (text: string, scale: number) => number,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  // 🔴 まず「文節途中で切らない」倍率を求めてから折り返す。
  //    等倍で折り返してから2行ずつ束ねると、束ねる前に文節途中の改行が確定してしまい、
  //    あとから縮めても直せない（「めちゃくちゃかた / くて」になる）。
  const all = fitJapanese(measureAt, text, maxWidth);
  const chunks: string[] = [];
  for (let i = 0; i < all.lines.length; i += maxLines) {
    chunks.push(all.lines.slice(i, i + maxLines).join(''));
  }
  return chunks.length > 0 ? chunks : [text];
}

/**
 * 1つのまとまりを、1画面ぶんに割る。
 *
 * 優先順は、話し手の間 → 弱い間 → 文節の切れ目と幅。
 *   1) はっきりした間（SPEECH_PAUSE 以上）では、長さに関わらず切る
 *   2) それでも収まらない分は、真ん中に近い弱い間（WEAK_PAUSE 以上）で割る
 *   3) 間が無いのに収まらないものだけ、文節の切れ目と幅で割る（従来どおり）
 *
 * 🔴 「収まる」は、等倍で折り返して maxLines 行以内かで見る。
 *    文字数では見ない。幅は書体と大きさで変わる。
 */
export function chunksByPauses(
  text: string,
  words: TelopWord[],
  fits: (text: string) => boolean,
  chunkLong: (text: string) => string[],
): string[] {
  if (words.length === 0) return fits(text) ? [text] : chunkLong(text);

  // 1) はっきりした間では、長さに関わらず切る（そこが話し手の区切り）
  let pieces: { text: string; from: number }[] = [];
  let prev = 0;
  for (const p of pausePoints(words, SPEECH_PAUSE)) {
    pieces.push({ text: text.slice(prev, p.at), from: prev });
    prev = p.at;
  }
  pieces.push({ text: text.slice(prev), from: prev });
  pieces = pieces.filter((p) => p.text.length > 0);

  // 2) それでも長い分は、いちばん真ん中に近い弱い間で割る（端で切ると片方だけ長いまま）
  const weak = pausePoints(words, WEAK_PAUSE);
  const byWeakPause = (piece: { text: string; from: number }): typeof pieces => {
    if (fits(piece.text)) return [piece];
    const inside = weak.filter((g) => g.at > piece.from && g.at < piece.from + piece.text.length);
    if (inside.length === 0) return [piece];
    const mid = piece.from + piece.text.length / 2;
    const best = inside.reduce((a, b) => (Math.abs(a.at - mid) <= Math.abs(b.at - mid) ? a : b));
    const left = { text: text.slice(piece.from, best.at), from: piece.from };
    const right = { text: text.slice(best.at, piece.from + piece.text.length), from: best.at };
    return [...byWeakPause(left), ...byWeakPause(right)];
  };
  pieces = pieces.flatMap(byWeakPause);

  // 3) 間が無いのに長いものだけ、文節の切れ目と幅で割る
  return pieces.flatMap((p) => (fits(p.text) ? [p.text] : chunkLong(p.text)));
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

  // 🔴 描く側（resolveStyle）と同じ入口で雛形を決める。書体と大きさは通常に揃う
  const style = effectiveStyle(options.styles ?? DEFAULT_STYLES, unit.style);
  const fontPx = telopFontSize(style, frame);
  const maxWidth = frame.width * (1 - marginRatio * 2);
  // 強調する語は大きく描かれるので、測るほうでもそのぶん足す（measureWithHighlight）
  const measureAt = measureWithHighlight(measure, style, fontPx, unit.highlight);

  const text = unit.words.map((w) => w.text).join('');
  if (!text.trim()) return [];

  const fits = (t: string) => fitJapanese(measureAt, t, maxWidth).lines.length <= maxLines;
  const chunks = chunksByPauses(text, unit.words, fits, (t) =>
    chunkByWidth(measureAt, t, maxWidth, maxLines),
  );

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

/**
 * これ以上間が空いていたら、別の発言としてつながない。
 *
 * 🔴 実データから取ること（プラグイン版で実測）。
 *      無理やり割られた組: 間 -0.03秒 / 0.03秒（＝間が無い）
 *      本当の切れ目      : 間  0.40秒 / 0.53秒 / 0.60秒
 *    「間がほぼ無い」ことが、機械的に割られた印になる。
 *    0.4 にすると本当の切れ目までつないでしまう。
 */
export const JOIN_GAP = 0.15;

/**
 * つないでよい長さの上限。エンジンの保険上限（sidecar/telop.py の hard_max_chars = 40）で
 * 機械的に切られた組を直すのが目的なので、その2倍。つないだ後に必ず割り直す。
 */
const JOIN_MAX_CHARS = 80;

/** つなぎ目が文節の切れ目になっているか */
function isPhraseBoundary(a: string, b: string): boolean {
  let at = 0;
  for (const p of japaneseParser.parse(a + b)) {
    at += p.length;
    if (at === a.length) return true;
    if (at > a.length) return false;
  }
  return true;
}

/**
 * 語の途中で切れている隣どうしをつなぎ直す。
 *
 * 🔴 エンジンは**単語の時刻と文字数**でしか区切れない。
 *    句読点も間も無いまま喋り続けると 40文字の保険上限に当たり、そこで機械的に切れる。
 *    プラグイン版の実機で「…しづらさを減 / らすこともあります」と割れた（2026-08-31）。
 *    同じエンジンなので、こちらでも同じことが起きる。
 *
 * 🔴 つなぐのは「つなぎ目が文節の切れ目になっていない」ときだけ。
 *    切れ目として正しい所までつなぐと、1枚が長くなるだけで良いことがない。
 *    つないだものは必ず割り直すので（splitIntoCards）、長くなること自体は困らない。
 */

/**
 * その組の終わりが「意図した区切り」か。
 *
 * 🔴 ここを跨いで繋がないこと。繋ぎ直しは 40文字の保険で機械的に切られた組を
 *    直すためのもので、文の終わり（！？。）や息継ぎ（エンジンが音で確かめた印）は
 *    直す対象ではない。「行くぞ！」の直後にはっきり間があったのに、Whisper の時刻に
 *    間が吸われて 0 に見え、「行くぞ！やばいこれ」と繋がった（2026-09-12）。
 */
const SENTENCE_END = /[！!？?。]$/;
function endsDeliberately(text: string, words: TelopWord[] | undefined): boolean {
  if (SENTENCE_END.test(text.trim())) return true;
  const last = words?.[words.length - 1]
  return !!last?.breakAfter;
}

export function joinBrokenUnits(units: TelopUnit[]): TelopUnit[] {
  const out: TelopUnit[] = [];
  for (const u of units) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.style === u.style &&
      prev.words.length > 0 &&
      u.words.length > 0 &&
      u.srcStart - prev.srcEnd <= JOIN_GAP &&
      !endsDeliberately(prev.text, prev.words) &&
      prev.text.length + u.text.length <= JOIN_MAX_CHARS &&
      !isPhraseBoundary(prev.text, u.text)
    ) {
      out[out.length - 1] = {
        ...prev,
        text: prev.text + u.text,
        srcEnd: u.srcEnd,
        words: [...prev.words, ...u.words],
        // どちらかが要確認なら、つないだものも要確認
        needsCheck: prev.needsCheck || u.needsCheck,
        confidence: Math.min(prev.confidence, u.confidence),
        lowWords: prev.lowWords + u.lowWords,
        highlight: prev.highlight ?? u.highlight,
      };
      continue;
    }
    out.push(u);
  }
  return out;
}

/**
 * 全ユニットを画面単位に展開する。隣り合うユニット間の重なりもここで解消する。
 * 🔴 先につなぎ直してから割ること。割るだけでは、すでに割れているものを直せない。
 */
export function buildCards(
  units: TelopUnit[],
  measure: Measure,
  frame: Frame,
  options: SplitOptions = {},
): TelopCard[] {
  return resolveOverlaps(
    joinBrokenUnits(units).flatMap((u) => splitIntoCards(u, measure, frame, options)),
  );
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
  card: { sizeScale?: number; breaks?: number[]; highlight?: string | null } = {},
): { lines: string[]; fontScale: number } {
  const marginRatio = options.marginRatio ?? 0.08;
  // 🔴 描く側（resolveStyle）と同じ入口で雛形を決める。書体と大きさは通常に揃う
  const style = effectiveStyle(styles ?? DEFAULT_STYLES, styleName);
  const fontPx = telopFontSize(style, frame) * (card.sizeScale ?? 1);
  const fit = fitToLines(
    measureWithHighlight(measure, style, fontPx, card.highlight),
    text,
    frame.width * (1 - marginRatio * 2),
    options.maxLines ?? 2,
    { breaks: card.breaks },
  );
  return { lines: fit.lines.map((l) => l.trim()).filter(Boolean), fontScale: fit.fontScale };
}

/**
 * 強調する語のぶんまで含めて幅を測る関数を作る。
 *
 * 🔴 強調語は**他より大きく描かれる**（既定 1.15 倍 / style.highlightScale）。
 *    等倍で測って大きく描けば、その差だけ行が伸びて画面からはみ出す。
 *    しかもプレビューと書き出しは同じ計算を通るので、見比べても気づけない。
 *
 * 描画側（render.ts の drawTelop）は強調語だけ別サイズで測って足している。
 * 同じ分け方をここでも行う。
 */
function measureWithHighlight(
  measure: Measure,
  style: TelopStyle,
  fontPx: number,
  highlight?: string | null,
): (text: string, scale: number) => number {
  const word = highlight?.trim();
  if (!word) return (t, scale) => measure(t, fontPx * scale, style);

  const bigger = style.highlightScale ?? 1.15;
  return (t, scale) => {
    const px = fontPx * scale;
    let total = 0;
    let rest = t;
    while (rest.length > 0) {
      const at = rest.indexOf(word);
      if (at < 0) {
        total += measure(rest, px, style);
        break;
      }
      if (at > 0) total += measure(rest.slice(0, at), px, style);
      total += measure(word, Math.round(px * bigger), style);
      rest = rest.slice(at + word.length);
    }
    return total;
  };
}
