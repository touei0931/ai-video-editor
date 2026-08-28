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
const ST = await import(pathToFileURL(join(root, 'src/telop/style.ts')).href);
const { DEFAULT_STYLES } = ST;

const { emptyProject, addAsset, addLane, appendToMain, placeOnLane, importCutResult,
        adoptSettings } = P;
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

/* -------------------------------------------- プロジェクトの決めごと */
{
  const bare = {
    kind: 'pac-timeline', version: 1,
    project: {
      assets: [], lanes: [{ id: 'main', kind: 'main' }], clips: [], telops: [],
    },
  };

  /*
    🔴 古い書類には settings が無い。無いときに null を返すと、
       それまで保存したタイムラインが**丸ごと開けなくなる**。
  */
  const old = fromSaved(bare);
  check('設定が無い古い書類も開ける', old !== null);
  eq('無ければ 1920x1080 30fps', [old.settings.width, old.settings.height, old.settings.fps],
     [1920, 1080, 30]);

  const kept = fromSaved({ ...bare, project: {
    ...bare.project, settings: { width: 1080, height: 1920, fps: 29.97 },
  } });
  eq('入っていればそのまま', [kept.settings.width, kept.settings.height, kept.settings.fps],
     [1080, 1920, 29.97]);

  /*
    🔴 奇数の大きさを通さないこと。
       yuv420p にできず、書き出しの ffmpeg が落ちる。
       書類は人が手で書き換えられる場所にあるので、ここで直す。
  */
  const odd = fromSaved({ ...bare, project: {
    ...bare.project, settings: { width: 1921, height: 1081, fps: 30 },
  } });
  eq('奇数の大きさは偶数に直す', [odd.settings.width, odd.settings.height], [1922, 1082]);

  for (const [label, bad] of [
    ['0 は通さない', { width: 0, height: 0, fps: 0 }],
    ['負の値は通さない', { width: -100, height: -100, fps: -1 }],
    ['数でないものは通さない', { width: '横', height: null, fps: 'にじゅう' }],
    ['ありえないコマ数は通さない', { width: 1920, height: 1080, fps: 100000 }],
  ]) {
    const got = fromSaved({ ...bare, project: { ...bare.project, settings: bad } });
    eq(label,
       [got.settings.width > 0, got.settings.height > 0,
        got.settings.fps > 0 && got.settings.fps <= 240],
       [true, true, true]);
  }

  // 往復して変わらないこと
  const project = emptyProject();
  project.settings = { ...project.settings, width: 1080, height: 1080, fps: 24 };
  const round = fromSaved(JSON.parse(JSON.stringify(toSaved(project))));
  eq('往復しても変わらない', round.settings, project.settings);

  /*
    🔴 書き出しの選択も往復すること。
       毎回入れ直させると、字幕だけ欲しい人が毎回同じ操作をすることになる。
  */
  const picked = emptyProject();
  picked.settings = { ...picked.settings, burnTelops: false, writeSrt: false, loudnorm: false };
  const back2 = fromSaved(JSON.parse(JSON.stringify(toSaved(picked))));
  eq('切った選択が残る',
     [back2.settings.burnTelops, back2.settings.writeSrt, back2.settings.loudnorm],
     [false, false, false]);

  // 🔴 入っていない項目は既定へ。古い書類が開けなくなる
  const oldDoc = fromSaved({ ...bare, project: {
    ...bare.project, settings: { width: 1280, height: 720, fps: 30 },
  } });
  eq('古い書類は既定の選択で開く',
     [oldDoc.settings.burnTelops, oldDoc.settings.writeSrt, oldDoc.settings.loudnorm],
     [true, true, true]);
}

