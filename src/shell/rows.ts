/**
 * タイムラインで重なった区間を、どの段に置くか決める。
 *
 * 🔴 重なったまま同じ段に描かないこと。
 *    上に載ったほうしか見えず、下の1枚は**存在ごと隠れる**。
 *    選ぶことも消すこともできないのに書き出しには出てくる、という
 *    いちばん気づきにくい壊れ方をする。
 *
 * 🔴 段は下へ増やすこと（上ではなく）。
 *    上へ積むと、区間の縦位置が「他に何があるか」で変わってしまい、
 *    同じ場所を見ているのに毎回違う見え方になる。
 */

export interface RowItem {
  id: string;
  start: number;
  end: number;
}

/** 段数の上限。増やしすぎるとレーンだけで画面が埋まる */
export const MAX_ROWS = 4;

/**
 * 同じ段に置けるのは、その段の直前の区間が終わったあとから始まるものだけ。
 * 上限を超えたぶんは、いちばん下の段に重ねる（無限には増やさない）。
 */
export function assignRows(regions: readonly RowItem[]): Map<string, number> {
  const endOf: number[] = [];
  const out = new Map<string, number>();
  for (const r of [...regions].sort((a, b) => a.start - b.start || a.end - b.end)) {
    let row = endOf.findIndex((end) => r.start >= end - 0.0005);
    if (row < 0) {
      if (endOf.length >= MAX_ROWS) row = MAX_ROWS - 1;
      else {
        row = endOf.length;
        endOf.push(0);
      }
    }
    /*
      🔴 長さ0の区間も、その1点は塞ぐこと。

         「カット後」の目盛りでは、切られた範囲に入ったテロップは長さ0に潰れる。
         塞がないと同じ点の何枚もが同じ段に載り、1枚しか見えない。
         見えない1枚は選べず消せないのに、書き出しには出てくる。
    */
    endOf[row] = Math.max(endOf[row], r.end, r.start + 0.002);
    out.set(r.id, row);
  }
  return out;
}

/** 使う段の数。重なりが無ければ 1 なので、これまでと同じ高さになる */
export function rowCount(rows: Map<string, number> | null): number {
  if (!rows || rows.size === 0) return 1;
  let max = 0;
  for (const n of rows.values()) max = Math.max(max, n);
  return max + 1;
}
