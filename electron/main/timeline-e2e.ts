/**
 * 並べたタイムラインの書き出しを、アプリの形のまま通す（`npm run t6`）。
 *
 * 見るのは5点:
 *   1. 素材を読めるか（media:// 経由。ブラウザでは確かめられない）
 *   2. テロップの PNG がディスクに落ちるか
 *   3. サイドカーの export_timeline へ渡って、動画が出来るか
 *   4. 出来た動画の**尺と大きさ**が指定どおりか
 *   5. 出来た動画が**黒くない**か（ここが一番効く。下の注記を読むこと）
 *
 * 🔴 「終了コード0」で満足しないこと。
 *    ffmpeg は入力を1つ取り違えても動いてしまう。
 *    出来たものを ffprobe と黒判定で確かめるところまでが検査。
 */
import { BrowserWindow, ipcMain } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Submission {
  error?: string;
  stack?: string;
  outPath?: string;
  duration?: number;
  /** 絵が出ているはずの時刻 */
  expectBright?: number[];
  /** 黒いはずの時刻（空き） */
  expectDark?: number[];
  settings?: { width: number; height: number; fps: number };
  assets?: { name: string; duration: number; w?: number; h?: number }[];
  clips?: number;
  telops?: number;
  result?: Record<string, unknown>;
}