/* ------------------------------------------------ 素材の画の大きさ */
{
  const withSize = fromSaved({
    kind: 'pac-timeline', version: 1,
    project: {
      assets: [{ id: 'a', path: '/m/a.mp4', duration: 10, width: 1920, height: 1080 }],
      lanes: [{ id: 'main', kind: 'main' }], clips: [], telops: [],
    },
  });
  eq('素材の大きさは残る', [withSize.assets[0].width, withSize.assets[0].height], [1920, 1080]);

  // 音だけの素材には無い。無いまま通せること
  const noSize = fromSaved({
    kind: 'pac-timeline', version: 1,
    project: {
      assets: [{ id: 'a', path: '/m/a.mp3', duration: 10, hasVideo: false }],
      lanes: [{ id: 'main', kind: 'main' }], clips: [], telops: [],
    },
  });
  eq('大きさが無くても通る', noSize.assets[0].width, undefined);
}

/* -------------------------------- 最初の素材に合わせて大きさを決める */
{
  const tate = { id: 'a', path: '/m/a.mp4', name: 'a', duration: 10,
                 hasVideo: true, hasAudio: true, width: 1080, height: 1920 };

  const fresh = adoptSettings(emptyProject(), tate);
  eq('最初の素材に合わせる', [fresh.settings.width, fresh.settings.height], [1080, 1920]);

  /*
    🔴 決めるのは一度だけ。
       横の素材で組み立てたあとに縦を1本足したら全部縦になった、では作業が壊れる。
  */
  const started = emptyProject();
  started.clips = [{ id: 'c', name: 'c', assetId: 'x', laneId: 'main', srcStart: 0, srcEnd: 1 }];
  const stay = adoptSettings(started, tate);
  eq('もう並んでいるなら変えない', [stay.settings.width, stay.settings.height], [1920, 1080]);

  const audio = { id: 'b', path: '/m/b.mp3', name: 'b', duration: 10,
                  hasVideo: false, hasAudio: true };
  eq('音だけの素材では変えない',
     adoptSettings(emptyProject(), audio).settings.width, 1920);
}

/* ------------------------------------------ テロップの見た目の引き継ぎ */
{
  const bare = {
    kind: 'pac-timeline', version: 1,
    project: { assets: [], lanes: [{ id: 'main', kind: 'main' }], clips: [], telops: [] },
  };

  // 古い書類には無い。既定の3種類がそろうこと
  const old = fromSaved(bare);
  check('見た目が無い古い書類も開ける', old !== null);
  eq('既定の3種類がそろう',
     ['normal', 'note', 'emphasis'].every((n) => !!old.styles[n]), true);

  /*
    🔴 子画面で整えた見た目が、並べた画面へ渡ること。
       渡らないと、整えたテロップが並べた瞬間に既定の見た目へ戻る。
       しかもプレビューも書き出しも同じ既定なので、見比べても気づけない。
  */
  const mine = {
    ...DEFAULT_STYLES,
    normal: { ...DEFAULT_STYLES.normal, color: '#ff0000' },
    // 名前を付けた雛形
    ツッコミ: { ...DEFAULT_STYLES.emphasis, color: '#00ff88' },
  };
  const imported = importCutResult(emptyProject(), {
    asset: { id: 'a', path: '/m/a.mp4', name: 'a', duration: 30, hasVideo: true, hasAudio: true },
    keeps: [{ srcStart: 0, srcEnd: 10 }],
    styles: mine,
    telops: [{ srcStart: 1, srcEnd: 3, text: 'やあ', style: 'ツッコミ' }],
  });
  eq('取り込みで見た目が入る', imported.styles.normal.color, '#ff0000');
  eq('名前を付けた雛形も入る', !!imported.styles['ツッコミ'], true);
  /*
    🔴 見た目の名前を2種類に潰さないこと。
       以前は normal / emphasis のどちらかへ寄せていたので、
       名前を付けた雛形は取り込んだ時点で失われていた。
  */
  eq('テロップの見た目の名前が残る', imported.telops[0].style, 'ツッコミ');

  // 往復
  const round = fromSaved(JSON.parse(JSON.stringify(toSaved(imported))));
  eq('往復しても見た目が残る', round.styles.normal.color, '#ff0000');
  eq('往復しても名前付きの雛形が残る', !!round.styles['ツッコミ'], true);
  eq('往復してもテロップの名前が残る', round.telops[0].style, 'ツッコミ');

  /*
    🔴 雛形が消えた名前は通常へ寄せること。
       残すと、描くたびに見つからない雛形を探し続けることになる。
  */
  const gone = fromSaved({
    kind: 'pac-timeline', version: 1,
    project: {
      assets: [{ id: 'a', path: '/m/a.mp4', duration: 30 }],
      lanes: [{ id: 'main', kind: 'main' }],
      clips: [],
      // styles を渡さない = 既定の3種類しかない
      telops: [{ id: 't', assetId: 'a', srcStart: 0, srcEnd: 1, text: 'x', style: 'ツッコミ' }],
    },
  });
  eq('消えた雛形の名前は通常に寄せる', gone.telops[0].style, 'normal');

  // 壊れた見た目でも開ける
  const broken = fromSaved({ ...bare, project: { ...bare.project, styles: '雛形' } });
  check('壊れた見た目でも開ける', broken !== null);
  eq('壊れていても既定がそろう', !!broken.styles.normal, true);
}

