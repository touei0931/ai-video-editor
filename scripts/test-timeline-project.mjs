/**
 * タイムラインの土台（素材・レーン・クリップ）を検める。
 *
 * 🔴 ここがずれると、映像が1コマ抜ける・音がずれるといった
 *    **書き出すまで気づけない**壊れ方をする。机上で潰しておく。
 *
 * Node 24 は .ts をそのまま読める（型を落として実行する）ので、
 * 型注釈を正規表現で剥がすような細工は要らない。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// 🔴 Windows では絶対パスをそのまま import できない（'c:' が
//    プロトコル扱いになる）。file:// に直してから渡す。
const m = await import(pathToFileURL(join(root, 'src/timeline/project.ts')).href);

const {
  emptyProject, addAsset, addLane, appendToMain, placeOnLane,
  layout, timelineDuration, clipAt, videoAt, toSourceTime,
  bladeAt, removeClip, trimClip, moveClip, setMagnetic,
  importCutResult, placedTelops, telopsAt,
} = m;

let failed = 0;
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    console.error(`  NG ${label}\n     期待: ${JSON.stringify(want)}\n     実際: ${JSON.stringify(got)}`);
    failed++;
  }
};
const near = (label, got, want, tol = 1e-4) => {
  if (!(Math.abs(got - want) <= tol)) {
    console.error(`  NG ${label} 期待 ${want} / 実際 ${got}`);
    failed++;
  }
};

/** 素材を2本持った空の作品 */
function base() {
  let p = emptyProject();
  p = addAsset(p, { id: 'a', path: '/a.mp4', name: 'A', duration: 60, hasVideo: true, hasAudio: true });
  p = addAsset(p, { id: 'b', path: '/b.mp4', name: 'B', duration: 30, hasVideo: true, hasAudio: true });
  p = addLane(p, { id: 'v2', kind: 'video', name: '重ね' });
  return p;
}

/** メインの位置を [開始, 終了] の並びで取り出す */
const mainSpans = (p) =>
  layout(p).filter((c) => c.laneId === 'main').map((c) => [c.start, c.end]);

/* ---------------------------------------------------------- 並べる（詰める） */

{
  let p = base();
  p = appendToMain(p, 'a', 0, 10);
  p = appendToMain(p, 'b', 5, 15);

  eq('末尾に足すと隙間なく並ぶ', mainSpans(p), [[0, 10], [10, 20]]);
  near('全体の長さ', timelineDuration(p), 20);

  // 🔴 素材の範囲を省いたら、素材まるごと
  let q = appendToMain(base(), 'b');
  eq('範囲を省くと素材まるごと', mainSpans(q), [[0, 30]]);

  // 🔴 素材より外は受け付けない
  let r = appendToMain(base(), 'b', 0, 999);
  eq('素材より長くは置けない', mainSpans(r), [[0, 30]]);

  eq('長さ0は置かない', appendToMain(base(), 'a', 5, 5).clips.length, 0);
  eq('知らない素材は置かない', appendToMain(base(), 'zzz').clips.length, 0);
}

/* ------------------------------------------------------------------ 分ける */

{
  let p = base();
  p = appendToMain(p, 'a', 0, 10);
  p = bladeAt(p, 'main', 4);

  eq('切り込みで2つに分かれる', mainSpans(p), [[0, 4], [4, 10]]);
  eq('素材の中の範囲も分かれる',
     p.clips.map((c) => [c.srcStart, c.srcEnd]), [[0, 4], [4, 10]]);
  near('合計の長さは変わらない', timelineDuration(p), 10);

  // 🔴 端では分けない（長さ0のクリップを作らない）
  eq('先頭では分けない', bladeAt(p, 'main', 0).clips.length, 2);
  eq('末尾では分けない', bladeAt(p, 'main', 10).clips.length, 2);

  // 🔴 後ろ側は元のすぐ後ろに入る。末尾に足すと作品の最後へ飛ぶ
  let q = base();
  q = appendToMain(q, 'a', 0, 10);
  q = appendToMain(q, 'b', 0, 10);
  q = bladeAt(q, 'main', 4);
  eq('分けた後ろ側は元の隣に入る', mainSpans(q), [[0, 4], [4, 10], [10, 20]]);
  eq('分けた後ろ側は同じ素材', q.clips.map((c) => c.assetId), ['a', 'a', 'b']);

  // 素材の途中から置いたものを分けても、素材の中の時刻がずれない
  let r = base();
  r = appendToMain(r, 'a', 20, 30);
  r = bladeAt(r, 'main', 4);
  eq('素材の中の切れ目', r.clips.map((c) => [c.srcStart, c.srcEnd]), [[20, 24], [24, 30]]);
}

