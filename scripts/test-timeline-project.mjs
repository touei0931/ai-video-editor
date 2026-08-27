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
  importCutResult, placedTelops, telopsAt, clipName,
  addTelop, updateTelop, removeTelop, moveTelopEdge,
  renameClip, setClipGain, GAIN_RANGE,
  duplicateClip, pasteClip, isGap,
  removeLane, renameLane, clipsOnLane, removeRange,
  setClipTransform, fillScale, NO_TRANSFORM, TRANSFORM_RANGE,
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

  /*
    🔴 穴は「空き」というクリップにする。
       抜いて詰める設定を切ると、押した瞬間にタイムライン全体の
       振る舞いが変わってしまう（一度押したら二度と詰まらない）。
  */
  const lifted = removeClip(p, midId, 'lift');
  eq('空きにしても位置が動かない', mainSpans(lifted), [[0, 10], [10, 15], [15, 20]]);
  eq('詰める設定はそのまま', lifted.magnetic, true);
  eq('真ん中が空きになる', lifted.clips.map((c) => c.assetId), ['a', '', 'a']);
  // 空きの上では何も映らない
  eq('空きの上では映像が無い', videoAt(lifted, 12), null);
  eq('空きの前は映る', videoAt(lifted, 5).assetId, 'a');
  eq('空きの後ろも映る', videoAt(lifted, 17).assetId, 'a');

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

  /*
    🔴 2本目も本編に詰めて足すこと。
       「繋ぎたい」のか「重ねたい」のかは人が決める。本編に並んでいれば、
       重ねたいものだけ上へ運べばよい。逆だと、繋ぎたいだけの人が毎回下ろすことになる。
  */
  let q = importCutResult(p, {
    asset: { id: 'd', path: '/d.mp4', name: 'D', duration: 20, hasVideo: true, hasAudio: true },
    keeps: [{ srcStart: 0, srcEnd: 4 }, { srcStart: 10, srcEnd: 13 }],
  });
  eq('末尾に詰めて足される', mainSpans(q), [[0, 5], [5, 15], [15, 20], [20, 24], [24, 27]]);
  eq('レーンは増えない', q.lanes.length, 1);

  /*
    上へ運んだら、そこが映ること。
    🔴 「上に置いたものが映る」が成り立たないと、重ねる意味が無い。
  */
  q = addLane(q, { id: 'v9', kind: 'video', name: '重ね' });
  const moved = q.clips[3].id;
  q = moveClip(q, moved, 'v9', 6);

  eq('本編から抜ける', mainSpans(q), [[0, 5], [5, 15], [15, 20], [20, 23]]);
  const up = layout(q).find((c) => c.laneId === 'v9');
  eq('運んだ先の位置', [up.start, up.end], [6, 10]);
  eq('重ねた所は上が映る', videoAt(q, 7)?.assetId, 'd');
  eq('重ねていない所は本編', videoAt(q, 2)?.assetId, 'c');
  eq('重ねが終われば本編に戻る', videoAt(q, 16)?.assetId, 'c');
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


/* ------------------------------------------------------------ 空きの伸縮 */

{
  let p = base();
  p = appendToMain(p, 'a', 0, 10);
  p = appendToMain(p, 'b', 0, 5);
  const gapped = removeClip(p, p.clips[0].id, 'lift');
  const gapId = gapped.clips[0].id;

  // 🔴 空きも伸ばせること。伸ばせないと、一度空けた間合いを直せない
  const wider = trimClip(gapped, gapId, 'end', 5);
  eq('空きを伸ばせる', mainSpans(wider), [[0, 15], [15, 20]]);
  const narrower = trimClip(gapped, gapId, 'end', -4);
  eq('空きを縮められる', mainSpans(narrower), [[0, 6], [6, 11]]);

  // 空きを消せば詰まる
  eq('空きを消すと詰まる', mainSpans(removeClip(gapped, gapId)), [[0, 5]]);
}


/* ------------------------------------------------------------ クリップ名 */

