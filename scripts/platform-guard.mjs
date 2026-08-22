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

/**
 * ここだけがプラットフォーム差を知ってよい（§10.4）。
 * アプリのランタイムコードが対象。ここが4ファイルに収まっている限り、
 * 「Macで壊れうる範囲」は予測可能に保たれる。
 */
const RUNTIME_ALLOWLIST = [
  'electron/main/paths.ts',
  'sidecar/asr/__init__.py',
  'sidecar/face/__init__.py',
  'sidecar/ffmpeg/platform_args.py',
];

/**
 * ビルド・開発用ツールは対象外。
 * 配布物に含まれず、実行するのは開発者かCIなので、§10.4 の趣旨（実機で壊れる範囲の限定）に関わらない。
 * ただし「気づいたら増えていた」を防ぐため、暗黙に除外せず明示的に列挙する。
 */
const TOOLING_EXEMPT = [
  'scripts/platform-guard.mjs',
  'scripts/fetch_ffmpeg.py',
  'scripts/verify_ffmpeg.py',
  // ビルド時にしか走らない。electron-builder が全対象OS分を呼ぶので、
  // darwin のときだけ署名する、という分岐がどうしても要る。アプリの動作には入らない。
  'packaging/adhoc-sign.cjs',
];

const ALLOWLIST = [...RUNTIME_ALLOWLIST, ...TOOLING_EXEMPT];

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-electron', 'out', 'release',
  'docs', 'samples', '.venv', 'venv', '__pycache__', 'models', 'vendor',
  // PyInstaller の出力。サードパーティのコードが丸ごと入るので走査対象外
  'dist-sidecar', 'build-sidecar',
  // 実素材を置く場所（.gitignore 済み）
  'fixtures-local', 'phase0-artifacts',
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
${RUNTIME_ALLOWLIST.map((f) => '  - ' + f).join('\n')}

理由: 開発者は Mac を所持しておらず実機デバッグができないため、
      「Macで壊れうる範囲」を予測可能に保つことがプロジェクトの前提条件です。
`);
process.exit(1);
