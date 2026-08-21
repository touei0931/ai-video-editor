/**
 * テロップ描画（設計レポート §6）。
 *
 * 🔴 このファイルが T1 の核心です。
 *
 * **プレビューも書き出しも、必ずこの drawTelop() を通すこと。**
 * プレビューを CSS で書いて書き出しを別実装にすると必ずずれる（§15 アンチパターン9）。
 * 同じ Canvas コードを通すことで、見た目の一致が「気をつける」ではなく
 * **構造として保証される**。
 *
 * 書き出し時は、この関数で描いた Canvas を透過 PNG にして
 * ffmpeg の overlay で焼き込む。
 */
import type { TelopLine, TelopSpan, TelopSpec } from './style';

/** 描画対象。DOM の CanvasRenderingContext2D と OffscreenCanvas の両方を受ける。 */
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface Frame {
  width: number;
  height: number;
}

/**
 * 位置ごとの、画面高さに対する基準線の比率。
 *
 * 🔴 top は**1行目**のベースライン、bottom は**最終行**のベースライン。
 *    どちらも1行目基準にすると、2行になったとき下端が下へずれる。
 *    1行と2行が混ざる素材では、テロップの下端が行ごとに上下してガタつく。
 *    人間は「下から何px」で揃えるので、下寄せは最終行を基準にする。
 *
 * 値はセーフエリア（SAFE_AREA_RATIO）の内側に収めてある。
 */
const POSITION_RATIO: Record<TelopSpec['position'], number> = {
  top: 0.16,
  middle: 0.5,
  bottom: 0.8,
};

/** 行を区切りの列に正規化する。文字列はそのまま1区切り。 */
function toSpans(line: TelopLine): TelopSpan[] {
  return typeof line === 'string' ? [{ text: line }] : line;
}

/**
 * 文字の大きさ。
 *
 * 🔴 画面の**短辺**を基準にすること。
 *    幅基準にすると、縦動画（1080x1920）で合わせた比率が
 *    横動画（1920x1080）では倍近い大きさになる。
 *    短辺基準なら、縦でも横でも同じ「画面に対する文字の大きさ」になる。
 *    （T1 は縦 1080x1920 で検証したので、短辺=幅。結果は変わらない）
 */
export function telopFontSize(style: TelopSpec['style'], frame: Frame): number {
  return Math.round(Math.min(frame.width, frame.height) * style.fontSizeRatio);
}

/** 書体の指定に必要なぶんだけ。幅を測るときも描くときも、これだけあれば足りる */
export type FontChoice = Pick<TelopSpec['style'], 'fontFamily' | 'bold' | 'italic'>;

/**
 * Canvas に渡す書体の指定を作る。
 *
 * 🔴 描くときと**幅を測るとき**で必ず同じものを使うこと。
 *    太字や斜体は字の幅を変える。測るほうだけ普通の太さで測ると、
 *    折り返しの位置が実際の描画とずれて画面からはみ出す。
 *    そのためにこの関数を1つだけ置き、両方から呼ぶ。
 *
 * 太字（700）は同梱の太いファイルが使われる。持っていない書体では
 * ブラウザが輪郭を太らせた偽の太字になる（fonts.ts の hasRealBold）。
 * 斜体は日本語書体に実物が無いので、どの書体でも傾けて作られる。
 */
export function cssFont(font: FontChoice, px: number): string {
  const slant = font.italic ? 'italic ' : '';
  const weight = font.bold ? '700 ' : '';
  return `${slant}${weight}${px}px "${font.fontFamily}"`;
}

/**
 * テロップを描く。呼び出し側は事前にフォントのロードを済ませておくこと
 * （ロード前に描くとフォールバックフォントで描かれ、見た目が変わる）。
 */
export function drawTelop(ctx: Ctx2D, spec: TelopSpec, frame: Frame): void {
  const { lines, style, position } = spec;
  if (lines.length === 0) return;

  const fontSize = telopFontSize(style, frame);
  const lineHeight = Math.round(fontSize * style.lineHeightRatio);

  ctx.save();
  // 区切りごとに大きさが変わるので、中央揃えは自前で計算する
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // 縁取りは角を丸めないと、太くしたときに尖ったヒゲが出る
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const blockHeight = lineHeight * (lines.length - 1);
  // 人間が手で動かした分を足す。既定位置からの相対なので、
  // 解像度が変わっても同じ見え方になる。
  const baseY = Math.round(frame.height * (POSITION_RATIO[position] + (spec.offsetY ?? 0)));
  // middle は全体の中央、bottom は最終行を基準に合わせる
  const startY =
    position === 'middle' ? baseY - blockHeight / 2 : position === 'bottom' ? baseY - blockHeight : baseY;
  const centerX = frame.width * (0.5 + (spec.offsetX ?? 0));

  lines.forEach((line, i) => {
    const spans = toSpans(line).filter((s) => s.text.length > 0);
    if (spans.length === 0) return;
    const y = Math.round(startY + lineHeight * i);

    // 中央に置くために、まず行全体の幅を測る
    const widths = spans.map((s) => {
      ctx.font = cssFont(style, Math.round(fontSize * (s.scale ?? 1)));
      return ctx.measureText(s.text).width;
    });
    const total = widths.reduce((a, b) => a + b, 0);

    let x = Math.round(centerX - total / 2);
    spans.forEach((span, j) => {
      const size = Math.round(fontSize * (span.scale ?? 1));
      ctx.font = cssFont(style, size);

      if (style.stroke) {
        // Canvas の stroke はパスの中心に乗るので、見た目の太さは指定の半分になる。
        // 「縁取りの太さ」を直感どおりにするため 2 倍して指定する。
        ctx.lineWidth = size * style.stroke.widthRatio * 2;
        ctx.strokeStyle = span.strokeColor ?? style.stroke.color;
        ctx.strokeText(span.text, x, y);
      }

      ctx.fillStyle = span.color ?? style.color;
      ctx.fillText(span.text, x, y);
      x += widths[j];
    });
  });

  ctx.restore();
}

