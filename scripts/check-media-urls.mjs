/**
 * 動画の読み込み URL の形式を検める。
 *
 * 🔴 なぜ要るか（2026-08-25 に踏んだ）:
 *
 *    UI を作り直したとき、`app-media://...` という**存在しないプロトコル**で
 *    <video> の src を組み立ててしまった。カット画面もテロップ画面も
 *    映像が一切出ない状態のまま、動いているつもりでいた。
 *
 *    存在しないプロトコルは**例外にならない**。<video> が黙って
 *    MEDIA_ELEMENT_ERROR になるだけで、コンソールにも大きくは出ない。
 *    型検査もテストも素通りする。だから機械で見張る。
 *
 * 決まり:
 *   electron/main/index.ts が登録しているのは `media` だけ。
 *   受け取る形は media://local/<encodeURIComponent した絶対パス>。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SRC = join(ROOT, 'src');

/** 許されるのはこれだけ */
const ALLOWED_PREFIX = 'media://local/';

/**
 * この検査の対象外にするファイル。
 *
 * 🔴 「画面で読ませる URL」だけを見る検査だと決めること。
 *    ここに挙げるのは、画面の <video> ではなく**外部のソフトに渡す**
 *    書類を組み立てているところ。Final Cut の XML は素材の場所を
 *    file:// で書く決まりで、media://local/ にすると Final Cut 側が
 *    素材を見つけられない（オフラインのクリップになる）。
 *
 * 🔴 安易に増やさないこと。ここへ足すということは、
 *    「映像が黙って出ない」壊れ方を見逃す穴を1つ開けるということ。
 */
const EXEMPT = [
  // Final Cut Pro に渡す XML。src は file:// でなければならない
  'src/timeline/fcpxml.ts',
  /*
    素材の URL を作る本人。「そのまま通してよい入れ物」の一覧を持つので、
    ここに入れ物の名前が並ぶのは当たり前。
    🔴 この検査の狙いは「うっかり別のプロトコルを書くこと」を防ぐこと。
       作っている当人を対象にすると、正しい実装ができない。
  */
  'src/timeline/assetUrl.ts',
];

/** src={...} の中に出てくる `なにか://` を拾う */
const SCHEME = /['"`]([a-zA-Z][\w-]*:\/\/[^'"`$]*)/g;

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(p)) files.push(p);
  }
})(SRC);

const bad = [];
for (const file of files) {
  const rel = relative(ROOT, file).split('\\').join('/');
  if (EXEMPT.includes(rel)) continue;
  const text = readFileSync(file, 'utf8');
  text.split(/\r?\n/).forEach((line, i) => {
    // コメント行は対象外。ここに「やってはいけない形」を書き残せなくなるため
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    for (const m of line.matchAll(SCHEME)) {
      const url = m[1];
      // http(s) は外部のリンクや説明文なので対象外
      if (/^https?:\/\//.test(url)) continue;
      if (url.startsWith(ALLOWED_PREFIX)) continue;
      bad.push({ file: relative(ROOT, file), line: i + 1, url, text: line.trim() });
    }
  });
}

if (bad.length > 0) {
  console.error('media-url-guard: 知らないプロトコルが使われています\n');
  for (const b of bad) {
    console.error(`  ${b.file}:${b.line}  ${b.url}`);
    console.error(`    ${b.text.slice(0, 100)}`);
  }
  console.error(`
使ってよいのは ${ALLOWED_PREFIX} だけです（electron/main/index.ts が登録しているもの）。
src/shell/media.ts の mediaUrl() を通してください。

理由: 存在しないプロトコルは例外になりません。<video> が黙って読み込みに失敗し、
      映像が出ないだけの状態になります。型検査もテストも通ってしまいます。`);
  process.exit(1);
}

console.log(`media-url-guard: OK — ${files.length} ファイルを確認、知らないプロトコルはありません`);
