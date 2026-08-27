/**
 * 「元素材の時間」⇄「カット後の時間」の変換を検める。
 *
 * 🔴 ここがずれると、プレビュー・コマ・テロップの時刻が全部ずれる。
 *    しかも書き出すまで気づけないので、机上で潰しておく。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// TypeScript をそのまま読めないので、型注釈だけ落として評価する。
// （このファイルは型に依存しない純粋な計算しか持っていない）
const src = readFileSync(join(root, 'src/shell/editedTime.ts'), 'utf8')
  .replace(/^export (interface|type)[\s\S]*?\n}\n/gm, '')
  .replace(/: readonly \w+\[\]/g, '')
  .replace(/: \w+\[\]/g, '')
  .replace(/: \w+ \| null/g, '')
  .replace(/: (number|boolean|string|Segment|Cut)\b/g, '')
  .replace(/^export /gm, '');

const mod = new Function(
  `${src}; return { buildSegments, outputDuration, toSource, toOutput, isCut, skipTarget, splitIntoClips, clipContaining };`,
)();
const {
  buildSegments, outputDuration, toSource, toOutput, isCut, skipTarget,
  splitIntoClips, clipContaining,
} = mod;

let failed = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    console.error(`  NG ${label}\n     期待: ${JSON.stringify(want)}\n     実際: ${JSON.stringify(got)}`);
    failed++;
  }
};
const near = (label, got, want, tol = 1e-6) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) {
    console.error(`  NG ${label} 期待 ${want} / 実際 ${got}`);
    failed++;
  }
};

/* 素材 100秒、10〜20 と 50〜55 を切る → 残るのは 0-10 / 20-50 / 55-100 = 85秒 */
const segs = buildSegments(100, [
  { srcStart: 10, srcEnd: 20 },
  { srcStart: 50, srcEnd: 55 },
]);

eq('残る区間の数', segs.length, 3);
eq('1つ目', [segs[0].srcStart, segs[0].srcEnd, segs[0].outStart, segs[0].outEnd], [0, 10, 0, 10]);
eq('2つ目', [segs[1].srcStart, segs[1].srcEnd, segs[1].outStart, segs[1].outEnd], [20, 50, 10, 40]);
eq('3つ目', [segs[2].srcStart, segs[2].srcEnd, segs[2].outStart, segs[2].outEnd], [55, 100, 40, 85]);
near('出来上がりの長さ', outputDuration(segs), 85);

/* カット後 → 元素材 */
near('出来上がり 0秒', toSource(segs, 0), 0);
near('出来上がり 9.9秒', toSource(segs, 9.9), 9.9);
near('出来上がり 10秒（切った直後）', toSource(segs, 10), 20);
near('出来上がり 39.9秒', toSource(segs, 39.9), 49.9);
near('出来上がり 40秒（2つ目のカット直後）', toSource(segs, 40), 55);
near('出来上がり 85秒（末尾）', toSource(segs, 85), 100);

/* 元素材 → カット後 */
near('元 5秒', toOutput(segs, 5), 5);
near('元 15秒（切られた中）', toOutput(segs, 15), 10);
near('元 20秒', toOutput(segs, 20), 10);
near('元 49秒', toOutput(segs, 49), 39);
near('元 52秒（切られた中）', toOutput(segs, 52), 40);
near('元 60秒', toOutput(segs, 60), 45);

/* 往復して元に戻るか（残る場所だけ） */
for (const t of [0, 3.3, 9.99, 20, 33.3, 49.99, 55, 77.7, 99.9]) {
  near(`往復 ${t}`, toSource(segs, toOutput(segs, t)), t, 1e-6);
}

/* 切られているかの判定 */
eq('5秒は残る', isCut(segs, 5), false);
eq('15秒は切られた', isCut(segs, 15), true);
eq('52秒は切られた', isCut(segs, 52), true);

/* 再生中の飛び先 */
eq('残る場所では飛ばない', skipTarget(segs, 5), null);
near('切る区間に入ったら次の頭へ', skipTarget(segs, 12), 20);
near('2つ目のカットでも同じ', skipTarget(segs, 51), 55);
eq('末尾より後ろは飛び先なし', skipTarget(segs, 100), null);

/* 重なった指定・逆順でも壊れないこと */
const messy = buildSegments(60, [
  { srcStart: 30, srcEnd: 40 },
  { srcStart: 10, srcEnd: 20 },
  { srcStart: 15, srcEnd: 25 }, // 前のものと重なる
  { srcStart: 50, srcEnd: 45 }, // 逆さま。無視されるべき
]);
eq('重なりをまとめた残り', messy.map((s) => [s.srcStart, s.srcEnd]), [[0, 10], [25, 30], [40, 60]]);
near('重なりありの長さ', outputDuration(messy), 10 + 5 + 20);

/* カットが無いときは素通し */
const none = buildSegments(30, []);
eq('カット無しは1区間', none.length, 1);
near('カット無しは素通し', toOutput(none, 12.5), 12.5);
near('カット無しは素通し（逆）', toSource(none, 12.5), 12.5);

/* 全部切ったとき */
const all = buildSegments(10, [{ srcStart: 0, srcEnd: 10 }]);
eq('全部切ると残らない', all.length, 0);
near('全部切ると長さ0', outputDuration(all), 0);


/* ---------- 切り込み（ブレード）で分けたクリップ ---------- */

{
  const segs = buildSegments(30, [{ srcStart: 10, srcEnd: 12 }]);
  // 残りは 0〜10 と 12〜30 の2本

  const none = splitIntoClips(segs, []);
  eq('切り込みが無ければ残る区間そのまま', none.map((c) => [c.start, c.end]), [[0, 10], [12, 30]]);

  const one = splitIntoClips(segs, [20]);
  eq('切り込みで分かれる', one.map((c) => [c.start, c.end]), [[0, 10], [12, 20], [20, 30]]);

  const two = splitIntoClips(segs, [20, 25]);
  eq('2つ入れれば間が1つのクリップ', two.map((c) => [c.start, c.end]),
     [[0, 10], [12, 20], [20, 25], [25, 30]]);

  // 🔴 切り取られる所に入れても、そこにクリップは生まれない
  const inCut = splitIntoClips(segs, [11]);
  eq('切る所への切り込みは効かない', inCut.map((c) => [c.start, c.end]), [[0, 10], [12, 30]]);

  // 🔴 端ちょうどは無視する（長さ0のクリップを作らない）
  const onEdge = splitIntoClips(segs, [12, 30]);
  eq('端の切り込みは無視', onEdge.map((c) => [c.start, c.end]), [[0, 10], [12, 30]]);

  // 🔴 id は位置から作る。前に足しても後ろの id が変わらないこと
  const before = splitIntoClips(segs, [20]);
  const after = splitIntoClips(segs, [5, 20]);
  eq('前に足しても後ろの名前が変わらない',
     after.some((c) => c.id === before[before.length - 1].id), true);

  // 順序が入れ替わって渡されても同じ
  eq('並びが逆でも同じ結果',
     splitIntoClips(segs, [25, 20]).map((c) => [c.start, c.end]),
     two.map((c) => [c.start, c.end]));

  const clips = splitIntoClips(segs, [20]);
  eq('その時刻のクリップが引ける', clipContaining(clips, 15)?.start, 12);
  eq('切り取られる所は null', clipContaining(clips, 11), null);
  eq('端は手前のクリップに入る', clipContaining(clips, 20)?.start, 12);
}

if (failed > 0) {
  console.error(`\ntest-edited-time: NG ${failed} 件`);
  process.exit(1);
}
console.log('test-edited-time: OK');