{
  let p = base();
  p = appendToMain(p, 'a', 0, 10);
  p = appendToMain(p, 'a', 20, 30);
  p = appendToMain(p, 'b', 0, 5);

  // 🔴 素材の名前をそのまま使わない。同じ名前が並ぶと追えない
  eq('素材ごとに連番が付く', p.clips.map((c) => c.name), ['A 1', 'A 2', 'B 1']);

  // 拡張子は落とす
  let q = emptyProject();
  q = addAsset(q, { id: 'x', path: '/m/トーク.mp4', name: 'トーク.mp4', duration: 30, hasVideo: true, hasAudio: true });
  q = appendToMain(q, 'x');
  eq('拡張子を落とす', q.clips[0].name, 'トーク 1');

  // 🔴 途中を消しても、次の番号が既にあるものとぶつからない
  const dropped = removeClip(p, p.clips[0].id);
  const added = appendToMain(dropped, 'a', 40, 45);
  eq('消した後でも名前がぶつからない',
     added.clips.filter((c) => c.assetId === 'a').map((c) => c.name).length,
     new Set(added.clips.filter((c) => c.assetId === 'a').map((c) => c.name)).size);

  // 分けたら枝番が付く
  const bladed = bladeAt(p, 'main', 4);
  eq('分けたら別の名前になる', bladed.clips.slice(0, 2).map((c) => c.name), ['A 1a', 'A 1b']);

  // 空きには「空き」
  const gapped = removeClip(p, p.clips[1].id, 'lift');
  eq('空きの名前', gapped.clips[1].name, '空き');

  // 上のレーンでも付く
  const over = placeOnLane(p, 'v2', 'b', 3, 0, 2);
  eq('上のレーンでも名前が付く', over.clips[over.clips.length - 1].name, 'B 2');

  // 名前だけを引くこともできる
  eq('次に付く名前が引ける', clipName(p, 'b'), 'B 2');
}

/* ==================================================== テロップの直し */
{
  const base = () => importCutResult(emptyProject(), {
    asset: { id: 'a', path: '/m/a.mp4', name: 'a', duration: 60, hasVideo: true, hasAudio: true },
    // 20秒ぶんを2つに割って置く
    keeps: [{ srcStart: 0, srcEnd: 10 }, { srcStart: 30, srcEnd: 40 }],
    telops: [{ srcStart: 2, srcEnd: 5, text: 'まえ', style: 'normal' }],
  });

  /* ------------------------------------------------------------ 直す */
  let p = base();
  const tid = p.telops[0].id;

  p = updateTelop(p, tid, { text: 'なおした' });
  eq('本文が変わる', p.telops[0].text, 'なおした');
  eq('時刻は変わらない', [p.telops[0].srcStart, p.telops[0].srcEnd], [2, 5]);

  p = updateTelop(p, tid, { style: 'emphasis' });
  eq('見た目が変わる', p.telops[0].style, 'emphasis');

  /*
    🔴 何も変わらない直しでは、同じものを返すこと。
       毎回新しい project を作ると、取り消しの履歴が
       「何も変わっていない状態」で埋まる。
  */
  eq('同じ内容なら作り直さない', updateTelop(p, tid, { text: 'なおした' }) === p, true);

  /*
    🔴 長さが 0 以下になる直しは通さない。
       通すと画面にもプレビューにも出なくなり、
       「消えた」のか「一瞬になった」のか分からないテロップが残る。
  */
  eq('終わりを始まりより前にはできない', updateTelop(p, tid, { srcEnd: 1 }) === p, true);
  eq('一瞬すぎる長さにはできない', updateTelop(p, tid, { srcEnd: 2.02 }) === p, true);
  eq('知らない id は何もしない', updateTelop(p, 'ない', { text: 'x' }) === p, true);

  /* ------------------------------------------------------------ 消す */
  const gone = removeTelop(p, tid);
  eq('消える', gone.telops.length, 0);
  eq('知らない id では作り直さない', removeTelop(gone, tid) === gone, true);

  /* ------------------------------------------------------------ 足す */
  let q = base();
  const clips = layout(q);
  q = addTelop(q, clips[0], 3, 2, 'あたらしい');
  eq('足した本数', q.telops.length, 2);
  const added = q.telops[1];
  eq('置いた位置は素材の時刻', [added.srcStart, added.srcEnd], [3, 5]);

  /*
    🔴 クリップの外へはみ出させないこと。
       はみ出した分は、そのクリップの上には出ないので
       「足したのに出てこない」ように見える。
  */
  const late = addTelop(base(), clips[0], 9.5, 5, 'はみ出す');
  eq('クリップの終わりで止まる', late.telops[1].srcEnd, 10);

  /*
    🔴 空きにはテロップを置けないこと。
       素材が無いので、置いても出す先が無い。
  */
  const empty = base();
  eq('空きには置けない',
     addTelop(empty, { ...layout(empty)[0], assetId: '' }, 3) === empty, true);

  /* ------------------------- 2つ目のクリップに足す（素材の時刻が飛ぶ） */
  let r = base();
  const cl = layout(r);
  // 2つ目のクリップは素材の30秒目から。タイムラインでは10秒目から始まる
  eq('2つ目の置き場所', [cl[1].start, cl[1].srcStart], [10, 30]);
  r = addTelop(r, cl[1], 12, 2, 'あと');
  /*
    🔴 タイムラインの時刻をそのまま入れないこと。
       素材の時刻へ直さないと、テロップだけ元の場所（素材の12秒目）に置かれ、
       出したい場所には何も出ない。
  */
  eq('素材の時刻へ直して置く', [r.telops[1].srcStart, r.telops[1].srcEnd], [32, 34]);

  const shown = placedTelops(r).find((t) => t.text === 'あと');
  eq('タイムライン上では 12 秒から', [shown.start, shown.end], [12, 14]);

  /* --------------------------------------------- 端をタイムラインで動かす */
  let s = base();
  const c0 = layout(s)[0];
  s = moveTelopEdge(s, s.telops[0].id, c0, 'end', 7);
  eq('終わりを 7 秒へ', s.telops[0].srcEnd, 7);

  let s2 = base();
  const c1 = layout(s2)[1];
  s2 = addTelop(s2, c1, 12, 2, 'あと');
  const t2 = s2.telops[1].id;
  s2 = moveTelopEdge(s2, t2, c1, 'end', 15);
  eq('2つ目のクリップでも素材の時刻に直る', s2.telops[1].srcEnd, 35);
}