/* ------------------------------------------------ クリップの画角 */
{
  const doc = (transform) => ({
    kind: 'pac-timeline', version: 1,
    project: {
      assets: [{ id: 'a', path: '/m/a.mp4', duration: 60 }],
      lanes: [{ id: 'main', kind: 'main' }],
      clips: [{ id: 'c', name: 'c', assetId: 'a', laneId: 'main', srcStart: 0, srcEnd: 5, transform }],
      telops: [],
    },
  });

  eq('画角が残る', fromSaved(doc({ scale: 1.5, x: 0.2, y: -0.1 })).clips[0].transform,
     { scale: 1.5, x: 0.2, y: -0.1 });

  // 🔴 何もしない変形は持たない。書類が無駄に太る
  eq('等倍は持たない', 'transform' in fromSaved(doc({ scale: 1, x: 0, y: 0 })).clips[0], false);
  eq('無ければ持たない', 'transform' in fromSaved(doc(undefined)).clips[0], false);

  /*
    🔴 書類は人が手で書き換えられる場所にある。
       倍率0のまま通すと絵が消え、「真っ黒になった」としか分からなくなる。
  */
  eq('倍率0は通さない', fromSaved(doc({ scale: 0, x: 0, y: 0 })).clips[0].transform.scale > 0, true);
  eq('大きすぎる倍率は抑える',
     fromSaved(doc({ scale: 999, x: 0, y: 0 })).clips[0].transform.scale <= 4, true);
  eq('数でないものは既定へ',
     fromSaved(doc({ scale: '大きく', x: 0.3, y: null })).clips[0].transform,
     { scale: 1, x: 0.3, y: 0 });
  eq('壊れていても開ける', fromSaved(doc('画角')) !== null, true);
}

/* ------------------------------------------------ 切ってある所 */
{
  const doc = (enabled) => ({
    kind: 'pac-timeline', version: 1,
    project: {
      assets: [{ id: 'a', path: '/m/a.mp4', duration: 60 }],
      lanes: [{ id: 'main', kind: 'main' }],
      clips: [{ id: 'c', name: 'c', assetId: 'a', laneId: 'main', srcStart: 0, srcEnd: 5, enabled }],
      telops: [],
    },
  });

  /*
    🔴 切ってあることを保存に乗せること。
       乗せないと、開き直した時に切った所が全部戻ってきて、
       **自動カットが無かったことになる**（尺が元の長さに戻る）。
  */
  eq('切ってあることが残る', fromSaved(doc(false)).clips[0].enabled, false);

  // 🔴 既定は有効。true をわざわざ書かない（書類が太る）
  eq('有効なら持たない', 'enabled' in fromSaved(doc(true)).clips[0], false);
  // 🔴 古い書類にはこの項目が無い。無ければ有効として読むこと
  eq('無ければ持たない', 'enabled' in fromSaved(doc(undefined)).clips[0], false);
  eq('数や文字は有効あつかい', 'enabled' in fromSaved(doc(0)).clips[0], false);
  eq('壊れていても開ける', fromSaved(doc('切った')) !== null, true);
}

if (failed > 0) {
  console.error(`\ntest-timeline-persist: NG ${failed} 件`);
  process.exit(1);
}
console.log('test-timeline-persist: OK');
