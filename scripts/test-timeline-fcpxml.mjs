/**
 * 並べたタイムラインの書き出し（Final Cut の XML）を検める。
 *
 * 🔴 中身の並びが違うと、Final Cut は XML ごと読み込みを断る。
 *    そのとき出るのは「DTD の検証でエラーが起きました」だけなので、
 *    どこが悪いかは現物からは分からない。机上で潰しておく。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = await import(pathToFileURL(join(root, 'src/timeline/project.ts')).href);
const X = await import(pathToFileURL(join(root, 'src/timeline/fcpxml.ts')).href);

const { emptyProject, addAsset, addLane, appendToMain, placeOnLane, importCutResult } = P;
const { buildFCPXML, timeStr, fileUrl, frameDuration } = X;

let failed = 0;
const check = (label, ok, detail = '') => {
  if (!ok) {
    console.error(`  NG ${label}${detail ? `\n     ${detail}` : ''}`);
    failed++;
  }
};
const eq = (label, got, want) =>
  check(label, JSON.stringify(got) === JSON.stringify(want), `期待 ${JSON.stringify(want)} / 実際 ${JSON.stringify(got)}`);

/* ---------------------------------------------------------------- 小物 */

eq('30fps の1コマ', frameDuration(30), { num: 100, den: 3000 });
eq('29.97 は 1001 系', frameDuration(29.97), { num: 1001, den: 30030 });
eq('0秒', timeStr(0, 30), '0s');
eq('1秒', timeStr(1, 30), '3000/3000s');
eq('端数はフレームに丸める', timeStr(1.004, 30), '3000/3000s');

// 🔴 区切りは残す。まとめて潰すとパスが壊れる
check('パスが file:// になる', fileUrl('C:/movies/a b.mp4') === 'file:///C%3A/movies/a%20b.mp4',
      fileUrl('C:/movies/a b.mp4'));
check('Windows の \\ も直る', fileUrl('C:\\movies\\a.mp4') === 'file:///C%3A/movies/a.mp4',
      fileUrl('C:\\movies\\a.mp4'));

/* ------------------------------------------------------------ 素材を並べる */

function base() {
  let p = emptyProject();
  p = addAsset(p, { id: 'a', path: '/m/a.mp4', name: 'A', duration: 60, hasVideo: true, hasAudio: true });
  p = addAsset(p, { id: 'b', path: '/m/b.mp4', name: 'B', duration: 30, hasVideo: true, hasAudio: false });
  p = addAsset(p, { id: 'm', path: '/m/bgm.mp3', name: 'BGM', duration: 120, hasVideo: false, hasAudio: true });
  p = addLane(p, { id: 'v2', kind: 'video', name: '重ね' });
  p = addLane(p, { id: 'm1', kind: 'audio', name: '音' });
  return p;
}