/* ==================================================== クリップの名前と音量 */
{
  let p = importCutResult(emptyProject(), {
    asset: { id: 'a', path: '/m/a.mp4', name: 'トーク', duration: 60, hasVideo: true, hasAudio: true },
    keeps: [{ srcStart: 0, srcEnd: 10 }],
  });
  const id = p.clips[0].id;

  eq('自動で付く名前', p.clips[0].name, 'トーク 1');
  p = renameClip(p, id, '  導入  ');
  eq('前後の空白は落とす', p.clips[0].name, '導入');
  eq('空の名前にはできない', renameClip(p, id, '   ') === p, true);
  eq('同じ名前なら作り直さない', renameClip(p, id, '導入') === p, true);

  /* ------------------------------------------------------------ 音量 */
  eq('既定では持たない', p.clips[0].gainDb, undefined);

  p = setClipGain(p, id, -6);
  eq('下げられる', p.clips[0].gainDb, -6);

  /*
    🔴 0 に戻したら持たないこと。
       0 は「素材のまま」なので、書類に残すと
       意味のない値でファイルが太るうえ、差分も汚れる。
  */
  p = setClipGain(p, id, 0);
  eq('0 に戻すと消える', 'gainDb' in p.clips[0], false);

  /*
    🔴 範囲で縛ること。+60dB は 1000 倍で、書き出しが割れる。
  */
  eq('上限で止まる', setClipGain(p, id, 999).clips[0].gainDb, GAIN_RANGE.max);
  eq('下限で止まる', setClipGain(p, id, -999).clips[0].gainDb, GAIN_RANGE.min);
  eq('0.1 まで刻む', setClipGain(p, id, -6.44).clips[0].gainDb, -6.4);
  eq('知らない id では作り直さない', setClipGain(p, 'ない', -3) === p, true);
}

