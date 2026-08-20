/**
 * テロップ書き出し経路の検証（`npm run t5`）。
 *
 * 見るのは4点:
 *   1. レンダラで PNG が作れて、ディスクに落ちるか
 *   2. その PNG に**中身があるか**（透明なだけの画像だと ffmpeg は何も合成しない。
 *      これは実際に踏んだ罠で、エラーにならないので気付けない）
 *   3. 元素材の途中へシークできるか（テロップ確認画面がこれに依存している）
 *   4. その PNG を焼き込んだ動画が書き出せるか
 *
 * 2 は ffmpeg の alphaextract で不透明画素を数えて確かめる。
 */
import { BrowserWindow, ipcMain } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sidecar } from './sidecar.js';

interface Card {
  id: string;
  srcStart: number;
  srcEnd: number;
  lines: string[];
  style: string;
  fontScale: number;
  png: string;
}

interface Submission {
  error?: string;
  stack?: string;
  families?: string[];
  frame?: { width: number; height: number };
  cards?: Card[];
  blankPng?: string;
  seek?: { skipped?: string; error?: string; duration?: number; target?: number; landedAt?: number };
}

function findFfmpeg(appRoot: string): string | null {
  for (const name of ['ffmpeg.exe', 'ffmpeg']) {
    const candidate = join(appRoot, 'vendor', 'ffmpeg', name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 不透明な画素の数。0 なら「描いたつもりで何も描けていない」。 */
function opaquePixels(ffmpeg: string, png: string): number {
  const raw = execFileSync(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-i', png, '-vf', 'alphaextract',
     '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  let count = 0;
  for (const v of raw) if (v > 8) count++;
  return count;
}

export async function runTelopE2E(appRoot: string, devUrl?: string): Promise<number> {
  const outDir = join(appRoot, 'phase0-artifacts', 't5');
  const workDir = join(outDir, 'telops');
  mkdirSync(workDir, { recursive: true });

  const fixture = join(appRoot, 'fixtures-local', 'test_video_ja.mp4');
  // CI には実素材を置かないので、生成した検証用素材で代用する
  const sample = join(appRoot, 'samples', 'sample_landscape_solo.mp4');
  const probeVideo = existsSync(fixture) ? fixture : existsSync(sample) ? sample : '';

  const submission = await new Promise<Submission>((resolve, reject) => {
    ipcMain.handle('telopE2E:workDir', () => workDir);
    ipcMain.handle('telopE2E:mediaProbePath', () => probeVideo);
    ipcMain.handle('telopE2E:submit', (_e, payload: Submission) => resolve(payload));

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

    if (devUrl) win.loadURL(`${devUrl}?mode=telop-e2e`);
    else win.loadFile(join(appRoot, 'dist', 'index.html'), { search: 'mode=telop-e2e' });

    setTimeout(() => reject(new Error('レンダラからの応答がタイムアウトしました')), 60_000);
  });

  if (submission.error) throw new Error(`${submission.error}\n${submission.stack ?? ''}`);

  const cards = submission.cards ?? [];
  const problems: string[] = [];
  const details: Record<string, unknown>[] = [];

  if (cards.length === 0) problems.push('カードが1枚も出来ていません');

  const ffmpeg = findFfmpeg(appRoot);
  for (const card of cards) {
    const entry: Record<string, unknown> = {
      id: card.id,
      lines: card.lines,
      style: card.style,
      fontScale: card.fontScale,
    };

    if (!card.png || !existsSync(card.png)) {
      problems.push(`${card.id}: PNG が保存されていません`);
    } else {
      entry.bytes = statSync(card.png).size;
      if (ffmpeg) {
        const opaque = opaquePixels(ffmpeg, card.png);
        entry.opaquePixels = opaque;
        // 文字が描かれていれば数万画素は不透明になる。
        // 0 に近いなら「透明な板」を焼き込んでいるだけで、映像に何も出ない。
        if (opaque < 500) problems.push(`${card.id}: PNG に中身がありません（不透明画素 ${opaque}）`);
      }
    }
    details.push(entry);
  }

  if (submission.blankPng && ffmpeg && existsSync(submission.blankPng)) {
    const opaque = opaquePixels(ffmpeg, submission.blankPng);
    if (opaque > 0) problems.push(`隙間埋め用の画像が透明ではありません（不透明画素 ${opaque}）`);
  } else if (!submission.blankPng || !existsSync(submission.blankPng ?? '')) {
    problems.push('隙間埋め用の画像が保存されていません');
  }

  // ── 元素材の途中へシークできるか ──
  // できないと、テロップ確認画面（テロップの2.5秒前から再生する）が成立しない。
  const seek = submission.seek;
  if (!seek) {
    problems.push('シークの確認が返ってきていません');
  } else if (seek.error) {
    problems.push(`元素材をシークできません: ${seek.error}`);
  } else if (!seek.skipped) {
    const off = Math.abs((seek.landedAt ?? -1) - (seek.target ?? 0));
    if (off > 0.5) {
      problems.push(`シーク位置がずれています（${seek.target?.toFixed(2)}秒 → ${seek.landedAt?.toFixed(2)}秒）`);
    }
  }

  // ── 実際に焼き込んで書き出せるところまで確認する ──
  let exported: Record<string, unknown> | null = null;
  if (problems.length === 0 && existsSync(fixture)) {
    try {
      exported = (await sidecar.call('export', {
        video_path: fixture,
        out_path: join(outDir, 'burned.mp4'),
        work_dir: outDir,
        duration: 25.63,
        fps: 30,
        cuts: [{ src_start: 3.0, src_end: 5.0 }],
        telops: cards.map((c) => ({ src_start: c.srcStart, src_end: c.srcEnd, png: c.png })),
        blank_png: submission.blankPng,
      })) as Record<string, unknown>;
      if ((exported.telop_count as number) !== cards.length) {
        problems.push(`焼き込まれたテロップが ${exported.telop_count} 枚（期待 ${cards.length} 枚）`);
      }
    } catch (e) {
      problems.push(`書き出しに失敗: ${(e as Error).message}`);
    }
  }

  const ok = problems.length === 0;
  writeFileSync(
    join(outDir, 't5-result.json'),
    JSON.stringify(
      { ok, problems, families: submission.families, seek, cards: details, exported },
      null,
      2,
    ),
    'utf8',
  );

  for (const d of details) {
    console.error(`[t5] ${d.id}: ${(d.lines as string[]).join(' / ')} — ${d.bytes}B 不透明${d.opaquePixels}px`);
  }
  if (seek?.skipped) console.error(`[t5] シーク確認: 省略（${seek.skipped}）`);
  else if (seek) console.error(`[t5] シーク: ${seek.target?.toFixed(2)}秒 → ${seek.landedAt?.toFixed(2)}秒（尺 ${seek.duration?.toFixed(2)}秒）`);
  if (exported) console.error(`[t5] 書き出し: ${exported.encoder} / テロップ ${exported.telop_count} 枚`);
  else if (!existsSync(fixture)) console.error('[t5] 素材が無いので書き出しは省略しました');

  console.error(ok ? '[t5] OK' : `[t5] NG\n  - ${problems.join('\n  - ')}`);
  return ok ? 0 : 1;
}