/* -------------------------------------------------------------------- 消す */

{
  let p = base();
  p = appendToMain(p, 'a', 0, 10);
  p = appendToMain(p, 'b', 0, 5);
  p = appendToMain(p, 'a', 20, 25);
  const midId = p.clips[1].id;

  const rippled = removeClip(p, midId);
  eq('消すと後ろが詰まる', mainSpans(rippled), [[0, 10], [10, 15]]);
  near('詰めた分だけ短くなる', timelineDuration(rippled), 15);

  // 🔴 穴を空けたいときは、詰める設定のままにできない
  const lifted = removeClip(p, midId, 'lift');
  eq('穴を空けると位置が動かない', mainSpans(lifted), [[0, 10], [15, 20]]);
  eq('穴を空けたら詰める設定は外れる', lifted.magnetic, false);

  eq('知らないクリップは無視', removeClip(p, 'zzz').clips.length, 3);
}

/* ------------------------------------------------------------------ 伸縮 */

{
  let p = base();
  p = appendToMain(p, 'a', 10, 20);
  const id = p.clips[0].id;

  const longer = trimClip(p, id, 'end', 5);
  eq('後ろを伸ばす', longer.clips.map((c) => [c.srcStart, c.srcEnd]), [[10, 25]]);

  const shorter = trimClip(p, id, 'start', 3);
  eq('頭を縮める', shorter.clips.map((c) => [c.srcStart, c.srcEnd]), [[13, 20]]);

  // 🔴 素材より外へは伸ばせない（黒画面と無音が入る）
  const tooLong = trimClip(p, id, 'end', 999);
  eq('素材の終わりで止まる', tooLong.clips.map((c) => c.srcEnd), [60]);
  const tooEarly = trimClip(p, id, 'start', -999);
  eq('素材の頭で止まる', tooEarly.clips.map((c) => c.srcStart), [0]);

  // 🔴 長さ0にしない
  //    ぴったり 0.04 と比べないこと。19.96 と 20 の引き算は
  //    0.0399999... になる（二進小数では 0.04 を正確に置けない）。
  //    値そのものは正しいので、比べる側にわずかな幅を持たせる。
  const squashed = trimClip(p, id, 'start', 999);
  eq('つぶれない', squashed.clips[0].srcEnd - squashed.clips[0].srcStart > 0.039, true);
  near('つぶれた先は最小の長さ',
       squashed.clips[0].srcEnd - squashed.clips[0].srcStart, 0.04);

  // 詰める設定なら、縮めた分だけ後ろが前に来る
  let q = base();
  q = appendToMain(q, 'a', 0, 10);
  q = appendToMain(q, 'b', 0, 10);
  q = trimClip(q, q.clips[0].id, 'end', -4);
  eq('縮めたら後ろが詰まる', mainSpans(q), [[0, 6], [6, 16]]);
}

/* ------------------------------------------------------------ 上に重ねる */

{
  let p = base();
  p = appendToMain(p, 'a', 0, 20);
  p = placeOnLane(p, 'v2', 'b', 5, 0, 4);

  eq('重ねたものは指定した位置に出る',
     layout(p).filter((c) => c.laneId === 'v2').map((c) => [c.start, c.end]), [[5, 9]]);
  near('重ねても全体の長さは変わらない', timelineDuration(p), 20);

  // 🔴 上のレーンが手前。下を先に見つけては重ねた意味が無い
  eq('重なっている間は上が映る', videoAt(p, 6).assetId, 'b');
  eq('重なっていない所はメインが映る', videoAt(p, 1).assetId, 'a');
  eq('重なりが終われば戻る', videoAt(p, 12).assetId, 'a');
  eq('何も無い所は null', videoAt(p, 99), null);

  // 上のレーンは「詰める」の影響を受けない
  let q = appendToMain(p, 'b', 0, 5);
  eq('メインに足しても重ねたものは動かない',
     layout(q).filter((c) => c.laneId === 'v2').map((c) => [c.start, c.end]), [[5, 9]]);
}