/* ================================================ 複製と貼り付け */
{
  const base = () => importCutResult(emptyProject(), {
    asset: { id: 'a', path: '/m/a.mp4', name: 'トーク', duration: 60, hasVideo: true, hasAudio: true },
    keeps: [{ srcStart: 0, srcEnd: 5 }, { srcStart: 20, srcEnd: 25 }, { srcStart: 40, srcEnd: 45 }],
  });

  /* -------------------------------------------------------- 複製 */
  let p = base();
  const second = p.clips[1].id;
  p = duplicateClip(p, second);

  eq('本数が増える', p.clips.length, 4);
  /*
    🔴 すぐ後ろに入ること。
       末尾に足すと、詰める設定では一番後ろへ飛び、
       複製したものを毎回探して運ぶことになる。
  */
  eq('元のすぐ後ろに入る', p.clips.map((c) => c.srcStart), [0, 20, 20, 40]);
  eq('中身は同じ', [p.clips[2].srcStart, p.clips[2].srcEnd], [20, 25]);
  eq('別のクリップになっている', p.clips[1].id === p.clips[2].id, false);
  // 🔴 同じ名前が2つあると、どちらを動かしたのか追えない
  eq('名前は付け直す', p.clips[1].name === p.clips[2].name, false);

  const place = layout(p);
  eq('詰めた並び', place.map((c) => [c.start, c.end]),
     [[0, 5], [5, 10], [10, 15], [15, 20]]);

  // 空きは複製しない（複製しても何も映らないものが増えるだけ）
  {
    const one = base();
    const g = removeClip(one, one.clips[0].id, 'lift');
    eq('空きになっている', isGap(g.clips[0]), true);
    eq('空きは複製しない', duplicateClip(g, g.clips[0].id) === g, true);
  }
  eq('知らない id では作り直さない', duplicateClip(p, 'ない') === p, true);

  /* ------------------------------------------------ 貼り付け（詰める） */
  let q = base();
  const copied = { assetId: 'a', srcStart: 50, srcEnd: 53 };
  // 再生位置 7 秒 = 2本目（5〜10秒）の上
  q = pasteClip(q, copied, q.lanes[0].id, 7);
  eq('貼った本数', q.clips.length, 4);
  /*
    🔴 詰めるレーンでは、再生位置がどのクリップの上かで割り込み先を決める。
       位置は見ないレーンなので、末尾に足すと関係のない場所に出る。
  */
  eq('再生位置のクリップの前に入る', q.clips.map((c) => c.srcStart), [0, 50, 20, 40]);
  eq('長さはそのまま', layout(q)[1].end - layout(q)[1].start, 3);

  // 末尾より後ろなら末尾へ
  const tail = pasteClip(base(), copied, base().lanes[0].id, 999);
  eq('末尾より後ろなら末尾へ', tail.clips.map((c) => c.srcStart), [0, 20, 40, 50]);

  /* ------------------------------------------------ 貼り付け（重ねる） */
  let r = base();
  r = addLane(r, { id: 'v1', kind: 'video', name: '重ね' });
  r = pasteClip(r, copied, 'v1', 8.5);
  const on = layout(r).find((c) => c.laneId === 'v1');
  eq('重ねるレーンは位置をそのまま持つ', [on.start, on.end], [8.5, 11.5]);

  /* ---------------------------------------------------- 通さないもの */
  eq('素材が無ければ貼らない',
     pasteClip(base(), { assetId: 'ない', srcStart: 0, srcEnd: 1 }, base().lanes[0].id, 0)
       .clips.length, 3);
  eq('レーンが無ければ貼らない',
     pasteClip(base(), copied, 'ないレーン', 0).clips.length, 3);
  eq('長さ0は貼らない',
     pasteClip(base(), { assetId: 'a', srcStart: 5, srcEnd: 5 }, base().lanes[0].id, 0)
       .clips.length, 3);

  // 音量も一緒に控えられる
  const withGain = pasteClip(base(), { ...copied, gainDb: -6 }, base().lanes[0].id, 0);
  eq('音量も引き継ぐ', withGain.clips[0].gainDb, -6);
}

