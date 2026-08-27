/**
 * 並べた画面のテロップを、プレビューにも書き出しにも同じ形で出す。
 *
 * 🔴 プレビューを CSS で描かないこと。
 *    ここは以前、プレビューだけ HTML の div に文字を置いていた。
 *    渡す先が Final Cut だけだった頃は「だいたいの位置」で足りたが、
 *    PAC 自身が動画を書き出すようになった今、
 *    **画面で見たものと書き出したものが別物になる**。
 *    位置・折り返し・縁取り・大きさ、全部ずれる。
 *    しかも「書き出してから気づく」形でしか出てこない。
 *
 *    通す道は1本にする: resolveStyle → rewrapCard → buildLines → drawTelop。
 *    書き出し（telop/rasterize.ts）が通るのと同じ道。
 *
 * 🔴 テロップの時刻は**タイムライン上の時刻**に直してから札にすること。
 *    Telop 自体は素材の中の時刻を持っている（クリップを動かしても付いてくるように）。
 *    段の割り当ては「同じ時間に重なっているか」で決まるので、
 *    素材の時刻のまま渡すと、画面では重なっていないものが同じ段に落ちる。
 */

import { drawTelop, buildLines, type Frame } from '../telop/render';
import { laneOffsetY, laneStep, telopLanes } from '../telop/lanes';
import { makeMeasure, rewrapCard, type Measure, type TelopCard } from '../telop/split';
import { DEFAULT_STYLES, resolveStyle, type TelopStyle, type TelopStyleName } from '../telop/style';
import type { PlacedTelop } from './project';

export type TelopStyles = Record<TelopStyleName, TelopStyle>;

export { DEFAULT_STYLES };

/**
 * 置き場所の決まったテロップを、描ける札にする。
 *
 * 🔴 札の id は「テロップ + クリップ」で作ること。
 *    1つのテロップは、クリップを分ければ2つのクリップの上に出る。
 *    テロップの id だけで作ると札がぶつかり、
 *    書き出しでは**後の1枚しか PNG が残らない**。
 */
export function buildTimelineCards(
  telops: readonly PlacedTelop[],
  frame: Frame,
  styles: TelopStyles = DEFAULT_STYLES,
  measure?: Measure,
): TelopCard[] {
  if (telops.length === 0) return [];
  const m = measure ?? makeMeasure();

  return telops.map((t) => {
    const { lines, fontScale } = rewrapCard(t.text, t.style, m, frame, {}, styles, {});
    return {
      id: `${t.id}@${t.clipId}`,
      unitId: t.id,
      // 🔴 タイムライン上の時刻を入れる。素材の中の時刻ではない
      srcStart: t.start,
      srcEnd: t.end,
      text: t.text,
      lines,
      style: t.style,
      reason: 'timeline',
      needsCheck: false,
      confidence: 1,
      lowWords: 0,
      fontScale,
      offsetX: 0,
      offsetY: 0,
    };
  });
}

/** 段の割り当て。プレビューと書き出しで必ず同じものを使う */
export interface TelopLayout {
  lanes: Map<string, number>;
  step: number;
}

export function telopLayout(
  cards: readonly TelopCard[],
  styles: TelopStyles,
  frame: Frame,
): TelopLayout {
  const list = cards as TelopCard[];
  return { lanes: telopLanes(list), step: laneStep(list, styles, frame) };
}

/**
 * その時刻に出ているテロップを描く。
 *
 * 🔴 描く前に必ず消すこと。透過のまま重ねると、前のコマの文字が残る。
 */
export function drawCardsAt(
  ctx: CanvasRenderingContext2D,
  cards: readonly TelopCard[],
  layout: TelopLayout,
  styles: TelopStyles,
  frame: Frame,
  time: number,
): number {
  ctx.clearRect(0, 0, frame.width, frame.height);
  let drawn = 0;

  for (const card of cards) {
    if (time < card.srcStart || time >= card.srcEnd) continue;
    const resolved = resolveStyle(styles, card.style, card.override, card.fontScale);
    drawTelop(
      ctx,
      {
        lines: buildLines(card.lines, card.highlight ?? undefined, resolved),
        style: resolved,
        position: card.positionOverride ?? resolved.position,
        offsetX: card.offsetX,
        offsetY:
          card.offsetY + laneOffsetY(card, layout.lanes.get(card.id) ?? 0, styles, layout.step),
      },
      frame,
    );
    drawn += 1;
  }
  return drawn;
}
