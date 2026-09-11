/**
 * 話者ごとの色（src/telop/speakers.ts）の検査。
 *
 * 🔴 守っていること:
 *   - 色は雛形の枠（slot-spk-<id>）として持つ。上書きで塗ると、
 *     タイムラインに送った瞬間に消える
 *   - 見分け直しても、人が「この声は◯◯」と決めたものは動かさない
 *   - 当たらなくなったテロップは、自動で付いた人の枠なら通常へ戻す
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
const style = await import(pathToFileURL(join(outDir, 'style.js')).href);

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

// ── 枠 ──
{
  const base = structuredClone(style.DEFAULT_STYLES);
  const next = S.withSpeakerStyles(base, [fubuki, okayu]);
  const f = next[S.speakerStyleName('f1')];
  check('人ごとの枠ができる', !!f && !!next[S.speakerStyleName('o1')]);
  check('枠の名前は登録した名前', f.label === '白上フブキ', f.label);
  check('文字色は登録した色', f.color === '#7ec8ff', f.color);
  check('土台は通常（書体・大きさ・位置が同じ）',
    f.fontFamily === base.normal.fontFamily && f.fontSizeRatio === base.normal.fontSizeRatio && f.position === base.normal.position);
  check('縁取りの色は登録に無ければ通常のまま', f.stroke.color === base.normal.stroke.color);
  check('縁取りの色を登録していれば使う', next[S.speakerStyleName('o1')].stroke.color === '#221133');
  check('変わらなければ同じものを返す（描き直しを起こさない）', S.withSpeakerStyles(next, [fubuki, okayu]) === next);
  const renamed = S.withSpeakerStyles(next, [{ ...fubuki, name: 'フブキ', color: '#ffffff' }, okayu]);
  check('名前と色を変えると枠も変わる', renamed[S.speakerStyleName('f1')].label === 'フブキ' && renamed[S.speakerStyleName('f1')].color === '#ffffff');
  check('枠の名前から持ち主が分かる', S.speakerOfStyle('slot-spk-f1') === 'f1' && S.speakerOfStyle('normal') === null);
}

// ── 見分けた結果を書き込む ──
{
  const cards = [card('a'), card('b', { style: 'emphasis' }), card('c', { manualSpeaker: true, speaker: 'o1', style: 'slot-spk-o1' }), card('d', { style: 'slot-spk-f1', speaker: 'f1' })];
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
  check('当たったテロップは人の枠になる', by.a.style === 'slot-spk-f1' && by.a.speaker === 'f1');
  check('強調だったものも人の枠になる', by.b.style === 'slot-spk-f1');
  check('人が決めたものは動かさない', by.c.speaker === 'o1' && by.c.style === 'slot-spk-o1');
  check('当たらなくなった自動の枠は通常へ戻す', by.d.style === 'normal' && by.d.speaker === null && by.d.voice === 'v1');
  check('類似度を持つ', by.a.speakerScore === 0.8);
}

// ── 人が決める ──
{
  const cards = [card('a'), card('b'), card('c', { style: 'emphasis' })];
  const out = S.assignSpeaker(cards, ['a', 'c'], 'o1');
  check('決めたものは人の枠 + 手で決めた印', out[0].style === 'slot-spk-o1' && out[0].manualSpeaker === true && out[0].speaker === 'o1');
  check('決めていないものは触らない', out[1].style === 'normal' && out[1].manualSpeaker === undefined);
  const back = S.assignSpeaker(out, ['a'], null);
  check('「誰でもない」に戻すと通常', back[0].style === 'normal' && back[0].speaker === null && back[0].manualSpeaker === true);
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
