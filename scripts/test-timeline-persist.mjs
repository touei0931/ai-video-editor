/**
 * 保存したタイムラインの読み込みを検める。
 *
 * 🔴 書類は人が触れる場所にある。壊れたものが来る前提で確かめること。
 *    確かめずに入れると、1件おかしいだけで画面が真っ白になり、
 *    何が起きたのか分からなくなる。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = await import(pathToFileURL(join(root, 'src/timeline/project.ts')).href);
const S = await import(pathToFileURL(join(root, 'src/timeline/persist.ts')).href);

const { emptyProject, addAsset, addLane, appendToMain, placeOnLane, importCutResult } = P;
const { toSaved, fromSaved } = S;

let failed = 0;
const check = (label, ok, detail = '') => {
  if (!ok) {
    console.error(`  NG ${label}${detail ? `\n     ${detail}` : ''}`);
    failed++;
  }
};
/*
  🔴 鍵の並びで比べないこと。
     JSON.stringify は書いた順をそのまま出す。読み込み側が作り直した物は
     並びが変わるので、中身が同じでも食い違って見える。
*/
const norm = (v) => {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]));
  }
  return v;
};
const eq = (label, got, want) =>
  check(
    label,
    JSON.stringify(norm(got)) === JSON.stringify(norm(want)),
    `期待 ${JSON.stringify(norm(want))} / 実際 ${JSON.stringify(norm(got))}`,
  );

function sample() {
  let p = importCutResult(emptyProject(), {
    asset: { id: 'a', path: '/m/a.mp4', name: 'A', duration: 60, hasVideo: true, hasAudio: true },
    keeps: [{ srcStart: 0, srcEnd: 10 }, { srcStart: 20, srcEnd: 25 }],
    telops: [{ srcStart: 1, srcEnd: 3, text: 'あ', style: 'emphasis' }],
  });
  p = addLane(p, { id: 'v2', kind: 'video', name: '重ね' });
  p = addAsset(p, { id: 'b', path: '/m/b.mp4', name: 'B', duration: 30, hasVideo: true, hasAudio: false });
  p = placeOnLane(p, 'v2', 'b', 4, 0, 3);
  return p;
}

/* -------------------------------------------------- 行って帰って同じもの */

{
  const p = sample();
  const back = fromSaved(JSON.parse(JSON.stringify(toSaved(p))));
  check('読み込める', back !== null);
  eq('素材が同じ', back.assets, p.assets);
  eq('レーンが同じ', back.lanes, p.lanes);
  eq('クリップが同じ', back.clips, p.clips);
  eq('テロップが同じ', back.telops, p.telops);
  eq('詰める設定が同じ', back.magnetic, p.magnetic);
}

/* ------------------------------------------------------------ 通さないもの */

eq('中身が無い', fromSaved(null), null);
eq('ただの文字', fromSaved('x'), null);
eq('配列', fromSaved([]), null);
eq('別の書類', fromSaved({ kind: 'なにか', version: 1, project: {} }), null);
eq('中身が空', fromSaved({ kind: 'pac-timeline', version: 1 }), null);

// 🔴 本編のレーンが無いものは通さない。置き場所の無い書類になる
eq('本編のレーンが無い',
   fromSaved({ kind: 'pac-timeline', version: 1, project: { assets: [], lanes: [], clips: [] } }),
   null);

/* -------------------------------------------- 壊れた一部は捨てて、残りは通す */

{
  const p = sample();
  const raw = JSON.parse(JSON.stringify(toSaved(p)));

  // 素材の長さが壊れている
  raw.project.assets.push({ id: 'z', path: '/m/z.mp4', name: 'Z', duration: 0 });
  // 行き先の無いクリップ
  raw.project.clips.push({ id: 'ghost', assetId: 'いない', laneId: 'main', srcStart: 0, srcEnd: 1 });
  raw.project.clips.push({ id: 'ghost2', assetId: 'a', laneId: 'いないレーン', srcStart: 0, srcEnd: 1 });
  // 長さ0のクリップ
  raw.project.clips.push({ id: 'flat', assetId: 'a', laneId: 'main', srcStart: 5, srcEnd: 5 });
  // 文字の無いテロップ
  raw.project.telops.push({ id: 't0', assetId: 'a', srcStart: 1, srcEnd: 2 });
  // 素材のいないテロップ
  raw.project.telops.push({ id: 't1', assetId: 'いない', srcStart: 1, srcEnd: 2, text: 'x' });

  const back = fromSaved(raw);
  check('壊れていても開ける', back !== null);
  eq('長さの無い素材は捨てる', back.assets.map((a) => a.id), ['a', 'b']);
  eq('行き先の無いクリップは捨てる', back.clips.map((c) => c.id), p.clips.map((c) => c.id));
  eq('長さ0のクリップは捨てる', back.clips.some((c) => c.id === 'flat'), false);
  eq('壊れたテロップは捨てる', back.telops.map((t) => t.id), p.telops.map((t) => t.id));
}

/* ---------------------------------------------------------- 既定に寄せる */

{
  const back = fromSaved({
    kind: 'pac-timeline',
    version: 1,
    project: {
      assets: [{ id: 'a', path: '/m/a.mp4', duration: 10 }],
      lanes: [{ id: 'main', kind: 'main' }],
      clips: [{ id: 'c', assetId: 'a', laneId: 'main', srcStart: 0, srcEnd: 5 }],
    },
  });
  check('省いたものが補われる', back !== null);
  eq('名前が無ければ場所を使う', back.assets[0].name, '/m/a.mp4');
  eq('映像と音は有るものとして扱う', [back.assets[0].hasVideo, back.assets[0].hasAudio], [true, true]);
  eq('レーンの名前は空でよい', back.lanes[0].name, '');
  eq('テロップが無くても落ちない', back.telops, []);
  // 🔴 詰める設定は既定を「入」にする。既定が「切」だと、開いた瞬間に
  //    クリップが元の位置へ散る（at を持っていないので全部 0 に重なる）
  eq('詰める設定の既定は入', back.magnetic, true);
  eq('知らない見た目は通常に寄せる', fromSaved({
    kind: 'pac-timeline', version: 1,
    project: {
      assets: [{ id: 'a', path: '/m/a.mp4', duration: 10 }],
      lanes: [{ id: 'main', kind: 'main' }],
      clips: [],
      telops: [{ id: 't', assetId: 'a', srcStart: 0, srcEnd: 1, text: 'x', style: 'なにか' }],
    },
  }).telops[0].style, 'normal');
}

if (failed > 0) {
  console.error(`\ntest-timeline-persist: NG ${failed} 件`);
  process.exit(1);
}
console.log('test-timeline-persist: OK');