/* ================================================ 書き出しの選択 */
{
  const s = emptyProject().settings;
  eq('既定は焼き込む', s.burnTelops, true);
  eq('既定は字幕も作る', s.writeSrt, true);
  eq('既定は音量をそろえる', s.loudnorm, true);
}

/* ================================================ レーンと区間 */
{
  const base = () => {
    let p = importCutResult(emptyProject(), {
      asset: { id: 'a', path: '/m/a.mp4', name: 'トーク', duration: 60, hasVideo: true, hasAudio: true },
      keeps: [{ srcStart: 0, srcEnd: 5 }, { srcStart: 20, srcEnd: 25 }, { srcStart: 40, srcEnd: 45 }],
    });
    p = addLane(p, { id: 'v1', kind: 'video', name: '重ね' });
    p = placeOnLane(p, 'v1', 'a', 2, 30, 33);
    return p;
  };

  /* ------------------------------------------------------ レーンを消す */
  let p = base();
  eq('消す前の本数', p.clips.length, 4);
  eq('乗っている数が引ける', clipsOnLane(p, 'v1'), 1);

  const gone = removeLane(p, 'v1');
  eq('レーンが減る', gone.lanes.length, 1);
  eq('乗っていたクリップも消える', gone.clips.length, 3);

  /*
    🔴 本編は消せないこと。土台が無くなると、置き場所の無いクリップだけが残る。
  */
  eq('本編は消せない', removeLane(p, p.lanes[0].id) === p, true);
  eq('知らないレーンでは作り直さない', removeLane(p, 'ない') === p, true);

  /*
    🔴 テロップは残すこと。素材に結び付いているので、レーンとは関係が無い。
  */
  let withTelop = importCutResult(base(), {
    asset: { id: 'b', path: '/m/b.mp4', name: 'B', duration: 30, hasVideo: true, hasAudio: true },
    keeps: [{ srcStart: 0, srcEnd: 5 }],
    telops: [{ srcStart: 1, srcEnd: 3, text: 'x', style: 'normal' }],
  });
  eq('テロップは消えない', removeLane(withTelop, 'v1').telops.length, 1);

  /* -------------------------------------------------- レーンの名前 */
  eq('名前を変えられる', renameLane(p, 'v1', 'B ロール').lanes[1].name, 'B ロール');
  eq('前後の空白は落とす', renameLane(p, 'v1', '  差し込み  ').lanes[1].name, '差し込み');
  eq('同じ名前なら作り直さない', renameLane(p, 'v1', '重ね') === p, true);

  /* ------------------------------------------------------ 区間を消す */
  // 本編は 0-5 / 5-10 / 10-15 に並んでいる
  const mainId = base().lanes[0].id;
  eq('並び', layout(base()).filter((c) => c.laneId === mainId).map((c) => [c.start, c.end]),
     [[0, 5], [5, 10], [10, 15]]);

  /*
    🔴 半分だけかかっているクリップを丸ごと消さないこと。
       3〜7秒を指定したら、消えるのは3〜7秒だけ。
  */
  const cut = removeRange(base(), mainId, 3, 7, 'ripple');
  const after = layout(cut).filter((c) => c.laneId === mainId);
  eq('指定した4秒ぶんだけ短くなる', timelineDuration(cut), 11);
  eq('前半の残り', [after[0].start, after[0].end], [0, 3]);
  eq('残った所の中身（前）', [after[0].srcStart, after[0].srcEnd], [0, 3]);
  // 5〜7秒は2本目の 20〜22 にあたるので、残るのは 22〜25
  eq('残った所の中身（後）', [after[1].srcStart, after[1].srcEnd], [22, 25]);

  /* -------------------------------------------- 空きにする（詰めない） */
  const lift = removeRange(base(), mainId, 3, 7, 'lift');
  eq('尺は変わらない', timelineDuration(lift), 15);
  const lifted = layout(lift).filter((c) => c.laneId === mainId);
  eq('間が空きになる', lifted.filter((c) => isGap(c)).map((c) => [c.start, c.end]), [[3, 5], [5, 7]]);

  /* ---------------------------------------------------- 通さないもの */
  const same = base();
  eq('長さ0では作り直さない', removeRange(same, mainId, 4, 4) === same, true);

  /*
    🔴 区間の外は巻き込まないこと。
       詰めながら消すと、後ろのクリップが前へ動いて区間に入り込む。
  */
  const one = removeRange(base(), mainId, 0, 5, 'ripple');
  eq('1本ぶんだけ消える', layout(one).filter((c) => c.laneId === mainId).length, 2);
  eq('残りの中身', layout(one).filter((c) => c.laneId === mainId).map((c) => c.srcStart), [20, 40]);
}

