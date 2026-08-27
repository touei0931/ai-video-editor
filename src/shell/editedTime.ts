/**
 * 「元素材の時間」と「カット後の時間」を行き来する。
 *
 * カットを入れると、出来上がる動画の時間軸は元素材とずれる。
 * プレビューもコマ送りもテロップの時刻も、どちらの時間の話なのかを
 * はっきりさせないと必ず食い違う。
 *
 *   元素材:  0────A══B────C══D────終
 *            （══ が切る区間）
 *   カット後: 0────┬────┬────終
 *
 * 🔴 保存するものは必ず**元素材の時刻**で持つこと。
 *    カット後の時刻で持つと、カットを1つ直しただけで
 *    テロップの時刻が全部ずれる。カットは何度でも直すものなので、
 *    そのたびに校正がやり直しになる。
 *    表示と再生のときだけ、ここで変換する。
 */

export interface Cut {
  srcStart: number;
  srcEnd: number;
}

/** 残る区間。元素材の時刻と、出来上がりでの時刻を両方持つ */
export interface Segment {
  srcStart: number;
  srcEnd: number;
  outStart: number;
  outEnd: number;
}

/**
 * 切る区間を除いた「残る区間」を並べる。
 *
 * 重なった指定や、順序が入れ替わった指定が来ても壊れないように、
 * 先に整えてから引く。
 */
export function buildSegments(duration: number, cuts: readonly Cut[]): Segment[] {
  const merged: Cut[] = [];
  for (const c of [...cuts].sort((a, b) => a.srcStart - b.srcStart)) {
    const s = Math.max(0, Math.min(duration, c.srcStart));
    const e = Math.max(0, Math.min(duration, c.srcEnd));
    if (e <= s) continue;
    const last = merged[merged.length - 1];
    if (last && s <= last.srcEnd) last.srcEnd = Math.max(last.srcEnd, e);
    else merged.push({ srcStart: s, srcEnd: e });
  }

  const out: Segment[] = [];
  let cursor = 0;
  let acc = 0;
  for (const c of merged) {
    if (c.srcStart > cursor) {
      const len = c.srcStart - cursor;
      out.push({ srcStart: cursor, srcEnd: c.srcStart, outStart: acc, outEnd: acc + len });
      acc += len;
    }
    cursor = Math.max(cursor, c.srcEnd);
  }
  if (cursor < duration) {
    const len = duration - cursor;
    out.push({ srcStart: cursor, srcEnd: duration, outStart: acc, outEnd: acc + len });
  }
  return out;
}

/** 出来上がりの長さ（秒） */
export function outputDuration(segments: readonly Segment[]): number {
  return segments.length ? segments[segments.length - 1].outEnd : 0;
}

/**
 * カット後の時刻 → 元素材の時刻。
 * プレビューで「次にどこを再生すべきか」を決めるのに使う。
 */
export function toSource(segments: readonly Segment[], outTime: number): number {
  if (segments.length === 0) return outTime;
  const t = Math.max(0, outTime);
  for (const s of segments) {
    if (t < s.outEnd) return s.srcStart + Math.max(0, t - s.outStart);
  }
  const last = segments[segments.length - 1];
  return last.srcEnd;
}

/**
 * 元素材の時刻 → カット後の時刻。
 *
 * 🔴 切られた場所を渡されたときの扱いを決めておくこと。
 *    ここでは「その次に残る場所の頭」を返す。null を返す作りにすると、
 *    呼ぶ側が毎回 null を捌くことになり、抜けたところで表示が飛ぶ。
 */
export function toOutput(segments: readonly Segment[], srcTime: number): number {
  if (segments.length === 0) return srcTime;
  for (const s of segments) {
    if (srcTime < s.srcStart) return s.outStart;
    if (srcTime < s.srcEnd) return s.outStart + (srcTime - s.srcStart);
  }
  return outputDuration(segments);
}

/** その元素材の時刻が切られているか */
export function isCut(segments: readonly Segment[], srcTime: number): boolean {
  return !segments.some((s) => srcTime >= s.srcStart && srcTime < s.srcEnd);
}

/**
 * 再生中に「いま切る区間へ入った」ときの飛び先を返す。
 * 入っていなければ null。
 *
 * プレビューはこれを毎コマ見て、切る区間に入った瞬間に次へ飛ばす。
 */
export function skipTarget(segments: readonly Segment[], srcTime: number): number | null {
  for (const s of segments) {
    if (srcTime >= s.srcStart && srcTime < s.srcEnd) return null; // 残る区間の中
    if (srcTime < s.srcStart) return s.srcStart; // 切る区間の中。次の頭へ
  }
  return null; // 最後の残る区間より後ろ = 終わり
}

/** 切り込みで分けた、残っている素材のひとかたまり */
export interface Clip {
  id: string;
  start: number;
  end: number;
}

/**
 * 残る区間を、切り込みの位置で割って「クリップ」にする。
 *
 * 🔴 切る区間はクリップにしないこと。
 *    もう消える所を並べると、選んで消したときに二重に切ることになる。
 *
 * 🔴 端ちょうどの切り込みは無視すること。
 *    長さ0のクリップができて、掴めないものがタイムラインに残る。
 *
 * 🔴 id は位置から作ること。連番にすると、前の方に1つ切り込みを
 *    入れただけで後ろ全部の番号がずれ、選んでいたクリップが化ける。
 */
export function splitIntoClips(segments: readonly Segment[], blades: readonly number[]): Clip[] {
  const sorted = [...blades].sort((a, b) => a - b);
  const out: Clip[] = [];
  for (const sg of segments) {
    const inside = sorted.filter((b) => b > sg.srcStart + 0.001 && b < sg.srcEnd - 0.001);
    let from = sg.srcStart;
    for (const edge of [...inside, sg.srcEnd]) {
      out.push({
        id: `clip@${from.toFixed(3)}`,
        start: Number(from.toFixed(3)),
        end: Number(edge.toFixed(3)),
      });
      from = edge;
    }
  }
  return out;
}

/** その時刻を含むクリップ。切り取られる所にいるなら null */
export function clipContaining(clips: readonly Clip[], t: number): Clip | null {
  return clips.find((c) => t >= c.start - 0.001 && t <= c.end + 0.001) ?? null;
}