/* ------------------------------------------------------------------ 動かす */

{
  let p = base();
  p = appendToMain(p, 'a', 0, 10);   // 0-10
  p = appendToMain(p, 'b', 0, 6);    // 10-16
  p = appendToMain(p, 'a', 20, 24);  // 16-20
  const last = p.clips[2].id;

  // 🔴 詰める設定では、位置ではなく順番が変わる
  const moved = moveClip(p, last, 'main', 0);
  eq('先頭へ動かすと順番が変わる', moved.clips.map((c) => [c.srcStart, c.srcEnd]),
     [[20, 24], [0, 10], [0, 6]]);
  eq('動かしても隙間はできない', mainSpans(moved), [[0, 4], [4, 14], [14, 20]]);
  eq('動かしても位置は持たない', moved.clips.every((c) => c.at === undefined), true);

  // 上のレーンへ動かすと、位置を持つ
  const toV2 = moveClip(p, last, 'v2', 3);
  eq('上のレーンでは位置を持つ', toV2.clips.find((c) => c.id === last).at, 3);
  eq('上のレーンに移っている', toV2.clips.find((c) => c.id === last).laneId, 'v2');
}

/* -------------------------------------------------- 詰める / 詰めないの切替 */

{
  let p = base();
  p = appendToMain(p, 'a', 0, 10);
  p = appendToMain(p, 'b', 0, 6);

  // 🔴 切り替えた瞬間に絵が飛ばないこと
  const off = setMagnetic(p, false);
  eq('切っても位置が変わらない', mainSpans(off), [[0, 10], [10, 16]]);
  eq('位置が書き込まれる', off.clips.map((c) => c.at), [0, 10]);

  // 自由配置で隙間を空けてから、詰めに戻す
  let gapped = moveClip(off, off.clips[1].id, 'main', 40);
  eq('自由配置では隙間が空く', mainSpans(gapped), [[0, 10], [40, 46]]);

  const on = setMagnetic(gapped, true);
  eq('詰めに戻すと隙間が消える', mainSpans(on), [[0, 10], [10, 16]]);
  eq('位置は捨てる', on.clips.every((c) => c.at === undefined), true);

  // 🔴 位置の順に並べ替えてから詰めること。
  //    並べ替えないと、後ろにあった絵が突然先頭に来る
  let swapped = moveClip(off, off.clips[0].id, 'main', 50);
  const back = setMagnetic(swapped, true);
  eq('前後が入れ替わっていれば、その順で詰まる',
     back.clips.map((c) => [c.srcStart, c.srcEnd]), [[0, 6], [0, 10]]);
}

/* -------------------------------------------------- 時刻の引き当て */

{
  let p = base();
  p = appendToMain(p, 'a', 30, 40);  // 0-10 に、素材の 30-40 が出る
  p = appendToMain(p, 'b', 0, 5);    // 10-15

  const c = clipAt(p, 'main', 3);
  eq('その時刻のクリップが引ける', c.assetId, 'a');
  near('素材の中の時刻に直せる', toSourceTime(c, 3), 33);

  const c2 = clipAt(p, 'main', 12);
  eq('2本目も引ける', c2.assetId, 'b');
  near('2本目の素材の中の時刻', toSourceTime(c2, 12), 2);

  eq('端の外は引けない', clipAt(p, 'main', 99), null);
  // 🔴 継ぎ目は後ろのクリップに入る（前の終わりは含まない）
  eq('継ぎ目は後ろ側', clipAt(p, 'main', 10).assetId, 'b');
}

/* -------------------------------------------------- 何も無いとき */

{
  const p = emptyProject();
  eq('空でも落ちない', layout(p), []);
  near('空の長さは0', timelineDuration(p), 0);
  eq('空では引けない', clipAt(p, 'main', 0), null);
  eq('空では映らない', videoAt(p, 0), null);
  eq('空で切っても何も起きない', bladeAt(p, 'main', 1).clips.length, 0);
}


/* -------------------------------------------- 下ごしらえ（子画面）の取り込み */

const ASSET_C = { id: 'c', path: '/c.mp4', name: 'C', duration: 100, hasVideo: true, hasAudio: true };

