/**
 * テロップ分割の検算（Node で動かす）。
 *
 * Canvas を使わずに済むよう、幅の実測は「全角=1文字ぶん / 半角=0.5」で近似する。
 * ここで見たいのは**分割位置と時刻の対応**であって、描画の正確さではない。
 * 描画そのものの一致は T1 が別途保証している。
 *
 * 使い方:
 *   python scripts/make_telops_json.py     # telops.json を作る
 *   node <bundled>.mjs <telops.json>
 */
import { readFileSync } from 'node:fs';
import { buildCards, type Measure, type TelopUnit } from '../src/telop/split';

const path = process.argv[2];
if (!path) throw new Error('telops.json のパスを渡してください');

const raw = JSON.parse(readFileSync(path, 'utf8')) as {
  telops: {
    id: string;
    src_start: number;
    src_end: number;
    text: string;
    style: TelopUnit['style'];
    reason: string;
    position: TelopUnit['position'];
    needs_check: boolean;
    confidence: number;
    words: { text: string; src_start: number; src_end: number }[];
  }[];
};

const units: TelopUnit[] = raw.telops.map((t) => ({
  id: t.id,
  srcStart: t.src_start,
  srcEnd: t.src_end,
  text: t.text,
  style: t.style,
  reason: t.reason,
  position: t.position,
  needsCheck: t.needs_check,
  confidence: t.confidence,
  words: t.words.map((w) => ({ text: w.text, srcStart: w.src_start, srcEnd: w.src_end })),
}));

// 太字なら少し広い、という程度の近似。ここで見たいのは分割位置と時刻の対応で、
// 描画の正確さは T1 が別途保証している。
const measure: Measure = (text, fontPx, font) => {
  let width = 0;
  for (const ch of text) width += (ch.codePointAt(0)! < 0x3000 ? 0.5 : 1) * fontPx;
  return font.bold ? width * 1.02 : width;
};

const frame = { width: 1920, height: 1080 };
const cards = buildCards(units, measure, frame);

console.log(`文単位 ${units.length} 件 → 画面単位 ${cards.length} 枚\n`);
for (const c of cards) {
  const scale = c.fontScale < 1 ? ` (${Math.round(c.fontScale * 100)}%)` : '';
  console.log(
    `${c.srcStart.toFixed(2).padStart(6)}-${c.srcEnd.toFixed(2).padStart(6)} ` +
      `[${c.style}]${scale} ${c.lines.join(' / ')}`,
  );
}

// ── 検算 ──
const problems: string[] = [];
for (let i = 0; i < cards.length; i++) {
  const c = cards[i];
  if (c.srcEnd <= c.srcStart) problems.push(`${c.id}: 表示時間が0以下`);
  if (c.lines.length === 0) problems.push(`${c.id}: 行が空`);
  if (c.lines.length > 2) problems.push(`${c.id}: ${c.lines.length}行になっている`);
  if (i > 0 && cards[i - 1].srcEnd > c.srcStart) {
    problems.push(`${cards[i - 1].id} と ${c.id} が時間的に重なっている`);
  }
}

// 文字が落ちていないこと（分割で欠落するのが一番怖い）
const fromUnits = units.map((u) => u.words.map((w) => w.text).join('')).join('').replace(/\s/g, '');
const fromCards = cards.map((c) => c.lines.join('')).join('').replace(/\s/g, '');
if (fromUnits !== fromCards) {
  problems.push(`本文が一致しない\n  元: ${fromUnits}\n  後: ${fromCards}`);
}

console.log('');
if (problems.length) {
  console.log('❌ 問題あり');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('✅ 分割・時刻・本文すべて問題なし');
