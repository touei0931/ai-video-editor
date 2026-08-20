/**
 * 下書きの索引の検証。
 *
 * 索引が壊れると「保存したのに一覧に出ない」「消したのに残る」という
 * 気づきにくい壊れ方をする。しかも下書きは**再現に解析が必要**なので、
 * 手で試すのが一番やりにくい部分でもある。ここだけは自動で確かめる。
 *
 * 実行: node scripts/test-drafts.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const outDir = mkdtempSync(join(tmpdir(), 'drafts-test-'));

// drafts.ts をそのままは読めないので、tsc で1ファイルだけ JS にする。
// 🔴 npx ではなく node から直接呼ぶ。Windows では npx.cmd を execFile できない。
execFileSync(
  process.execPath,
  [
    join(root, 'node_modules/typescript/bin/tsc'),
    join(root, 'electron/main/drafts.ts'),
    '--outDir',
    outDir,
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

const drafts = await import(pathToFileURL(join(outDir, 'drafts.js')).href);

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`[drafts] ${ok ? 'OK  ' : 'NG  '} ${name}`);
  if (!ok) console.log(`        期待: ${JSON.stringify(expected)}\n        実際: ${JSON.stringify(actual)}`);
}

const sandbox = mkdtempSync(join(tmpdir(), 'drafts-sandbox-'));
const indexPath = join(sandbox, 'config', 'drafts.json');

/** 作業フォルダらしきものを1つ作る */
function makeWork(name, withVideo = true) {
  const videoPath = join(sandbox, `${name}.mp4`);
  const workDir = join(sandbox, '.ai-video-editor', `${name}-abcd1234`);
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(workDir, 'project.json'), '{}', 'utf8');
  if (withVideo) writeFileSync(videoPath, 'x', 'utf8');
  return { videoPath, workDir };
}

const entry = (w, savedAt, extra = {}) => ({
  videoPath: w.videoPath,
  workDir: w.workDir,
  savedAt,
  phase: 'review',
  decided: 3,
  total: 10,
  duration: 60,
  ...extra,
});

// 索引がまだ無い状態で読んでも落ちない（初回起動）
check('索引が無ければ空', drafts.listDrafts(indexPath), []);

const a = makeWork('a');
const b = makeWork('b');
drafts.rememberDraft(indexPath, entry(a, '2026-08-20T01:00:00.000Z'));
drafts.rememberDraft(indexPath, entry(b, '2026-08-20T02:00:00.000Z'));

check(
  '2件が新しい順に並ぶ',
  drafts.listDrafts(indexPath).map((d) => d.videoName),
  ['b.mp4', 'a.mp4'],
);

// 同じ動画をもう一度保存しても増えない（上書き）
drafts.rememberDraft(indexPath, entry(a, '2026-08-20T03:00:00.000Z', { decided: 9 }));
const afterUpdate = drafts.listDrafts(indexPath);
check('同じ作業フォルダは増えず上書き', afterUpdate.length, 2);
check('上書きした側が先頭', afterUpdate[0].videoName, 'a.mp4');
check('中身も更新される', afterUpdate[0].decided, 9);

// 動画だけ移動された場合。判定は無事なので索引からは外さず、印だけ付ける
const moved = makeWork('moved');
rmSync(moved.videoPath);
drafts.rememberDraft(indexPath, entry(moved, '2026-08-20T04:00:00.000Z'));
const withMissing = drafts.listDrafts(indexPath);
check('動画が無くても一覧には残る', withMissing.length, 3);
check('動画が無いことが分かる', withMissing[0].videoMissing, true);
check('動画があるものは印が付かない', withMissing[1].videoMissing, false);

// 作業フォルダごと消えた場合は索引から外す（開けないので並べても無駄）
rmSync(b.workDir, { recursive: true, force: true });
check(
  '作業フォルダが無いものは消える',
  drafts.listDrafts(indexPath).map((d) => d.videoName),
  ['moved.mp4', 'a.mp4'],
);
check('索引そのものからも消えている', drafts.readDrafts(indexPath).length, 2);

// 明示的な削除
drafts.forgetDraft(indexPath, a.workDir);
check(
  '削除した分が消える',
  drafts.listDrafts(indexPath).map((d) => d.videoName),
  ['moved.mp4'],
);

// 壊れた索引を読んでも落ちない
writeFileSync(indexPath, '{壊れた', 'utf8');
check('壊れた索引は空として扱う', drafts.listDrafts(indexPath), []);

// 🔴 削除対象のパス確認。ここが緩いと関係ないフォルダを消しうる
check('作業フォルダと認める', drafts.isWorkDir('D:/picture/.ai-video-editor/a-1234'), true);
check('区切り違いも認める', drafts.isWorkDir('D:\\picture\\.ai-video-editor\\a-1234'), true);
check('ただのフォルダは認めない', drafts.isWorkDir('D:/picture'), false);
check('似た名前でも認めない', drafts.isWorkDir('D:/ai-video-editor-backup'), false);
check('空は認めない', drafts.isWorkDir(''), false);

// 素材ごとに分ける前の置き場所。消してよいが、フォルダごとではいけない
check('古い置き場所も下書きとしては認める', drafts.isWorkDir('D:/picture/.ai-video-editor'), true);
check('古い置き場所だと分かる', drafts.isSharedWorkDir('D:/picture/.ai-video-editor'), true);
check(
  '末尾の区切りがあっても分かる',
  drafts.isSharedWorkDir('D:\\picture\\.ai-video-editor\\'),
  true,
);
check(
  '素材ごとの作業フォルダは古い置き場所ではない',
  drafts.isSharedWorkDir('D:/picture/.ai-video-editor/a-1234'),
  false,
);
check('関係ないフォルダは古い置き場所でもない', drafts.isSharedWorkDir('D:/picture'), false);

rmSync(sandbox, { recursive: true, force: true });
rmSync(outDir, { recursive: true, force: true });

console.log(failed === 0 ? '\ntest-drafts: OK' : `\ntest-drafts: ${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
