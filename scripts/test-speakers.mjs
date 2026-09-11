/**
 * 話者ごとの色（src/telop/speakers.ts）の検査。
 *
 * 🔴 守っていること:
 *   - 色は1枚ごとの上書き（override.color）。雛形（通常／強調）は触らない。
 *     強調した話し方のときは強調の雛形のまま、その人の色で出る
 *   - 見分け直しても、人が「この声は◯◯」と決めたものは動かさない
 *   - 当たらなくなったテロップは、自動で付いた人の色なら外す（大きさなど他の上書きは残す）
 *
 * 実行: node scripts/test-speakers.mjs
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const outDir = mkdtempSync(join(tmpdir(), 'speakers-test-'));

execFileSync(
  process.execPath,
  [
    join(root, 'node_modules/typescript/bin/tsc'),
    join(root, 'src/telop/speakers.ts'),
    '--outDir', outDir, '--rootDir', join(root, 'src/telop'),
    '--module', 'esnext', '--target', 'es2022', '--moduleResolution', 'bundler',
    '--ignoreConfig', '--noCheck',
  ],
  { cwd: root, stdio: 'inherit' },
);
for (const name of readdirSync(outDir)) {
  if (!name.endsWith('.js')) continue;
  const path = join(outDir, name);
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replace(/(from\s+'\.\/[^']+)'/g, (m, head) => (head.endsWith('.js') ? m : `${head}.js'`)),
    'utf8',
  );
}
const S = await import(pathToFileURL(join(outDir, 'speakers.js')).href);

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`[speakers] ${ok ? 'OK  ' : 'NG  '} ${name}`);
  if (!ok && detail !== undefined) console.log(`           ${detail}`);
}

const card = (id, extra = {}) => ({
  id, unitId: id, srcStart: 0, srcEnd: 1, text: id, lines: [id], style: 'normal',
  reason: '', needsCheck: false, confidence: 1, lowWords: 0, fontScale: 1, offsetX: 0, offsetY: 0, ...extra,
});
const fubuki = { id: 'f1', name: '白上フブキ', color: '#7ec8ff', samples: 3 };
const okayu = { id: 'o1', name: '猫又おかゆ', color: '#c59bff', strokeColor: '#221133', samples: 2 };

// ── 色の上書き ──
{
  const o = S.withSpeakerColor(undefined, fubuki);
  check('文字色は登録した色', o.color === '#7ec8ff', JSON.stringify(o));
  check('縁取りの色は登録に無ければ持たない', o.strokeColor === undefined, JSON.stringify(o));
  const o2 = S.withSpeakerColor({ sizeScale: 1.3 }, okayu);
  check('大きさなど色以外の上書きは残す', o2.sizeScale === 1.3 && o2.color === '#c59bff', JSON.stringify(o2));
  check('縁取りの色を登録していれば使う', o2.strokeColor === '#221133', JSON.stringify(o2));
  check('色を外すと色以外だけ残る', JSON.stringify(S.withoutSpeakerColor(o2)) === JSON.stringify({ sizeScale: 1.3 }));
  check('色しか無ければ上書きごと消える', S.withoutSpeakerColor(o) === undefined);
}

// ── 見分けた結果を書き込む ──
{
  const cards = [
    card('a'),
    card('b', { style: 'emphasis' }),
    card('c', { manualSpeaker: true, speaker: 'o1', override: { color: '#c59bff', strokeColor: '#221133' } }),
    card('d', { speaker: 'f1', override: { color: '#7ec8ff', sizeScale: 1.2 } }),
  ];
  const result = {
    units: [
      { id: 'a', speaker: 'f1', score: 0.8, voice: null },
      { id: 'b', speaker: 'f1', score: 0.7, voice: null },
      { id: 'c', speaker: 'f1', score: 0.9, voice: null },
      { id: 'd', speaker: null, score: 0.3, voice: 'v1' },
    ],
    voices: [], speakers: [fubuki, okayu], matched: 3, unknown: 1, tooShort: 0,
  };
  const out = S.applyIdentification(cards, result, [fubuki, okayu]);
  const by = Object.fromEntries(out.map((c) => [c.id, c]));
  check('当たったテロップは人の色になる', by.a.override.color === '#7ec8ff' && by.a.speaker === 'f1');
  check('🔴 雛形は触らない（強調のまま、その人の色）', by.b.style === 'emphasis' && by.b.override.color === '#7ec8ff', JSON.stringify(by.b));
  check('人が決めたものは動かさない', by.c.speaker === 'o1' && by.c.override.color === '#c59bff');
  check('当たらなくなった自動の色は外す（大きさは残す）',
    by.d.speaker === null && by.d.voice === 'v1' && by.d.override.color === undefined && by.d.override.sizeScale === 1.2,
    JSON.stringify(by.d));
  check('類似度を持つ', by.a.speakerScore === 0.8);
}

// ── 人が決める ──
{
  const cards = [card('a'), card('b'), card('c', { style: 'emphasis' })];
  const out = S.assignSpeaker(cards, ['a', 'c'], okayu);
  check('決めたものは人の色 + 手で決めた印', out[0].override.color === '#c59bff' && out[0].manualSpeaker === true && out[0].speaker === 'o1');
  check('雛形はそのまま', out[2].style === 'emphasis' && out[2].override.color === '#c59bff');
  check('決めていないものは触らない', out[1].override === undefined && out[1].manualSpeaker === undefined);
  const back = S.assignSpeaker(out, ['a'], null);
  check('「誰でもない」に戻すと色が外れる', back[0].override === undefined && back[0].speaker === null && back[0].manualSpeaker === true);
}

// ── 登録の色が変わったら塗り直す／消えた人は外す ──
{
  const cards = [card('a', { speaker: 'f1', override: { color: '#7ec8ff' } }), card('b', { speaker: 'o1', manualSpeaker: true, override: { color: '#c59bff', strokeColor: '#221133' } }), card('c')];
  const out = S.recolor(cards, [{ ...fubuki, color: '#ffffff' }]);
  check('色を変えた人のテロップは塗り直る', out[0].override.color === '#ffffff');
  check('消えた人のテロップは色が外れ、自動の判定に戻る', out[1].speaker === null && out[1].override === undefined && out[1].manualSpeaker === false);
  check('無関係なものは触らない', out[2] === cards[2]);
  check('変わらなければ同じ配列を返す', S.recolor(out, [{ ...fubuki, color: '#ffffff' }]) === out);
}

// ── 画面に出す声 ──
{
  const voices = [
    { id: 'v1', count: 12, seconds: 20, sample: null, unitIds: [] },
    { id: 'v2', count: 1, seconds: 2.4, sample: null, unitIds: [] },
    { id: 'v3', count: 1, seconds: 0.7, sample: null, unitIds: [] },
    { id: 'v4', count: 1, seconds: 0.9, sample: null, unitIds: [] },
  ];
  const { shown, others } = S.visibleVoices(voices);
  check('2枚以上か 1.5秒以上の声だけ並べる', shown.map((v) => v.id).join(',') === 'v1,v2', shown.map((v) => v.id).join(','));
  check('残りは枚数だけ', others === 2, String(others));
}

console.log('');
if (failed > 0) {
  console.log(`❌ ${failed} 件が期待どおりではありません`);
  process.exit(1);
}
console.log('✅ 話者ごとの色、すべて問題なし');