function findFfmpeg(appRoot: string, name: 'ffmpeg' | 'ffprobe'): string | null {
  for (const file of [`${name}.exe`, name]) {
    const candidate = join(appRoot, 'vendor', 'ffmpeg', file);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** その時刻のコマの明るさ（0〜255）。空きが本当に黒いかを見る */
function brightnessAt(ffmpeg: string, video: string, at: number): number {
  const raw = execFileSync(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-ss', String(at), '-i', video,
     '-frames:v', '1', '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  if (raw.length === 0) return -1;
  let sum = 0;
  for (const v of raw) sum += v;
  return sum / raw.length;
}

export async function runTimelineE2E(appRoot: string, devUrl?: string): Promise<number> {
  const outDir = join(appRoot, 'phase0-artifacts', 't6');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'timeline.mp4');
  // 🔴 前回のものが残っていると、失敗しても「出来ている」ように見える
  rmSync(outPath, { force: true });

  const samples = [
    join(appRoot, 'samples', 'sample_landscape_solo.mp4'),
    join(appRoot, 'samples', 'sample_portrait_solo.mp4'),
  ].filter((p) => existsSync(p));

  if (samples.length === 0) {
    console.error('検証用の素材が見つかりません（samples/）');
    return 1;
  }

  const submission = await new Promise<Submission>((resolve, reject) => {
    ipcMain.handle('timelineE2E:workDir', () => outDir);
    ipcMain.handle('timelineE2E:outPath', () => outPath);
    ipcMain.handle('timelineE2E:samples', () => samples);
    ipcMain.handle('timelineE2E:submit', (_e, payload: Submission) => resolve(payload));

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

    if (devUrl) win.loadURL(`${devUrl}?mode=timeline-e2e`);
    else win.loadFile(join(appRoot, 'dist', 'index.html'), { search: 'mode=timeline-e2e' });

    // 書き出しは実際にエンコードするので、T5 より長めに待つ
    setTimeout(() => reject(new Error('レンダラからの応答がタイムアウトしました')), 180_000);
  });

  if (submission.error) throw new Error(`${submission.error}\n${submission.stack ?? ''}`);

  const problems: string[] = [];
  const facts: Record<string, unknown> = {
    素材: submission.assets,
    クリップ数: submission.clips,
    テロップ数: submission.telops,
    ねらった尺: submission.duration,
    書き出しの結果: submission.result,
  };

  /*
    🔴 長さは必ず要る。0 のまま進むと置き場所が決まらない。
    ⚠️ 画の大きさは**取れないことがある**。
       この検証の窓は画面に出していないので、コマが decode されず
       videoWidth が 0 のままになる。大きさはプロジェクトの初期値を
       決める手掛かりに使うだけなので、ここでは落とさず控えるだけにする。
       「映像があるか」を大きさで判断してはいけない（それで真っ黒な動画が出た）。
  */
  for (const a of submission.assets ?? []) {
    if (!a.duration || a.duration <= 0) problems.push(`${a.name}: 長さを読めていません`);
  }
  facts.大きさが取れた素材 = (submission.assets ?? []).filter((a) => a.w && a.h).length;
  if ((submission.telops ?? 0) === 0) problems.push('テロップが1枚も作られていません');

  if (!existsSync(outPath)) {
    problems.push('動画が出来ていません');
  } else {
    facts.バイト数 = statSync(outPath).size;
    if (statSync(outPath).size < 10_000) problems.push('動画が小さすぎます（中身が無い可能性）');

    const ffprobe = findFfmpeg(appRoot, 'ffprobe');
    const ffmpeg = findFfmpeg(appRoot, 'ffmpeg');

    if (ffprobe) {
      const raw = execFileSync(ffprobe, [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,nb_frames:format=duration',
        '-of', 'default=noprint_wrappers=1', outPath,
      ]).toString();
      facts.できたもの = raw.trim().split('\n');

      const width = Number(/width=(\d+)/.exec(raw)?.[1]);
      const height = Number(/height=(\d+)/.exec(raw)?.[1]);
      const seconds = Number(/duration=([\d.]+)/.exec(raw)?.[1]);
      const want = submission.settings;

      if (want && (width !== want.width || height !== want.height)) {
        problems.push(`大きさが違います（${width}x${height} / ねらい ${want.width}x${want.height}）`);
      }
      /*
        🔴 尺のずれを見逃さないこと。
           繋ぎ目でコマがずれると、後ろへ行くほど音と絵が離れる。
           まず全体の尺で気付ける。
      */
      if (submission.duration && Math.abs(seconds - submission.duration) > 0.2) {
        problems.push(`尺が違います（${seconds} 秒 / ねらい ${submission.duration} 秒）`);
      }

      // 音が入っているか。無音の書き出しは「動いたのに使えない」の典型
      const audio = execFileSync(ffprobe, [
        '-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', outPath,
      ]).toString().trim();
      facts.音 = audio || '（無し）';
      if (!audio) problems.push('音の流れがありません');
    }

    /*
      🔴🔴 中身が黒くないことを必ず見ること。ここが一番効く関門。

         素材が「映像なし」と判定されると、書き出しは音とテロップだけの
         **真っ黒な動画**になる。ffmpeg は成功し、尺も大きさも音も合っているので、
         それ以外の検査は全部通ってしまう。
         実際にこの検査だけが捕まえた（明るさ 9.3 → 直して 131.8）。

         この検証で並べているのは 0〜7秒すべて映像なので、
         どの時点を見ても黒くないはず。
    */
    if (ffmpeg) {
      const measure = (list: number[]) =>
        list.map((t) => ({ 秒: Number(t.toFixed(2)), 明るさ: Number(brightnessAt(ffmpeg, outPath, t).toFixed(1)) }));

      const bright = measure(submission.expectBright ?? []);
      const dark = measure(submission.expectDark ?? []);
      facts.明るさ = { クリップの所: bright, 空きの所: dark };

      if (bright.length === 0) problems.push('絵があるはずの時点が渡されていません');

      for (const m of bright) {
        if (m.明るさ < 0) {
          problems.push(`${m.秒}秒: コマを取り出せません（中身が壊れている可能性）`);
        } else if (m.明るさ < 20) {
          problems.push(
            `${m.秒}秒: クリップがあるのに映像が黒い（明るさ ${m.明るさ}）。` +
              '素材が「映像なし」と判定されていないか確かめること',
          );
        }
      }

      /*
        🔴 逆方向も見ること。
           「黒くない」だけを見ると、空きなのに前のコマが出しっぱなし、という
           繋ぎの不具合を見逃す。空きは黒いのが正しい。
      */
      for (const m of dark) {
        if (m.明るさ > 20) {
          problems.push(`${m.秒}秒: 空きのはずなのに映像が出ています（明るさ ${m.明るさ}）`);
        }
      }
    }
  }

  const report = { ok: problems.length === 0, problems, facts };
  /*
    🔴 結果はファイルにも残すこと。
       CI では標準出力の日本語が文字化けして、判定の行まで届かないことがある
       （T5 で6回以上これに引っかかった）。ファイルなら grep で確かめられる。
  */
  writeFileSync(join(outDir, 't6-result.json'), JSON.stringify(report, null, 2), 'utf-8');
  console.log(JSON.stringify(report, null, 2));
  if (problems.length > 0) {
    console.error(`T6: ${problems.length} 件の問題があります`);
    return 1;
  }
  console.log('T6: OK');
  return 0;
}
