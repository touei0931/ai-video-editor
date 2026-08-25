/**
 * 同じ時間に出るテロップを、重ならないように段に分ける。
 *
 * 🔴 プレビューと書き出しは必ずここを通すこと。
 *    片方だけで段をずらすと、画面で整えたのに書き出したら重なる、
 *    という**書き出すまで気づけない**壊れ方をする。
 *
 * 🔴 段は「出ている間ずっと同じ」にすること。
 *    相手が消えた瞬間に位置を戻すと、テロップが画面上で飛び跳ねる。
 *    そのため段は素材全体で一度だけ割り当て、途中で変えない。
 *
 * 🔴 ずらす向きは、寄せている辺から**離れる**向き。
 *    下寄せなら上へ、上寄せ・中央なら下へ。
 *    「下にずらす」を一律にすると、下寄せのテロップが画面外へ出る。
 */

import { assignRows } from '../shell/rows';
import { telopFontSize } from './render';
import { resolveStyle, type StyleMap } from './style';
import type { Frame, TelopCard } from './split';

/** 段と段のすきま（テロップ1行ぶんに対する割合） */
const GAP_RATIO = 0.25;

/** どのテロップが何段目か。素材全体で一度だけ決める */
export function telopLanes(cards: readonly TelopCard[]): Map<string, number> {
  return assignRows(cards.map((c) => ({ id: c.id, start: c.srcStart, end: c.srcEnd })));
}

/**
 * 1段ぶんずらす量（画面の高さに対する割合）。
 *
 * 🔴 いちばん背の高いテロップに合わせること。
 *    自分の高さでずらすと、1行のテロップが2行のテロップに重なる。
 */
export function laneStep(cards: readonly TelopCard[], styles: StyleMap, frame: Frame): number {
  let tallest = 0;
  for (const c of cards) {
    const s = resolveStyle(styles, c.style, c.override, c.fontScale);
    const lineHeight = telopFontSize(s, frame) * s.lineHeightRatio;
    tallest = Math.max(tallest, lineHeight * Math.max(1, c.lines.length));
  }
  if (tallest === 0) return 0;
  return (tallest * (1 + GAP_RATIO)) / frame.height;
}

/**
 * そのテロップに足す縦のずらし量（画面の高さに対する割合）。
 * 0段目は 0。手で動かした分（offsetY）とは別に足す。
 */
export function laneOffsetY(
  card: TelopCard,
  lane: number,
  styles: StyleMap,
  step: number,
): number {
  if (lane <= 0 || step === 0) return 0;
  const s = resolveStyle(styles, card.style, card.override, card.fontScale);
  const position = card.positionOverride ?? s.position;
  // 下寄せは上へ、それ以外は下へ
  return position === 'bottom' ? -step * lane : step * lane;
}

/** いまの時刻に出ているテロップ（早いものから）。プレビューと書き出しで同じ順に描く */
export function activeAt(cards: readonly TelopCard[], t: number): TelopCard[] {
  return cards
    .filter((c) => t >= c.srcStart && t < c.srcEnd)
    .sort((a, b) => a.srcStart - b.srcStart || a.id.localeCompare(b.id));
}
