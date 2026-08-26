/**
 * テロップ同士の位置合わせ（吸着）を検める。
 *
 * 🔴 目で確かめるのが難しい類い。「近いのに吸い付かない」「遠いのに吸い付く」は
 *    画面を見ても分からず、動かした本人が「思った所に置けない」と感じるだけになる。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// TypeScript をそのまま読めないので、型注釈だけ落として評価する
const src = readFileSync(join(root, 'src/telop/align.ts'), 'utf8')
  .replace(/^export interface[\s\S]*?\n}\n/gm, '')
  .replace(/: \{ d: number; dx: number; at: number \} \| null/g, '')
  .replace(/: \{ d: number; dy: number; at: number \} \| null/g, '')
  .replace(/: readonly Box\[\]/g, '')
  .replace(/: number\[\]/g, '')
  .replace(/: number(?!\w)/g, '')
  .replace(/: Box(?!\w)/g, '')
  .replace(/: Snap(?!\w)/g, '')
  .replace(/^export /gm, '');

const { snapToBoxes } = new Function(`${src}; return { snapToBoxes };`)();

let failed = 0;
const check = (name, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) console.log(`OK   ${name}`);
  else {
    console.error(`NG   ${name}\n     期待: ${b}\n     実際: ${a}`);
    failed++;
  }
};

const box = (x, y, w, h) => ({ x, y, w, h });
/** 動かす量だけ見る */
const shift = (me, others, nx = 20, ny = 20) => {
  const s = snapToBoxes(me, others, nx, ny);
  return [s.dx, s.dy];
};

check('相手がいなければ動かさない', shift(box(100, 100, 200, 50), []), [0, 0]);

check(
  '左端が近ければ左を揃える',
  shift(box(105, 500, 200, 50), [box(100, 100, 300, 50)]),
  [-5, 0],
);

check(
  '右端が近ければ右を揃える',
  shift(box(190, 500, 200, 50), [box(100, 100, 300, 50)]),
  [10, 0],
);

// 幅が違うので左右の端は遠い。中央だけが近い形にする
check(
  '中央が近ければ中央を揃える',
  shift(box(200, 500, 120, 50), [box(100, 100, 300, 50)]),
  [-10, 0],
);

check('遠ければ動かさない', shift(box(400, 500, 200, 50), [box(100, 100, 300, 50)]), [0, 0]);

check(
  '上端が近ければ上を揃える',
  shift(box(100, 108, 300, 50), [box(100, 100, 300, 50)]),
  [0, -8],
);

check(
  '縦も横も近ければ両方揃える',
  shift(box(106, 112, 300, 50), [box(100, 100, 300, 50)]),
  [-6, -12],
);

check(
  'いちばん近い線を選ぶ',
  shift(box(103, 500, 200, 50), [box(100, 100, 300, 50), box(96, 200, 300, 50)]),
  [-3, 0],
);

// 吸い付いた線の位置を返す（画面に出す用）
const s = snapToBoxes(box(105, 108, 200, 50), [box(100, 100, 300, 50)], 20, 20);
check('吸い付いた縦線の位置', s.guideX, 100);
check('吸い付いた横線の位置', s.guideY, 100);

const none = snapToBoxes(box(900, 900, 200, 50), [box(100, 100, 300, 50)], 20, 20);
check('吸い付かなければ線は出さない', [none.guideX, none.guideY], [null, null]);

if (failed) {
  console.error(`\n${failed} 件失敗しました`);
  process.exit(1);
}
console.log('\nすべて通りました');
