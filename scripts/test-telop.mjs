/**
 * テロップの改行と表示時刻の検証。
 *
 * この2つは、間違っていても**画面上は普通に見える**のがやっかいなところ。
 *   - 改行位置は「読みにくい」だけで、壊れているようには見えない
 *   - 表示時刻の重なりは、書き出して初めて「後半のテロップが全部ずれている」と分かる
 * どちらも数百枚のうちの数枚で起きるので、手で試して見つけるのは現実的でない。
 *
 * 実行: node scripts/test-telop.mjs
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const outDir = mkdtempSync(join(tmpdir(), 'telop-test-'));

// TS のまま読めないので、tsc で JS にする。
// 🔴 npx ではなく node から直接呼ぶ。Windows では npx.cmd を execFile できない。
execFileSync(
  process.execPath,
  [
    join(root, 'node_modules/typescript/bin/tsc'),
    join(root, 'src/telop/split.ts'),
    '--outDir',
    outDir,
    '--rootDir',
    join(root, 'src/telop'),
    '--module',
    'esnext',
    '--target',
    'es2022',
    '--moduleResolution',
    'bundler',
    '--ignoreConfig',
    // 型検査は npm run typecheck が全体に対して行う。ここは JS にするだけでよい
    '--noCheck',
  ],
  { cwd: root, stdio: 'inherit' },
);

/*
  ソースは Vite が解決する前提で拡張子を書いていない（`./render`）。
  Node の ESM は拡張子を補ってくれないので、出力側で足す。
*/
for (const name of readdirSync(outDir)) {
  if (!name.endsWith('.js')) continue;
  const path = join(outDir, name);
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replace(/(from\s+'\.\/[^']+)'/g, (m, head) =>
      head.endsWith('.js') ? m : `${head}.js'`,
    ),
    'utf8',
  );
}

/*
  budoux-ja.ts は node_modules の中を相対パスで指している（バンドルを太らせないため）。
  一時フォルダへ出すとその相対パスが外れるので、絶対パスで書き直す。
  読み込む中身は同じ BudouX なので、検証内容は変わらない。
*/
const budouxDir = pathToFileURL(join(root, 'node_modules/budoux/module/')).href;
writeFileSync(
  join(outDir, 'budoux-ja.js'),
  `import { Parser } from '${budouxDir}parser.js';\n` +
    `import { model } from '${budouxDir}data/models/ja.js';\n` +
    `export const japaneseParser = new Parser(model);\n`,
  'utf8',
);

const split = await import(pathToFileURL(join(outDir, 'split.js')).href);
const wrap = await import(pathToFileURL(join(outDir, 'wrap.js')).href);

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`[telop] ${ok ? 'OK  ' : 'NG  '} ${name}`);
  if (!ok && detail !== undefined) console.log(`        ${detail}`);
}

/** 全角=1文字ぶん / 半角=0.5 で近似する（描画の一致は T1 が別途見ている） */
const measure = (text, fontPx) => {
  let width = 0;
  for (const ch of text) width += (ch.codePointAt(0) < 0x3000 ? 0.5 : 1) * fontPx;
  return width;
};
const at = (px) => (text, scale) => measure(text, px * scale);

// ── 改行位置 ───────────────────────────────────────────────

{
  // 収まるなら改行しない
  const r = wrap.wrapJapaneseByWidth((t) => measure(t, 10), '今日はいい天気ですね', 1000);
  check('収まるうちは改行しない', r.lines.length === 1, r.lines.join(' / '));
}

{
  // 文節の途中で切らない（「お前顔映ってもい / いな」を作らない）
  const text = 'お前顔映ってもいいなこれめちゃくちゃかたくて';
  const r = wrap.wrapJapaneseByWidth((t) => measure(t, 10), text, 120);
  check('文節の途中では切らない', r.forcedBreaks === 0, r.lines.join(' / '));
  check('本文が落ちない', r.lines.join('') === text, r.lines.join(''));
}

