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
import type { TelopSpec } from './style';

/** 描画対象。DOM の CanvasRenderingContext2D と OffscreenCanvas の両方を受ける。 */
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface Frame {
  width: number;
  height: number;
}

/** 位置ごとの、画面高さに対する基準線（1行目のベースライン位置）の比率。 */
const POSITION_RATIO: Record<TelopSpec['position'], number> = {
  top: 0.14,
  middle: 0.5,
  bottom: 0.82,
};

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
  ctx.font = `${fontSize}px "${style.fontFamily}"`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  // 縁取りは角を丸めないと、太くしたときに尖ったヒゲが出る
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const blockHeight = lineHeight * (lines.length - 1);
  const baseY = Math.round(frame.height * POSITION_RATIO[position]);
  // middle のときだけ、ブロック全体が中央に来るように上へずらす
  const startY = position === 'middle' ? baseY - blockHeight / 2 : baseY;
  const centerX = Math.round(frame.width / 2);

  lines.forEach((line, i) => {
    const y = Math.round(startY + lineHeight * i);

    if (style.stroke) {
      // Canvas の stroke はパスの中心に乗るので、見た目の太さは指定の半分になる。
      // 「縁取りの太さ」を直感どおりにするため 2 倍して指定する。
      ctx.lineWidth = fontSize * style.stroke.widthRatio * 2;
      ctx.strokeStyle = style.stroke.color;
      ctx.strokeText(line, centerX, y);
    }

    ctx.fillStyle = style.color;
    ctx.fillText(line, centerX, y);
  });

  ctx.restore();
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