{
  // 自動カットで 0-5 / 20-30 / 50-55 が残った、という結果
  const result = {
    asset: ASSET_C,
    keeps: [
      { srcStart: 0, srcEnd: 5 },
      { srcStart: 20, srcEnd: 30 },
      { srcStart: 50, srcEnd: 55 },
    ],
    telops: [
      { srcStart: 1, srcEnd: 3, text: 'はじめまして', style: 'normal' },
      { srcStart: 22, srcEnd: 24, text: 'ここが本題', style: 'emphasis' },
    ],
  };

  let p = importCutResult(emptyProject(), result);

  // 🔴 残す区間1つが、クリップ1つ
  eq('残す区間の数だけクリップができる', p.clips.length, 3);
  eq('切った分は詰まっている', mainSpans(p), [[0, 5], [5, 15], [15, 20]]);
  near('長さは残した分だけ', timelineDuration(p), 20);
  eq('素材も登録される', p.assets.map((a) => a.id), ['c']);

  // 🔴 テロップは素材の時刻で持ち、出る場所は計算で出す
  const tel = placedTelops(p);
  eq('テロップの出る場所', tel.map((t) => [t.start, t.end]), [[1, 3], [7, 9]]);
  eq('テロップの中身', tel.map((t) => t.text), ['はじめまして', 'ここが本題']);
  eq('その時刻のテロップ', telopsAt(p, 8).map((t) => t.text), ['ここが本題']);
  eq('何も無い時刻', telopsAt(p, 5).length, 0);

  // 🔴 2本目を取り込んでも1本目は消えない
  let q = importCutResult(p, {
    asset: { id: 'd', path: '/d.mp4', name: 'D', duration: 20, hasVideo: true, hasAudio: true },
    keeps: [{ srcStart: 0, srcEnd: 4 }],
  });
  eq('末尾に足される', mainSpans(q), [[0, 5], [5, 15], [15, 20], [20, 24]]);
  eq('素材が2本になる', q.assets.length, 2);

  // 🔴 クリップを動かしてもテロップが付いてくる
  const movedP = moveClip(p, p.clips[1].id, 'main', 0);
  eq('動かしてもテロップが付いてくる',
     placedTelops(movedP).map((t) => [t.text, t.start]),
     [['ここが本題', 2], ['はじめまして', 11]]);

  // 🔴 クリップを分けてもテロップは1つのまま（跨いでいなければ）
  const bladed = bladeAt(p, 'main', 12);
  eq('分けてもテロップの位置は変わらない',
     placedTelops(bladed).map((t) => [t.start, t.end]), [[1, 3], [7, 9]]);

  // 🔴 端を縮めたら、外に出た分は消える
  const trimmed = trimClip(p, p.clips[0].id, 'start', 2);
  eq('縮めた外のテロップは切り詰められる',
     placedTelops(trimmed).map((t) => [t.text, t.start, t.end]),
     [['はじめまして', 0, 1], ['ここが本題', 5, 7]]);

  // 消したクリップの上のテロップは出ない
  const dropped = removeClip(p, p.clips[1].id);
  eq('消したクリップのテロップは出ない',
     placedTelops(dropped).map((t) => t.text), ['はじめまして']);
}

{
  // 🔴 同じ素材を2回使ったら、テロップも2回出る
  let p = emptyProject();
  p = importCutResult(p, {
    asset: ASSET_C,
    keeps: [{ srcStart: 0, srcEnd: 10 }],
    telops: [{ srcStart: 2, srcEnd: 4, text: '繰り返し', style: 'normal' }],
  });
  p = appendToMain(p, 'c', 0, 10);

  eq('同じ素材を2回使えば2回出る',
     placedTelops(p).map((t) => [t.start, t.end]), [[2, 4], [12, 14]]);
}

{
  // 長さ0の区間は取り込まない
  const p = importCutResult(emptyProject(), {
    asset: ASSET_C,
    keeps: [{ srcStart: 5, srcEnd: 5 }, { srcStart: 10, srcEnd: 12 }],
  });
  eq('長さ0の区間は捨てる', p.clips.length, 1);
  eq('テロップを渡さなくても落ちない', p.telops, []);
}

if (failed > 0) {
  console.error(`\ntest-timeline-project: NG ${failed} 件`);
  process.exit(1);
}
console.log('test-timeline-project: OK');
