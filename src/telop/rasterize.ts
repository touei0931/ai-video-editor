/**
 * テロップを透過 PNG に焼く（書き出し用）。
 *
 * 🔴 プレビューと**同じ drawTelop() を通す**こと（§6 / T1）。
 *    ここで別実装を書いた瞬間に「プレビューと書き出しがずれる」が始まる。
 *
 * 動画と同じ解像度ちょうどで描く。
 * 違う大きさで描くと overlay 側で拡大縮小され、縁取りの太さが変わる。
 */
import { buildLines, drawTelop } from './render';
import { DEFAULT_STYLES, resolveStyle, type TelopStyle, type TelopStyleName } from './style';
import type { Frame, TelopCard } from './split';
import { laneOffsetY, laneStep, telopLanes } from './lanes';

type AnyCanvas = HTMLCanvasElement;

/**
 * 描画用の Canvas を作る。
 *
 * OffscreenCanvas は使わない。通常の canvas 要素なら
 * `toDataURL` で base64 を直接取れて、T1 で実績のある経路をそのまま使える。
 */
function makeCanvas(frame: Frame): AnyCanvas {
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  return canvas;
}

function toPngBase64(canvas: AnyCanvas): string {
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}

export interface RasterizedTelop {
  id: string;
  name: string;
  base64: string;
  /**
   * 何段目か。同じ時間に重なるテロップは段を分ける。
   * 🔴 書き出し側では段ごとに別の帯として重ねる。1本にまとめると、
   *    重なった2枚目が「前を短くする」形でしか出せない。
   */
  lane: number;
}

/** 何も描かれていない透過 PNG。テロップとテロップの間を埋めるのに使う。 */
export function renderBlank(frame: Frame): string {
  const canvas = makeCanvas(frame);
  // 空のままでも透過 PNG になるが、コンテキストを取っておかないと
  // 環境によっては書き出しが失敗する
  canvas.getContext('2d');
  return toPngBase64(canvas);
}

/**
 * 全カードを PNG にする。
 * 枚数が多い（20分素材で数百枚）ので、進捗を返しながら進む。
 */
export async function renderTelopPngs(
  cards: TelopCard[],
  frame: Frame,
  styles: Record<TelopStyleName, TelopStyle> = DEFAULT_STYLES,
  onProgress?: (done: number, total: number) => void,
): Promise<RasterizedTelop[]> {
  const canvas = makeCanvas(frame);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas を使えません');

  /*
    段の割り当て。
    🔴 プレビューと同じ telopLanes / laneStep を通すこと。
       ここで別に計算したら、画面で重なっていないのに書き出しで重なる。
  */
  const lanes = telopLanes(cards);
  const step = laneStep(cards, styles, frame);

  const out: RasterizedTelop[] = [];
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    ctx.clearRect(0, 0, frame.width, frame.height);

    // 🔴 プレビューと同じ resolveStyle / buildLines を通す。
    //    ここで別計算をしたら WYSIWYG が崩れる。
    const resolved = resolveStyle(styles, card.style, card.override, card.fontScale);
    drawTelop(
      ctx,
      {
        lines: buildLines(card.lines, card.highlight ?? undefined, resolved),
        style: resolved,
        position: card.positionOverride ?? resolved.position,
        offsetX: card.offsetX,
        offsetY: card.offsetY + laneOffsetY(card, lanes.get(card.id) ?? 0, styles, step),
      },
      frame,
    );

    out.push({
      id: card.id,
      name: `${card.id}.png`,
      base64: toPngBase64(canvas),
      lane: lanes.get(card.id) ?? 0,
    });

    // 描画をブロックし続けると進捗が出ないので、たまに手放す
    if (i % 20 === 19) await new Promise((r) => setTimeout(r, 0));
    onProgress?.(i + 1, cards.length);
  }

  return out;
}
