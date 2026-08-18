#!/usr/bin/env node
/**
 * platform-guard — プラットフォーム分岐が指定ファイル以外に漏れていないか検査する。
 *
 * 設計レポート §10.4「プラットフォーム差を4ファイルに閉じ込める」の機械的な担保。
 * Mac 実機でデバッグできない体制のため、「Macで壊れる範囲が予測可能」であることが
 * このプロジェクトの生命線になる。違反を見つけたら exit 1。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** ここだけがプラットフォーム差を知ってよい（§10.4） */
const ALLOWLIST = [
  'electron/main/paths.ts',
  'sidecar/asr/__init__.py',
  'sidecar/face/__init__.py',
  'sidecar/ffmpeg/platform_args.py',
  // 検査スクリプト自身とCI定義は対象外
  'scripts/platform-guard.mjs',
];

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-electron', 'out', 'release',
  'docs', 'samples', '.venv', 'venv', '__pycache__', 'models', 'vendor',
]);

const TARGET_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py'];

/** プラットフォーム分岐とみなすパターン */
const PATTERNS = [
  { re: /\bdarwin\b/, label: 'darwin' },
  { re: /\bwin32\b/, label: 'win32' },
  { re: /process\.platform/, label: 'process.platform' },
  { re: /sys\.platform/, label: 'sys.platform' },
  { re: /platform\.system\s*\(/, label: 'platform.system()' },
];

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (TARGET_EXT.some((e) => name.endsWith(e))) acc.push(full);
  }
  return acc;
}

const violations = [];

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).split(sep).join('/');
  if (ALLOWLIST.includes(rel)) continue;

  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const { re, label } of PATTERNS) {
      if (re.test(line)) {
        violations.push({ file: rel, line: i + 1, label, text: line.trim() });
        break;
      }
    }
  });
}

if (violations.length === 0) {
  console.log('platform-guard: OK — プラットフォーム分岐は許可された4ファイルに閉じ込められています');
  process.exit(0);
}

console.error('platform-guard: 違反を検出しました（§10.4）\n');
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  [${v.label}]  ${v.text}`);
}
console.error(`
プラットフォーム差は以下のファイルにのみ書いてください:
${ALLOWLIST.filter((f) => !f.startsWith('scripts/')).map((f) => '  - ' + f).join('\n')}

理由: 開発者は Mac を所持しておらず実機デバッグができないため、
      「Macで壊れうる範囲」を予測可能に保つことがプロジェクトの前提条件です。
`);
process.exit(1);
