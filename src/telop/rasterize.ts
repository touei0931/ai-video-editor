/**
 * テロップを透過 PNG に焼く（書き出し用）。
 *
 * 🔴 プレビューと**同じ drawTelop() を通す**こと（§6 / T1）。
 *    ここで別実装を書いた瞬間に「プレビューと書き出しがずれる」が始まる。
 *
 * 動画と同じ解像度ちょうどで描く。
 * 違う大きさで描くと overlay 側で拡大縮小され、縁取りの太さが変わる。
 */
import { drawTelop } from './render';
import { DEFAULT_STYLES } from './style';
import type { Frame, TelopCard } from './split';

function makeCanvas(frame: Frame): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(frame.width, frame.height);
  }
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  return canvas;
}

async function toPngBytes(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Uint8Array> {
  const blob =
    'convertToBlob' in canvas
      ? await canvas.convertToBlob({ type: 'image/png' })
      : await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG に変換できませんでした'))), 'image/png'),
        );
  return new Uint8Array(await blob.arrayBuffer());
}

export interface RasterizedTelop {
  id: string;
  name: string;
  bytes: Uint8Array;
}

/** 何も描かれていない透過 PNG。テロップとテロップの間を埋めるのに使う。 */
export async function renderBlank(frame: Frame): Promise<Uint8Array> {
  const canvas = makeCanvas(frame);
  return toPngBytes(canvas);
}

/**
 * 全カードを PNG にする。
 * 枚数が多い（20分素材で数百枚）ので、進捗を返しながら進む。
 */
export async function renderTelopPngs(
  cards: TelopCard[],
  frame: Frame,
  onProgress?: (done: number, total: number) => void,
): Promise<RasterizedTelop[]> {
  const canvas = makeCanvas(frame);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('Canvas を使えません');

  const out: RasterizedTelop[] = [];
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    ctx.clearRect(0, 0, frame.width, frame.height);

    const base = DEFAULT_STYLES[card.style];
    drawTelop(
      ctx,
      {
        lines: card.lines,
        // 縮小して収めた場合はその倍率を反映する。プレビューと同じ計算にすること。
        style: { ...base, fontSizeRatio: base.fontSizeRatio * card.fontScale },
        position: card.position,
      },
      frame,
    );

    out.push({ id: card.id, name: `${card.id}.png`, bytes: await toPngBytes(canvas) });

    // 描画をブロックし続けると進捗が出ないので、たまに手放す
    if (i % 20 === 19) await new Promise((r) => setTimeout(r, 0));
    onProgress?.(i + 1, cards.length);
  }

  return out;
}