{
  /*
    行の長さを揃える。

    前から詰めるだけだと「このやり方がいちばん早いと / 思います」になる。
    収まってはいるが、2行目が4文字しかなく、テロップとしては手で直したくなる。
    文節: この / やり方が / いちばん早いと / 思います
  */
  const text = 'このやり方がいちばん早いと思います';
  const maxWidth = 130; // 全角13文字ぶん
  const r = wrap.wrapJapaneseByWidth((t) => measure(t, 10), text, maxWidth);
  const widths = r.lines.map((l) => measure(l, 10));
  const spread = Math.max(...widths) - Math.min(...widths);
  check('2行に分かれる', r.lines.length === 2, r.lines.join(' / '));
  check(
    '行の長さが揃う（差が幅の半分未満）',
    spread < maxWidth / 2,
    `${r.lines.join(' / ')}（差 ${spread}）`,
  );
  check('本文は変わらない', r.lines.join('') === text, r.lines.join(''));
}

{
  // 句読点のあとを優先する（読点は元々そこで息を継ぐ場所なので、行の変わり目に向く）
  const text = 'そうですね、それはちょっと違います';
  for (const maxWidth of [110, 130]) {
    const r = wrap.wrapJapaneseByWidth((t) => measure(t, 10), text, maxWidth);
    check(
      `句読点のあとで切る（幅 ${maxWidth}）`,
      r.lines[0]?.endsWith('、') === true,
      r.lines.join(' / '),
    );
  }
}

{
  // 手で決めた改行位置がそのまま効く
  const text = '今日はいい天気ですね';
  const breaks = wrap.phraseBoundaries(text);
  check('文節の切れ目が取れる', breaks.length > 0, JSON.stringify(breaks));

  const r = wrap.wrapJapaneseByWidth((t) => measure(t, 10), text, 1000, [breaks[0]]);
  check('指定した位置で改行する', r.lines.length === 2, r.lines.join(' / '));
  check(
    '指定した位置で切れている',
    r.lines[0].length === breaks[0],
    `${r.lines.join(' / ')}（指定 ${breaks[0]}）`,
  );
}

{
  /*
    手で3行にしたいと言われたら3行にする。
    「2行が上限」を守ろうとして縮め続けても、3箇所で切れと言われている以上
    絶対に収まらない。無意味に小さいテロップができるだけになる。
  */
  const text = '今日はいい天気ですね散歩に行きましょう';
  const breaks = wrap.phraseBoundaries(text);
  const chosen = [breaks[0], breaks[Math.min(2, breaks.length - 1)]];
  const r = wrap.fitToLines(at(10), text, 1000, 2, { breaks: chosen });
  check('手で決めた改行は行数の上限より優先する', r.lines.length === 3, r.lines.join(' / '));
  check('そのために縮めたりしない', r.fontScale === 1, String(r.fontScale));
}

// ── 文字の大きさを変えたら折り返しも変わる ────────────────────

{
  /*
    「この1枚の大きさ」を変えたら、折り返しも計算し直す。
    描画は 雛形 × 縮小率 × この1枚の倍率 で決まるのに、
    折り返しだけ倍率を見ていないと、縮めたのに2行のままになる。

    縦 1080 幅・余白 8% → 使える幅は 907px。通常スタイルは 92px。
  */
  const text = 'なるほど、たしかにその通りですね'; // 全角16文字 = 等倍で 1472px（収まらない）
  const frame = { width: 1080, height: 1920 };
  const m = (t, fontPx) => measure(t, fontPx);
  const fit = (sizeScale) => split.rewrapCard(text, 'normal', m, frame, {}, undefined, { sizeScale });

  const big = fit(1);
  const small = fit(0.6);
  const huge = fit(1.8);

  check('等倍では2行', big.lines.length === 2, big.lines.join(' / '));
  check('等倍では余計に縮めない', big.fontScale === 1, String(big.fontScale));
  check(
    '小さくすると改行が減る',
    small.lines.length === 1,
    `等倍 ${big.lines.length}行 / 0.6倍 ${small.lines.length}行（${small.lines.join(' / ')}）`,
  );
  check(
    '大きくすると1行に入る文字数が減る',
    huge.lines[0].length < big.lines[0].length,
    `等倍「${big.lines[0]}」/ 1.8倍「${huge.lines[0]}」`,
  );
}