/** 0〜1 の3つ組にする。#rrggbb 以外は白 */
function toRgb(hex: string | undefined): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
  if (!m) return [1, 1, 1];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

/** Final Cut Pro へ渡す見た目ひとつぶん */
export interface FcpLook {
  font: string;
  font_face: string;
  font_size: number;
  color: [number, number, number];
  italic: boolean;
  stroke_color: [number, number, number] | null;
  stroke_width: number;
  position: [number, number];
}

/**
 * 描くときのスタイルを、Final Cut Pro のタイトルの見た目に写す。
 *
 * 🔴 完全には一致しない。
 *    こちらは Canvas に自前で描いていて、向こうは Basic Title という別の部品。
 *    行送り・縁取りの角の丸め・字間の扱いが違うので、**近い見た目**までしか行かない。
 *    それでも「文字と時間だけ」よりはるかにマシで、向こうで直す量が減る。
 *
 * 位置は、こちらの「基準線の高さ」から中心座標に直したもの。
 * Final Cut の座標は画面中央が原点で、上が正。
 */
export function fcpLook(
  style: TelopSpec['style'],
  position: TelopSpec['position'],
  frame: Frame,
  macFont: { font: string; face: string },
  offsetX = 0,
  offsetY = 0,
): FcpLook {
  const fontSize = telopFontSize(style, frame);
  const ratio = POSITION_RATIO[position] + offsetY;
  return {
    font: macFont.font,
    font_face: macFont.face,
    font_size: fontSize,
    color: toRgb(style.color),
    italic: Boolean(style.italic),
    stroke_color: style.stroke ? toRgb(style.stroke.color) : null,
    // Canvas 側は lineWidth を2倍にして「見た目の太さ」を fontSize*widthRatio に合わせている。
    // Final Cut の strokeWidth はその見た目の太さそのものなので、同じ値を渡す。
    stroke_width: style.stroke ? Math.round(fontSize * style.stroke.widthRatio * 100) / 100 : 0,
    position: [
      Math.round(frame.width * offsetX * 10) / 10,
      Math.round(frame.height * (0.5 - ratio) * 10) / 10,
    ],
  };
}

/** 区切りの列から素のテキストを取り出す。 */
export function lineText(line: TelopLine): string {
  return typeof line === 'string' ? line : line.map((s) => s.text).join('');
}

/**
 * 素の行に「強調する語」を適用して、描画用の区切り列にする。
 *
 * 🔴 プレビューも書き出しも必ずこの関数を通すこと（§6）。
 *    カード側は素の文字列のまま持ち、色や大きさは描く直前に決める。
 *    こうしておくと、雛形の色を変えたときに保存済みの行を作り直さずに済む。
 */
export function buildLines(
  lines: string[],
  highlight: string | undefined,
  style: TelopSpec['style'],
): TelopLine[] {
  const word = highlight?.trim();
  if (!word) return lines;

  const color = style.highlightColor ?? '#ffe14d';
  const scale = style.highlightScale ?? 1.15;

  return lines.map((line) => {
    if (!line.includes(word)) return line;
    const spans: TelopSpan[] = [];
    let rest = line;
    while (rest.length > 0) {
      const at = rest.indexOf(word);
      if (at < 0) {
        spans.push({ text: rest });
        break;
      }
      if (at > 0) spans.push({ text: rest.slice(0, at) });
      spans.push({ text: word, color, scale });
      rest = rest.slice(at + word.length);
    }
    return spans;
  });
}

/**
 * 1行あたりの最大文字数の目安。
 * 実際の改行位置は BudouX が文節単位で決めるが（§6.6 / T2）、
 * その「何文字で折り返すか」の入力値をここで求める。
 */
export function maxCharsPerLine(spec: TelopSpec, frame: Frame, marginRatio = 0.08): number {
  const fontSize = telopFontSize(spec.style, frame);
  const usable = frame.width * (1 - marginRatio * 2);
  return Math.max(1, Math.floor(usable / fontSize));
}