{
  let p = base();
  p = appendToMain(p, 'a', 10, 20);   // 0-10
  p = appendToMain(p, 'b', 0, 5);     // 10-15
  const xml = buildFCPXML(p, { name: 'テスト', fps: 30 });

  check('宣言がある', xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  check('版は 1.13', xml.includes('<fcpxml version="1.13">'));

  // 🔴 library に属性は無い
  check('library に属性を付けない', xml.includes('  <library>\n'), 'library の行が違う');
  // 🔴 sequence の中は spine だけ
  const seq = xml.slice(xml.indexOf('<sequence'), xml.indexOf('</sequence>'));
  const seqKids = [...seq.matchAll(/^\s{10}<(\w[\w-]*)/gm)].map((m) => m[1]);
  eq('sequence の直下は spine だけ', [...new Set(seqKids)], ['spine']);

  check('素材が2本ぶん出ている', (xml.match(/<asset id=/g) || []).length === 3,
        `実際 ${(xml.match(/<asset id=/g) || []).length}`);
  check('使っていない素材も resources には出る（BGM）', xml.includes('name="BGM"'));
  check('音の無い素材は hasAudio=0', /name="B"[^>]*hasAudio="0"/.test(xml));
  check('映像の無い素材は hasVideo=0', /name="BGM"[^>]*hasVideo="0"/.test(xml));

  check('素材の途中から使っている', xml.includes('start="30000/3000s"'), '10秒の位置から');
  check('2本目が10秒の所に置かれる', xml.includes('offset="30000/3000s"'));
}

/* -------------------------------------------------------------- 重ねる */

{
  let p = base();
  p = appendToMain(p, 'a', 10, 30);          // 0-20（素材の10秒から）
  p = placeOnLane(p, 'v2', 'b', 5, 0, 4);    // 5-9 に重ねる
  p = placeOnLane(p, 'm1', 'm', 0, 0, 20);   // 0-20 に BGM
  const xml = buildFCPXML(p, { fps: 30 });

  check('重ねたものが親の中に入っている',
        xml.indexOf('lane="1"') > xml.indexOf('<asset-clip ref="a1"'));
  /*
    🔴 ぶら下げたものの offset は「親の中の時刻」。
       親は素材の10秒から始まっているので、タイムライン 5秒 は 15秒 になる。
       ここをタイムラインの時刻のまま書くと、重ねた映像が5秒ぶん手前に出る。
  */
  check('重ねた offset が親の時間になっている', xml.includes('lane="1" name="') && /lane="1"[^>]*offset="45000\/3000s"/.test(xml),
        (xml.match(/lane="1"[^>]*offset="[^"]+"/) || ['無し'])[0]);
  check('BGM に役が付く', xml.includes('audioRole="music"'));
}

/* ------------------------------------------------------------ テロップ */

{
  let p = importCutResult(emptyProject(), {
    asset: { id: 'c', path: '/m/c.mp4', name: 'C', duration: 100, hasVideo: true, hasAudio: true },
    keeps: [{ srcStart: 0, srcEnd: 10 }, { srcStart: 50, srcEnd: 60 }],
    telops: [
      { srcStart: 2, srcEnd: 4, text: 'ふつう', style: 'normal' },
      { srcStart: 52, srcEnd: 54, text: 'つよい<&>', style: 'emphasis' },
    ],
  });
  const xml = buildFCPXML(p, { fps: 30 });

  check('テロップの見た目が resources に出る', xml.includes('<effect id="rT"'));
  check('テロップが2つ', (xml.match(/<title /g) || []).length === 2,
        `実際 ${(xml.match(/<title /g) || []).length}`);

  // 🔴 title の中の並び: text → text-style-def
  const title = xml.slice(xml.indexOf('<title '), xml.indexOf('</title>'));
  check('title の中は text が先', title.indexOf('<text>') < title.indexOf('<text-style-def'));
  check('text-style-def は title の中にある', title.includes('<text-style-def'));

  // 🔴 id は書類の中で1つきり
  const ids = [...xml.matchAll(/<text-style-def id="([^"]+)"/g)].map((m) => m[1]);
  eq('定義の名前が重ならない', ids.length === new Set(ids).size, true);
  // 参照先が必ず存在する
  const refs = [...xml.matchAll(/<text-style ref="([^"]+)"/g)].map((m) => m[1]);
  check('参照先の定義が全部ある', refs.every((r) => ids.includes(r)), `${refs} / ${ids}`);

  check('記号がエスケープされている', xml.includes('&lt;&amp;&gt;'));
  check('強調は大きい', xml.includes('fontSize="96"'));
  check('雛形の内部 start を使う', xml.includes('start="3600s"'));

  /*
    2本目のクリップは素材の50秒から。テロップ「つよい」は素材の52秒。
    親の中の時刻なので 52秒 = 156000/3000s になる。
  */
  check('2本目のテロップが親の時間で入る', xml.includes('offset="156000/3000s"'),
        (xml.match(/name="つよい[^"]*"[^>]*offset="[^"]+"/) || ['無し'])[0]);
}

/* ------------------------------------------------------------ 穴（隙間） */

{
  let p = base();
  p = appendToMain(p, 'a', 0, 10);
  p = { ...p, magnetic: false, clips: p.clips.map((c) => ({ ...c, at: 0 })) };
  p = appendToMain(p, 'b', 0, 5);
  // 2本目を 20秒 の位置へ（間に10秒の穴）
  p = { ...p, clips: p.clips.map((c, i) => (i === 1 ? { ...c, at: 20 } : c)) };

  const xml = buildFCPXML(p, { fps: 30 });
  /*
    🔴 穴は <gap> で埋めること。offset を飛ばして書くと、
       Final Cut は前のクリップが伸びているものとして読む。
  */
  check('穴が gap で埋まる', xml.includes('<gap name="Gap"'), '無し');
  check('穴の長さが正しい', /<gap[^>]*offset="30000\/3000s"[^>]*duration="30000\/3000s"/.test(xml),
        (xml.match(/<gap[^>]*\/>/) || ['無し'])[0]);
}

/* -------------------------------------------------------------- 空 */

{
  const xml = buildFCPXML(emptyProject(), { fps: 30 });
  check('空でも XML になる', xml.includes('<spine>') && xml.includes('</fcpxml>'));
  check('空ならクリップは出ない', !xml.includes('<asset-clip'));
}

/* ------------------------------------------------ 29.97 でもフレームに乗る */

{
  let p = base();
  p = appendToMain(p, 'a', 0, 7.3);
  const xml = buildFCPXML(p, { fps: 29.97 });
  const times = [...xml.matchAll(/(?:offset|duration|start)="(\d+)\/(\d+)s"/g)];
  const bad = times.filter(([, n, d]) => Number(d) === 30030 && Number(n) % 1001 !== 0);
  eq('29.97 でもフレームの境に乗る', bad.length, 0);
}


/* ------------------------------------------------------ 空き（gap クリップ）*/

{
  const { removeClip } = P;
  let p = base();
  p = appendToMain(p, 'a', 0, 10);
  p = appendToMain(p, 'b', 0, 5);
  p = appendToMain(p, 'a', 20, 25);
  // 真ん中を空きにする
  p = removeClip(p, p.clips[1].id, 'lift');

  const xml = buildFCPXML(p, { fps: 30 });
  // 🔴 空きを飛ばすと、そのぶん後ろが前に詰まって書き出される
  check('空きが gap になる', (xml.match(/<gap /g) || []).length === 1,
        `実際 ${(xml.match(/<gap /g) || []).length}`);
  check('空きの位置と長さ',
        /<gap[^>]*offset="30000\/3000s"[^>]*duration="15000\/3000s"/.test(xml),
        (xml.match(/<gap[^>]*\/>/) || ['無し'])[0]);
  check('空きの後ろのクリップが正しい位置',
        xml.includes('offset="45000/3000s"'), '15秒の位置');
}

if (failed > 0) {
  console.error(`\ntest-timeline-fcpxml: NG ${failed} 件`);
  process.exit(1);
}
console.log('test-timeline-fcpxml: OK');
