/**
 * T2: BudouX 文節改行の検証（Phase 0 §16）。
 *
 * 成功条件: 文節途中で切れる率 ≤ 10%。
 * ライセンス（Apache-2.0 / MIT）は package.json で確認済み。
 */
import { BrowserWindow, ipcMain } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FORCED_RATIO_THRESHOLD = 0.1;

interface Submission {
  error?: string;
  maxChars?: number;
  totalBreaks?: number;
  forcedBreaks?: number;
  forcedRatio?: number;
  cases?: unknown[];
}

export async function runT2(appRoot: string, devUrl?: string): Promise<number> {
  const outDir = join(appRoot, 'phase0-artifacts', 't2');
  mkdirSync(outDir, { recursive: true });

  const submission = await new Promise<Submission>((resolve, reject) => {
    ipcMain.handle('t2:submit', (_e, payload: Submission) => resolve(payload));

    const win = new BrowserWindow({
      width: 640,
      height: 480,
      show: false,
      webPreferences: {
        preload: join(appRoot, 'dist-electron', 'preload', 'index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    if (devUrl) win.loadURL(`${devUrl}?mode=t2`);
    else win.loadFile(join(appRoot, 'dist', 'index.html'), { search: 'mode=t2' });

    setTimeout(() => reject(new Error('レンダラからの応答がタイムアウトしました')), 60_000);
  });

  if (submission.error) throw new Error(submission.error);

  const forcedRatio = submission.forcedRatio ?? 1;
  const ok = forcedRatio <= FORCED_RATIO_THRESHOLD;

  const report = {
    ok,
    threshold: FORCED_RATIO_THRESHOLD,
    note: '文節途中で切れた改行の割合。BudouX の文節境界で折り返せているかを見る',
    ...submission,
  };

  writeFileSync(join(outDir, 't2-result.json'), JSON.stringify(report, null, 2), 'utf8');

  console.error(
    `[t2] 改行 ${submission.totalBreaks} 回中 ${submission.forcedBreaks} 回が文節途中 ` +
      `(${(forcedRatio * 100).toFixed(1)}%) ${ok ? 'OK' : 'NG'}`,
  );

  return ok ? 0 : 1;
}