// ── 表示時刻の重なり ────────────────────────────────────────

const card = (id, srcStart, srcEnd) => ({
  id,
  unitId: id,
  srcStart,
  srcEnd,
  text: id,
  lines: [id],
  style: 'normal',
  reason: '',
  needsCheck: false,
  confidence: 1,
  lowWords: 0,
  fontScale: 1,
  offsetX: 0,
  offsetY: 0,
});

{
  // 重なっていないものは触らない
  const out = split.resolveOverlaps([card('a', 0, 2), card('b', 3, 5)]);
  check(
    '重なっていなければそのまま',
    out[0].srcEnd === 2 && out[1].srcStart === 3,
    JSON.stringify(out.map((c) => [c.srcStart, c.srcEnd])),
  );
}

{
  /*
    ここが本題。
    次のテロップの開始時刻は「その言葉が発せられた時刻」なので動かしてはいけない。
    前のテロップを切り上げて、次を定刻に出す。
  */
  const out = split.resolveOverlaps([card('a', 10, 13), card('b', 12, 14)]);
  check('次の開始時刻は動かさない', out[1].srcStart === 12, String(out[1].srcStart));
  check('前を切り上げる', out[0].srcEnd === 12, String(out[0].srcEnd));
}

{
  // 切り上げると一瞬になってしまう場合だけ、次を少し待たせる
  const out = split.resolveOverlaps([card('a', 10, 13), card('b', 10.05, 14)]);
  check(
    '前が一瞬になるときだけ次を待たせる',
    out[0].srcEnd === 10.25 && out[1].srcStart === 10.25,
    JSON.stringify(out.map((c) => [c.srcStart, c.srcEnd])),
  );
  check('待たせる量は最小限（0.25秒）', out[1].srcStart - 10.05 <= 0.2 + 1e-9, String(out[1].srcStart));
}

{
  // 3枚以上でも、玉突きで後ろが押し出されない
  const out = split.resolveOverlaps([card('a', 0, 9), card('b', 2, 9), card('c', 4, 9)]);
  check(
    '3枚以上でも開始時刻は動かない',
    out[0].srcStart === 0 && out[1].srcStart === 2 && out[2].srcStart === 4,
    JSON.stringify(out.map((c) => [c.srcStart, c.srcEnd])),
  );
  check(
    '前から順に切り上がる',
    out[0].srcEnd === 2 && out[1].srcEnd === 4 && out[2].srcEnd === 9,
    JSON.stringify(out.map((c) => [c.srcStart, c.srcEnd])),
  );
}

{
  // 並び順が入れ替わっていても直せる
  const out = split.resolveOverlaps([card('b', 12, 14), card('a', 10, 13)]);
  check('時刻順に並べ直す', out.map((c) => c.id).join(',') === 'a,b', out.map((c) => c.id).join(','));
  check('1枚も落とさない', out.length === 2, String(out.length));
}

{
  // 元の配列を書き換えない（元に戻す操作が壊れる）
  const original = [card('a', 10, 13), card('b', 12, 14)];
  split.resolveOverlaps(original);
  check('渡された配列は書き換えない', original[0].srcEnd === 13, String(original[0].srcEnd));
}

console.log('');
if (failed > 0) {
  console.log(`❌ ${failed} 件が期待どおりではありません`);
  process.exit(1);
}
console.log('✅ 改行と表示時刻、すべて問題なし');