/* ================================================ 画角（変形） */
{
  let p = importCutResult(emptyProject(), {
    asset: { id: 'a', path: '/m/a.mp4', name: 'A', duration: 60,
             hasVideo: true, hasAudio: true, width: 1920, height: 1080 },
    keeps: [{ srcStart: 0, srcEnd: 10 }],
  });
  const id = p.clips[0].id;

  // 🔴 何もしない変形は持たない。書類が無駄に太る
  eq('既定では持たない', p.clips[0].transform, undefined);
  eq('等倍を入れても持たない', setClipTransform(p, id, NO_TRANSFORM) === p, true);

  p = setClipTransform(p, id, { scale: 1.5 });
  eq('倍率が入る', p.clips[0].transform, { scale: 1.5, x: 0, y: 0 });

  p = setClipTransform(p, id, { x: 0.2, y: -0.1 });
  eq('ずらしが入る（前の倍率は残る）', p.clips[0].transform, { scale: 1.5, x: 0.2, y: -0.1 });

  // 0 に戻したら持たない
  p = setClipTransform(p, id, NO_TRANSFORM);
  eq('戻すと消える', 'transform' in p.clips[0], false);

  /*
    🔴 範囲で縛ること。
       倍率0は絵が消えて「真っ黒になった」としか分からなくなるし、
       大きすぎる倍率は書き出しで巨大な中間画像を作る。
  */
  eq('倍率の下限', setClipTransform(p, id, { scale: 0 }).clips[0].transform.scale,
     TRANSFORM_RANGE.minScale);
  eq('倍率の上限', setClipTransform(p, id, { scale: 999 }).clips[0].transform.scale,
     TRANSFORM_RANGE.maxScale);
  eq('ずらしの上限', setClipTransform(p, id, { x: 99 }).clips[0].transform.x,
     TRANSFORM_RANGE.maxShift);
  eq('ずらしの下限', setClipTransform(p, id, { y: -99 }).clips[0].transform.y,
     -TRANSFORM_RANGE.maxShift);
  eq('数でないものは既定へ',
     setClipTransform(p, id, { scale: NaN, x: 0.3 }).clips[0].transform, { scale: 1, x: 0.3, y: 0 });
  eq('知らない id では作り直さない', setClipTransform(p, 'ない', { scale: 2 }) === p, true);

  /* ------------------------------------------------ 枠いっぱいの倍率 */
  /*
    🔴 横の素材を縦のプロジェクトに置くと、上下に黒帯が残る。
       ショート動画では毎回やる操作なので、1回で決まる道を用意する。
  */
  const yoko = { width: 1920, height: 1080 };
  const tate = { width: 1080, height: 1920 };
  eq('同じ形なら等倍', fillScale(yoko, { width: 1920, height: 1080 }), 1);
  // 横1920x1080 を縦1080x1920 に収めると 0.5625倍。いっぱいにするには 1.7778倍
  // その比は 3.1605 → 上限 4 に収まる
  const s = fillScale(yoko, tate);
  eq('横を縦の枠いっぱいにすると寄る', s > 3.15 && s < 3.17, true);
  eq('上限を超えない', fillScale({ width: 10000, height: 10 }, tate) <= TRANSFORM_RANGE.maxScale, true);
  eq('大きさが分からない素材は等倍', fillScale({}, tate), 1);
}

if (failed > 0) {
  console.error(`\ntest-timeline-project: NG ${failed} 件`);
  process.exit(1);
}
console.log('test-timeline-project: OK');
