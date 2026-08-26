/**
 * テロップ同士の位置合わせ（吸着）。
 *
 * 🔴 計算はここだけに置くこと。
 *    プレビューの中で直に書くと、目で確かめるしかなくなる。
 *    「近いのに吸い付かない」「遠いのに吸い付く」は目視では詰め切れない。
 *
 * 🔴 合わせるのは左・中央・右／上・中央・下の9通り。
 *    人が「揃った」と感じるのはこの6本のライン。中途半端に
 *    左だけ見ていると、中央揃えにしたいときに手で合わせることになる。
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Snap {
  /** 動かす量（画素）。吸い付かなければ 0 */
  dx: number;
  dy: number;
  /** 吸い付いた線の位置（画素）。無ければ null */
  guideX: number | null;
  guideY: number | null;
}

/** 自分の縦のライン3本（左・中央・右） */
function xLines(b: Box): number[] {
  return [b.x, b.x + b.w / 2, b.x + b.w];
}

/** 自分の横のライン3本（上・中央・下） */
function yLines(b: Box): number[] {
  return [b.y, b.y + b.h / 2, b.y + b.h];
}

/**
 * 相手のラインに合わせるための移動量を出す。
 *
 * 🔴 いちばん近い1本だけに合わせること。
 *    複数に合わせようとすると、相手が増えるほど動かせなくなる。
 */
export function snapToBoxes(me: Box, others: readonly Box[], nearX: number, nearY: number): Snap {
  let bestX: { d: number; dx: number; at: number } | null = null;
  let bestY: { d: number; dy: number; at: number } | null = null;

  for (const other of others) {
    for (const mine of xLines(me)) {
      for (const theirs of xLines(other)) {
        const d = Math.abs(mine - theirs);
        if (d <= nearX && (!bestX || d < bestX.d)) bestX = { d, dx: theirs - mine, at: theirs };
      }
    }
    for (const mine of yLines(me)) {
      for (const theirs of yLines(other)) {
        const d = Math.abs(mine - theirs);
        if (d <= nearY && (!bestY || d < bestY.d)) bestY = { d, dy: theirs - mine, at: theirs };
      }
    }
  }

  return {
    dx: bestX ? bestX.dx : 0,
    dy: bestY ? bestY.dy : 0,
    guideX: bestX ? bestX.at : null,
    guideY: bestY ? bestY.at : null,
  };
}
