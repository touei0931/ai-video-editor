/**
 * 重なった区間の段組みを検める。
 *
 * 🔴 重なりを同じ段に描くと、下の1枚は選ぶことも消すこともできないのに
 *    書き出しには出てくる。画面を見ても気づけないので、机上で潰しておく。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// TypeScript をそのまま読めないので、型注釈だけ落として評価する
const src = readFileSync(join(root, 'src/shell/rows.ts'), 'utf8')
  .replace(/^export interface[\s\S]*?\n}\n/gm, '')
  .replace(/new Map<[^>]*>/g, 'new Map')
  .replace(/: Map<[^>]*>( \| null)?/g, '')
  .replace(/: readonly \w+\[\]/g, '')
  .replace(/: \w+\[\] =/g, ' =')
  .replace(/: number(?!\w)/g, '')
  .replace(/: string(?!\w)/g, '')
  .replace(/^export /gm, '');

const mod = new Function(`${src}; return { assignRows, rowCount, MAX_ROWS };`)();
const { assignRows, rowCount, MAX_ROWS } = mod;

let failed = 0;
const check = (name, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) {
    console.log(`OK   ${name}`);
  } else {
    console.error(`NG   ${name}\n     期待: ${b}\n     実際: ${a}`);
    failed++;
  }
};

const rowsOf = (list) => {
  const m = assignRows(list);
  return list.map((r) => m.get(r.id));
};

// 重なっていなければ全部おなじ段（＝これまでと同じ高さのまま）
check(
  '重ならない3つは同じ段',
  rowsOf([
    { id: 'a', start: 0, end: 1 },
    { id: 'b', start: 1, end: 2 },
    { id: 'c', start: 2.5, end: 3 },
  ]),
  [0, 0, 0],
);

// 端が触れているだけなら重なりではない（resolveOverlaps がこの形に揃える）
check(
  '端が接しているだけなら同じ段',
  rowsOf([
    { id: 'a', start: 0, end: 2.5 },
    { id: 'b', start: 2.5, end: 4 },
  ]),
  [0, 0],
);

// 重なったら下の段へ
check(
  '重なったら下の段',
  rowsOf([
    { id: 'a', start: 0, end: 3 },
    { id: 'b', start: 1, end: 4 },
  ]),
  [0, 1],
);

// 3つ重なれば3段。空いた段は使い回す
check(
  '3つ重なれば3段',
  rowsOf([
    { id: 'a', start: 0, end: 3 },
    { id: 'b', start: 1, end: 4 },
    { id: 'c', start: 2, end: 5 },
  ]),
  [0, 1, 2],
);
check(
  '空いた段は使い回す',
  rowsOf([
    { id: 'a', start: 0, end: 3 },
    { id: 'b', start: 1, end: 4 },
    { id: 'c', start: 3.5, end: 5 },
  ]),
  [0, 1, 0],
);

// カット後の目盛りで潰れて同じ点に来たものも、1枚ずつ触れるように分ける
check(
  '同じ点に潰れても段を分ける',
  rowsOf([
    { id: 'a', start: 8.2, end: 8.2 },
    { id: 'b', start: 8.2, end: 8.2 },
    { id: 'c', start: 8.2, end: 8.2 },
  ]),
  [0, 1, 2],
);

// 上限を超えたぶんは増やさない
const many = Array.from({ length: 8 }, (_, i) => ({ id: `x${i}`, start: i * 0.1, end: 10 }));
const overflow = rowsOf(many);
check('段は上限で止める', Math.max(...overflow) + 1, MAX_ROWS);

check('段数（重なりなし）', rowCount(assignRows([{ id: 'a', start: 0, end: 1 }])), 1);
check(
  '段数（2つ重なり）',
  rowCount(assignRows([{ id: 'a', start: 0, end: 2 }, { id: 'b', start: 1, end: 3 }])),
  2,
);
check('段数（空）', rowCount(assignRows([])), 1);

if (failed) {
  console.error(`\n${failed} 件失敗しました`);
  process.exit(1);
}
console.log('\nすべて通りました');
