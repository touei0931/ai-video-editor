/**
 * T1: テロップ WYSIWYG の成立確認（Phase 0 §16）。
 *
 * 手順:
 *   1. サンプル動画から 1080x1920 のフレームを1枚取り出す
 *   2. 隠しウィンドウで src/telop/render.ts を使ってテロップを描く
 *      - 透過 PNG（書き出し用）
 *      - 背景と合成した PNG（プレビューで見えているもの）
 *   3. ffmpeg で「背景 + 透過PNG」を overlay 合成する
 *   4. 2 と 3 を画素比較する
 *
 * 成功条件: 最大画素差 ≤ 2/255、かつ目視で差が分からないこと。
 */
import { BrowserWindow, ipcMain, nativeImage } from 'electron';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ffmpegPath } from './paths.js';

const WIDTH = 1080;
const HEIGHT = 1920;
const MAX_DIFF_THRESHOLD = 2; // 0-255

export interface CaseResult {
  name: string;
  maxDiff: number;
  meanDiff: number;
  diffPixels: number;
  diffRatio: number;
  pass: boolean;
}

interface Submission {
  results?: { name: string; telop: string; composite: string }[];
  error?: string;
}

function run(cmd: string, args: string[]): { ok: boolean; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { ok: r.status === 0, stderr: r.stderr ?? '' };
}

/** サンプル動画から 9:16 のフレームを1枚取り出す */
function extractFrame(appRoot: string, outDir: string): string {
  const src = join(appRoot, 'samples', 'sample_landscape_solo.mp4');
  const out = join(outDir, 'frame.png');

  const { ok, stderr } = run(ffmpegPath(), [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', '5', '-i', src,
    '-vf', `crop=trunc(ih*9/16/2)*2:ih,scale=${WIDTH}:${HEIGHT},setsar=1`,
    '-frames:v', '1',
    out,
  ]);
  if (!ok) throw new Error(`フレームの取り出しに失敗しました: ${stderr.slice(-500)}`);
  return out;
}

/** ffmpeg で背景に透過PNGを焼き込む（書き出し時と同じ経路） */
function overlayWithFfmpeg(framePath: string, telopPath: string, outPath: string): void {
  const { ok, stderr } = run(ffmpegPath(), [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', framePath,
    '-i', telopPath,
    '-filter_complex', '[0][1]overlay=0:0:format=auto',
    '-frames:v', '1',
    outPath,
  ]);
  if (!ok) throw new Error(`overlay に失敗しました: ${stderr.slice(-500)}`);
}

/**
 * 2枚の PNG を画素比較する。
 * 差分画像も出す（10倍に増幅。どこがズレているか目で見て分かるように）。
 */
function comparePng(
  aPath: string,
  bPath: string,
  diffOutPath: string,
): Omit<CaseResult, 'name' | 'pass'> {
  const a = nativeImage.createFromPath(aPath);
  const b = nativeImage.createFromPath(bPath);

  const sizeA = a.getSize();
  const sizeB = b.getSize();
  if (sizeA.width !== sizeB.width || sizeA.height !== sizeB.height) {
    throw new Error(
      `画像サイズが違います: ${sizeA.width}x${sizeA.height} vs ${sizeB.width}x${sizeB.height}`,
    );
  }

  // Electron 43 の型定義では戻り値が void になっているが、実際には BGRA の Buffer を返す
  // （上流の型宣言のバグ）。getBitmap() は非推奨なので toBitmap() を使う。
  const bufA = a.toBitmap() as unknown as Buffer;
  const bufB = b.toBitmap() as unknown as Buffer;
  const pixels = sizeA.width * sizeA.height;
  const diffBuf = Buffer.alloc(bufA.length, 0);

  let maxDiff = 0;
  let sumDiff = 0;
  let diffPixels = 0;

  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    // アルファは比較しない（どちらも不透明）。色差の最大値をその画素の差とする。
    const d0 = Math.abs(bufA[o] - bufB[o]);
    const d1 = Math.abs(bufA[o + 1] - bufB[o + 1]);
    const d2 = Math.abs(bufA[o + 2] - bufB[o + 2]);
    const d = Math.max(d0, d1, d2);

    if (d > maxDiff) maxDiff = d;
    sumDiff += d;
    if (d > 0) diffPixels++;

    const amplified = Math.min(255, d * 10);
    diffBuf[o] = amplified;
    diffBuf[o + 1] = amplified;
    diffBuf[o + 2] = amplified;
    diffBuf[o + 3] = 255;
  }

  const diffImage = nativeImage.createFromBitmap(diffBuf, {
    width: sizeA.width,
    height: sizeA.height,
  });
  writeFileSync(diffOutPath, diffImage.toPNG());

  return {
    maxDiff,
    meanDiff: Number((sumDiff / pixels).toFixed(4)),
    diffPixels,
    diffRatio: Number((diffPixels / pixels).toFixed(6)),
  };
}

export async function runT1(appRoot: string, devUrl?: string): Promise<number> {
  const outDir = join(appRoot, 'phase0-artifacts', 't1');
  mkdirSync(outDir, { recursive: true });

  const framePath = extractFrame(appRoot, outDir);
  const frameBase64 = readFileSync(framePath).toString('base64');

  const submission = await new Promise<Submission>((resolve, reject) => {
    ipcMain.handle('t1:frame', () => frameBase64);
    ipcMain.handle('t1:submit', (_e, payload: Submission) => {
      resolve(payload);
    });

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

    // Canvas のサイズはウィンドウサイズと無関係なので、ウィンドウは小さくてよい
    if (devUrl) win.loadURL(`${devUrl}?mode=t1`);
    else win.loadFile(join(appRoot, 'dist', 'index.html'), { search: 'mode=t1' });

    setTimeout(() => reject(new Error('レンダラからの応答がタイムアウトしました')), 60_000);
  });

  if (submission.error || !submission.results) {
    throw new Error(submission.error ?? 'レンダラから結果が返りませんでした');
  }

  const cases: CaseResult[] = [];

  for (const r of submission.results) {
    const telopPath = join(outDir, `${r.name}-telop.png`);
    const browserPath = join(outDir, `${r.name}-browser.png`);
    const ffmpegPathOut = join(outDir, `${r.name}-ffmpeg.png`);
    const diffPath = join(outDir, `${r.name}-diff.png`);

    writeFileSync(telopPath, Buffer.from(r.telop, 'base64'));
    writeFileSync(browserPath, Buffer.from(r.composite, 'base64'));

    overlayWithFfmpeg(framePath, telopPath, ffmpegPathOut);
    const metrics = comparePng(browserPath, ffmpegPathOut, diffPath);

    cases.push({
      name: r.name,
      ...metrics,
      pass: metrics.maxDiff <= MAX_DIFF_THRESHOLD,
    });
  }

  const allPass = cases.every((c) => c.pass);
  const report = {
    ok: allPass,
    threshold: MAX_DIFF_THRESHOLD,
    note: 'ブラウザ上の合成結果 と ffmpeg overlay の結果 を画素比較したもの',
    cases,
  };

  writeFileSync(
    join(outDir, 't1-result.json'),
    JSON.stringify(report, null, 2),
    'utf8',
  );

  for (const c of cases) {
    console.error(
      `[t1] ${c.name}: max=${c.maxDiff} mean=${c.meanDiff} ` +
        `差分画素=${c.diffPixels}(${(c.diffRatio * 100).toFixed(4)}%) ${c.pass ? 'OK' : 'NG'}`,
    );
  }

  return allPass ? 0 : 1;
}
