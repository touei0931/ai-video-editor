import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron';
import { basename, dirname, extname, join } from 'node:path';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  forgetDraft,
  isSharedWorkDir,
  isWorkDir,
  listDrafts,
  rememberDraft,
  type DraftEntry,
} from './drafts.js';
import { Readable } from 'node:stream';
import { sidecar } from './sidecar.js';
import { isDev, logDir, needsAppMenu } from './paths.js';
import { runT1 } from './t1.js';
import { runT2 } from './t2.js';
import { runT4 } from './t4.js';
import { runTelopE2E } from './telop-e2e.js';
import { buildMenu, type MenuContext } from './menu.js';

// バンドル後は import.meta.url が当てにならないので、基準は必ず app.getAppPath() を使う
// （パッケージ後は app.asar のルートを指すので、配布時も同じ相対関係で解決できる）
const appRoot = () => app.getAppPath();

/**
 * Windows では Electron の stdout/stderr が親コンソールに繋がらないことがあるため、
 * 診断情報はファイルに残す（CI ではアーティファクトとして回収する）。
 */
function writeArtifact(name: string, data: Record<string, unknown>): void {
  try {
    // 🔴 置き場所は paths.ts の logDir() に任せる（理由はそちらのコメント）。
    //    ここで app.getAppPath() を使うと、配布時に app.asar の中へ書こうとして
    //    黙って失敗し、不具合の記録が一切残らない。
    const dir = logDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('診断ファイルを書けませんでした:', e);
  }
}

/**
 * 画面の段階に応じてメニューを組み直す。
 * 今の画面で意味を持たない項目を有効にしておくと、押しても何も起きず混乱する。
 */
let menuContext: MenuContext = { phase: 'idle' };

/** 編集の途中か。窓を閉じるときに確認を出すかの判断に使う。 */
let editingInProgress = false;

const EDITING_PHASES = new Set([
  'review',
  'telops-building',
  'telop',
  'framing',
  'fullpreview',
  'exporting',
]);

ipcMain.on('app:context', (e, ctx: MenuContext) => {
  menuContext = { ...ctx, isDev, logDir: logDir(), appMenu: needsAppMenu() };
  editingInProgress = EDITING_PHASES.has(ctx.phase);
  buildMenu(BrowserWindow.fromWebContents(e.sender), menuContext);
});

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: '#101014',
    webPreferences: {
      preload: join(appRoot(), 'dist-electron', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(join(appRoot(), 'dist', 'index.html'));

  /*
    🔴 編集中に窓を閉じたら必ず確認する。
       以前は window-all-closed で即 app.quit() していた。
       テロップを100枚校正したあとに×を押せば、無警告で全部消える。
       しかも自動保存も効いていなかったので、本人には理由が分からない消え方になる。
  */
  let closing = false;
  win.on('close', (e) => {
    if (closing || !editingInProgress) return;
    e.preventDefault();
    void dialog
      .showMessageBox(win, {
        type: 'question',
        buttons: ['下書きを保存して閉じる', '保存せずに閉じる', 'キャンセル'],
        defaultId: 0,
        cancelId: 2,
        message: '編集の途中です。閉じますか？',
        detail:
          '下書きを保存しておくと、次に同じ動画を開いたときに続きから始められます。\n' +
          '解析はやり直さずに済みます。',
      })
      .then(async (result) => {
        if (result.response === 2) return;
        if (result.response === 0) {
          // レンダラに保存させてから閉じる。何を保存すべきかは画面側が知っている。
          win.webContents.send('app:menu', 'save');
          await new Promise((r) => setTimeout(r, 900));
        }
        closing = true;
        win.close();
      });
  });

  buildMenu(win, menuContext);
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}

ipcMain.handle('sidecar:call', (_e, method: string, params: Record<string, unknown>) =>
  sidecar.call(method, params),
);

// ── アプリの操作（①カットの一連の流れ）──────────────────────

ipcMain.handle('app:pickVideo', async () => {
  const result = await dialog.showOpenDialog({
    title: '編集する動画を選ぶ',
    properties: ['openFile'],
    filters: [{ name: '動画', extensions: ['mp4', 'mov', 'mkv', 'm4v', 'avi', 'webm'] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('app:pickOutput', async (_e, defaultPath: string) => {
  const result = await dialog.showSaveDialog({
    title: '書き出し先',
    defaultPath,
    filters: [{ name: 'MP4', extensions: ['mp4'] }],
  });
  return result.canceled ? null : result.filePath;
});

/** 進捗はレンダラへ素通しする。解析中に画面が固まらないことが体験の要（§8.6） */
function forwardProgress(win: BrowserWindow | null) {
  return sidecar.onProgress((p) => {
    if (win && !win.isDestroyed()) win.webContents.send('app:progress', p);
  });
}

/**
 * 実行中の重い処理。取り消しのために覚えておく。
 *
 * 🔴 中断できないと、間違ったファイルを選んだ時点で
 *    解析が終わるまで（20分素材なら十数分）待つか、強制終了するしかない。
 */
let runningRequestId: number | null = null;

async function runCancellable(
  win: BrowserWindow | null,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const off = forwardProgress(win);
  const { id, promise } = sidecar.callWithId(method, params);
  runningRequestId = id;
  try {
    return await promise;
  } catch (error) {
    /*
      🔴 ここで必ず記録すること。

      以前は catch が無く、analyze / redetect / plan_framing の失敗が
      last-error.json に一切残らなかった。recordFailure には
      「友達の実機で起きた不具合を回収する唯一の手段」と書いてあるのに、
      いちばん失敗する経路に繋がっていなかった。
      友達が記録を送ろうとしても last-launch.json しか無い、という状態になる。
    */
    recordFailure(method, error, params);
    throw error;
  } finally {
    runningRequestId = null;
    off();
  }
}

ipcMain.handle('app:cancel', async () => {
  if (runningRequestId === null) return false;
  await sidecar.cancel(runningRequestId);
  return true;
});

ipcMain.handle('app:analyze', async (e, params: Record<string, unknown>) =>
  runCancellable(BrowserWindow.fromWebContents(e.sender), 'analyze', params),
);

ipcMain.handle('app:redetect', async (e, params: Record<string, unknown>) =>
  runCancellable(BrowserWindow.fromWebContents(e.sender), 'redetect', params),
);

ipcMain.handle('app:planFraming', async (e, params: Record<string, unknown>) =>
  runCancellable(BrowserWindow.fromWebContents(e.sender), 'plan_framing', params),
);

ipcMain.handle('app:buildTelops', async (e, params: Record<string, unknown>) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const off = forwardProgress(win);
  try {
    return await sidecar.call('build_telops', params);
  } catch (error) {
    recordFailure('build_telops', error, params);
    throw error;
  } finally {
    off();
  }
});

/**
 * 失敗の記録を必ず残す。
 * 画面に一瞬出て消えるだけだと、何が起きたか誰にも分からない。
 * 友達の実機で起きた不具合を回収する唯一の手段でもある（§10.5）。
 */
function recordFailure(stage: string, error: unknown, params?: Record<string, unknown>): void {
  const e = error as Error;
  writeArtifact('last-error.json', {
    stage,
    at: new Date().toISOString(),
    version: app.getVersion(),
    message: e?.message ?? String(error),
    stack: e?.stack,
    params,
    /*
      🔴 サイドカーの stderr を必ず残す。

      ffmpeg の失敗の**本当の理由はここにしか出ない**。画面に出るのは
      友達向けに言い換えた一文だけで、それだけを送ってもらっても
      「見つからない／許可が無い／壊れている」の区別がつかない。
      実際に、これが無かったせいで原因を絞れず友達を往復させた。
    */
    sidecarStderr: sidecar.stderrTail.slice(-60),
    // 素材そのものの状態。パスは記録するが、中身は一切読まない。
    input: describeInput(params?.video_path),
  });
}

/** 選ばれた素材が、その場所に本当にあるかを記録に残すためだけの情報。 */
function describeInput(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const s = statSync(value);
    return { path: value, exists: true, size: s.size, isFile: s.isFile() };
  } catch (err) {
    return { path: value, exists: false, reason: (err as NodeJS.ErrnoException)?.code ?? String(err) };
  }
}

/**
 * レンダラが Canvas で描いたテロップ PNG をディスクに落とす。
 *
 * 描画をレンダラでやるのは、プレビューと書き出しで**同じコードを通す**ため（§6）。
 * Python 側で描き直すと、その瞬間に見た目のずれが入り込む。
 */
ipcMain.handle(
  'app:saveTelopFrames',
  (_e, payload: { dir: string; frames: { name: string; base64: string }[] }) => {
    try {
      mkdirSync(payload.dir, { recursive: true });
      const paths: Record<string, string> = {};
      for (const frame of payload.frames) {
        const target = join(payload.dir, frame.name);
        // 🔴 PNG は base64 文字列で受け取る。
        //    Uint8Array を contextBridge 越しに渡すのは Electron のバージョンで
        //    挙動が変わる。文字列なら確実に渡る（T1 で実績のある経路）。
        writeFileSync(target, Buffer.from(frame.base64, 'base64'));
        paths[frame.name] = target;
      }
      return paths;
    } catch (error) {
      recordFailure('saveTelopFrames', error, { dir: payload?.dir, count: payload?.frames?.length });
      throw error;
    }
  },
);

/*
  🔴 書き出しも必ず runCancellable を通すこと。
     ここだけ sidecar.call を直接呼んでいたため runningRequestId が設定されず、
     書き出しは**原理的に中断できなかった**。
     M2 Air で20分素材なら数分〜十数分、その間ずっと 5% のまま止める手段が無い。
*/
ipcMain.handle('app:export', async (e, params: Record<string, unknown>) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  try {
    return await runCancellable(win, 'export', params);
  } catch (error) {
    recordFailure('export', error, {
      ...params,
      // テロップは件数が多いので、記録には最初の3件だけ残す
      telops: (params.telops as unknown[])?.slice(0, 3),
    });
    throw error;
  }
});

/**
 * 作業状態の保存と再開。
 *
 * 🔴 これが無いと、20分素材のレビューを100件終えた時点でアプリが落ちれば
 *    解析からやり直しになる。人間は途中で席も立つ。
 *    解析結果（文字起こし・候補・クリップ）は作業フォルダに残っているので、
 *    判定の内容だけ保存すれば再開できる。
 */
ipcMain.handle(
  'app:saveProject',
  (_e, payload: { workDir: string; data: unknown; summary?: Partial<DraftEntry> }) => {
    const target = join(payload.workDir, 'project.json');
    mkdirSync(payload.workDir, { recursive: true });
    writeFileSync(target, JSON.stringify(payload.data, null, 2), 'utf8');
    if (payload.summary) {
      try {
        rememberDraft(draftsIndexPath(), {
          ...payload.summary,
          workDir: payload.workDir,
        } as DraftEntry);
      } catch (e) {
        // 索引が書けなくても下書き本体は保存できている。ここで失敗を投げると
        // 「保存できませんでした」に見えてしまう。
        recordFailure('rememberDraft', e, { workDir: payload.workDir });
      }
    }
    return target;
  },
);

ipcMain.handle('app:loadProject', (_e, workDir: string) => {
  const target = join(workDir, 'project.json');
  if (!existsSync(target)) return null;
  try {
    return JSON.parse(readFileSync(target, 'utf8'));
  } catch (e) {
    recordFailure('loadProject', e, { workDir });
    return null;
  }
});

/** 索引の置き場所。動画の隣ではなくアプリ側に持つ（drafts.ts の冒頭参照） */
const draftsIndexPath = () => join(app.getPath('userData'), 'drafts.json');

ipcMain.handle('app:listDrafts', () => listDrafts(draftsIndexPath()));

ipcMain.handle(
  'app:findDraft',
  (_e, videoPath: string) =>
    listDrafts(draftsIndexPath()).find((d) => d.videoPath === videoPath) ?? null,
);

/**
 * 下書きを捨てる。
 *
 * 🔴 作業フォルダごと消す。project.json だけ消しても
 *    音声・クリップ・解析結果（20分素材で数十MB）が残り続け、
 *    それを片付ける手段がアプリのどこにも無くなる。
 * 🔴 消す前に必ずパスを確かめる。渡された文字列を無条件に rm するのは危ない。
 */
ipcMain.handle('app:deleteDraft', async (e, workDir: string) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!isWorkDir(workDir)) {
    recordFailure('deleteDraft', new Error('作業フォルダではないパスを指定されました'), { workDir });
    return false;
  }

  // 古い置き場所（素材ごとに分ける前）の下書きは、フォルダごと消すと
  // 他の素材の作業フォルダまで巻き添えになる。判定の内容だけ消す。
  const shared = isSharedWorkDir(workDir);

  const answer = await dialog.showMessageBox(win!, {
    type: 'warning',
    buttons: ['下書きを削除する', 'キャンセル'],
    defaultId: 1,
    cancelId: 1,
    message: 'この下書きを削除しますか？',
    detail: shared
      ? '判定した内容を削除します。\n' +
        '元の動画は消えません。もう一度編集するときは解析からやり直しになります。'
      : '判定した内容と、解析の結果（音声・プレビュー）をまとめて削除します。\n' +
        '元の動画は消えません。もう一度編集するときは解析からやり直しになります。',
  });
  if (answer.response !== 0) return false;

  // 🔴 消す直前にもう一度、そこが本当に作業フォルダかを確かめる。
  //    下書きの本体が無い場所を「作業フォルダ」として消しにいくことはない。
  if (!existsSync(join(workDir, 'project.json'))) {
    recordFailure('deleteDraft', new Error('下書きの無い場所を削除しようとしました'), { workDir });
    forgetDraft(draftsIndexPath(), workDir);
    return false;
  }

  try {
    rmSync(shared ? join(workDir, 'project.json') : workDir, { recursive: true, force: true });
  } catch (err) {
    recordFailure('deleteDraft', err, { workDir });
  }
  forgetDraft(draftsIndexPath(), workDir);
  return true;
});

/**
 * レビュー用クリップを1本その場で作る。
 * 自動でカット/見送りにした箇所には解析時のクリップが無いので、
 * 「見て確かめたい」と言われた時点で作る（sidecar/rpc.py の _make_clip 参照）。
 */
ipcMain.handle('app:makeClip', async (_e, params: Record<string, unknown>) => {
  try {
    return await sidecar.call('make_clip', params);
  } catch (error) {
    recordFailure('makeClip', error, params);
    return null;
  }
});

/**
 * 編集をやめるときの確認。
 *
 * 🔴 黙って捨ててはいけない。レビューを何十件も終えたあとかもしれない。
 *    かといって毎回「保存しますか」だけ出しても、
 *    やめたいのか間違えて押したのか分からない。3択にする。
 */
ipcMain.handle('app:confirmQuit', async (e, info: { hasWork: boolean }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!info?.hasWork) {
    const plain = await dialog.showMessageBox(win!, {
      type: 'question',
      buttons: ['編集をやめる', 'キャンセル'],
      defaultId: 1,
      cancelId: 1,
      message: '編集をやめますか？',
      detail: 'まだ何も変更していないので、失われるものはありません。',
    });
    return plain.response === 0 ? 'discard' : 'cancel';
  }

  const result = await dialog.showMessageBox(win!, {
    type: 'question',
    buttons: ['下書きを保存してやめる', '保存せずにやめる', 'キャンセル'],
    defaultId: 0,
    cancelId: 2,
    message: '編集をやめますか？',
    detail:
      '下書きを保存しておくと、次に同じ動画を開いたときに続きから始められます。\n' +
      '解析はやり直さずに済みます。',
  });
  return (['save', 'discard', 'cancel'] as const)[result.response] ?? 'cancel';
});

/** 下書きが見つかったときに、続きから始めるか聞く */
ipcMain.handle('app:confirmResume', async (e, info: { savedAt: string; decided: number }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const when = new Date(info.savedAt).toLocaleString('ja-JP');
  const result = await dialog.showMessageBox(win!, {
    type: 'question',
    buttons: ['続きから始める', '最初からやり直す', 'キャンセル'],
    defaultId: 0,
    cancelId: 2,
    message: 'この動画の下書きがあります',
    detail:
      `保存: ${when}
判定済み: ${info.decided} 件

` +
      '続きから始めれば、解析をやり直さずに済みます。',
  });
  return (['resume', 'fresh', 'cancel'] as const)[result.response] ?? 'cancel';
});

/**
 * 画面に出すキーの表記を決めるための情報。
 * 🔴 OSの判定そのものは paths.ts に置く。レンダラ側へは結果だけ渡す。
 */
ipcMain.handle('app:uiInfo', () => ({ isMac: needsAppMenu() }));

/**
 * テロップの見た目の既定。
 *
 * 🔴 作業フォルダではなくアプリ側に置く。
 *    「自分のテロップはいつもこの書体・この色」は**人に紐づく設定**で、
 *    素材ごとに持つものではない。作業フォルダに置くと、
 *    次の動画を始めるたびに設定し直すことになる。
 */
const telopStylesPath = () => join(app.getPath('userData'), 'telop-styles.json');

ipcMain.handle('app:loadTelopStyles', () => {
  const target = telopStylesPath();
  if (!existsSync(target)) return null;
  try {
    return JSON.parse(readFileSync(target, 'utf8'));
  } catch (e) {
    // 🔴 壊れていても止めない。既定の見た目で始められれば作業は続けられる。
    //    ここで例外を投げると、設定ファイルが1つ壊れただけでアプリが使えなくなる。
    recordFailure('loadTelopStyles', e, { target });
    return null;
  }
});

ipcMain.handle('app:saveTelopStyles', (_e, styles: unknown) => {
  const target = telopStylesPath();
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(styles, null, 2), 'utf8');
    return true;
  } catch (e) {
    recordFailure('saveTelopStyles', e, { target });
    return false;
  }
});

ipcMain.handle('app:revealFile', (_e, filePath: string) => {
  shell.showItemInFolder(filePath);
});

/**
 * Final Cut Pro 用のタイムラインの隣に、使った書体のファイルを置く。
 *
 * 🔴 同梱書体は**アプリの中にしか無い**。
 *    タイムラインに font="Zen Kaku Gothic New" と書いても、
 *    その Mac に入っていなければ Final Cut は警告も出さずに別の書体で開く
 *    （たいていヒラギノ）。書き出したあと本人が気づく手段が無い。
 *    一緒に置いて、一度だけ Font Book に入れてもらう。
 *
 * 🔴 実際に使った書体だけを置くこと。4書体7ファイルで 24MB あり、
 *    毎回全部置くと書き出し先が重くなるうえ、入れる手間も増える。
 */
ipcMain.handle(
  'app:exportFonts',
  (_e, payload: { nextTo: string; files: string[] }) => {
    const target = join(dirname(payload.nextTo), `${basename(payload.nextTo, extname(payload.nextTo))}_フォント`);
    // 🔴 元からあったフォルダかを覚えておく。
    //    無いときだけ後片付けしてよい（下の rmdirSync の理由）。
    const existed = existsSync(target);
    try {
      mkdirSync(target, { recursive: true });
      const copied: string[] = [];
      for (const name of [...new Set(payload.files)]) {
        // 渡された名前をそのままパスに使わない。フォルダを抜けられてしまう
        const safe = basename(name);
        const from = join(appRoot(), 'dist', 'fonts', safe);
        if (!existsSync(from)) continue;
        // asar の中から読むので、copyFile ではなく読み書きで確実に取り出す
        writeFileSync(join(target, safe), readFileSync(from));
        copied.push(safe);
      }
      if (copied.length === 0) {
        /*
          🔴 中身ごと消す（recursive）ことは絶対にしない。

          前回の書き出しで置いた書体が入っていても、まとめて消えてしまう。
          「2本目の書き出しで1つ書体が見つからなかった」だけで、
          1本目のぶんまで消える。しかも本人は気づかない。
          このとき作ったばかりの空フォルダだけを、空のときに限って片付ける。
        */
        if (!existed) {
          try {
            rmdirSync(target);
          } catch {
            // 空でなければ残す。消してよいものか判断できない
          }
        }
        return null;
      }

      const notice =
        'このフォルダのフォントについて\n' +
        '\n' +
        '同じ場所にある .fcpxml を Final Cut Pro で開く前に、\n' +
        'ここにある .ttf ファイルを **すべて選んでダブルクリック** し、\n' +
        '出てきた窓の「インストール」を押してください（Font Book が開きます）。\n' +
        '\n' +
        '入れないと、テロップの書体だけ別のもの（ヒラギノなど）に置き換わります。\n' +
        '色・大きさ・位置は入れなくても合います。\n' +
        '\n' +
        '入れるのは最初の1回だけです。次からは同じ書体が使えます。\n' +
        '\n' +
        'これらのフォントは SIL Open Font License 1.1 で配布されているものです。\n';
      writeFileSync(join(target, 'お読みください.txt'), notice, 'utf8');
      return target;
    } catch (e) {
      recordFailure('exportFonts', e, { nextTo: payload.nextTo });
      return null;
    }
  },
);

/**
 * SMOKE_TEST=1 で起動すると、ウィンドウを出さずに
 * 「Electron が起動する → サイドカーが応答する」ことだけ確認して終了する。
 * CI（§10.3 のスモークテスト）で両OSの疎通を自動検証するための入口。
 */
async function runSmokeTest(): Promise<never> {
  const write = (result: Record<string, unknown>) => writeArtifact('smoke-result.json', result);

  write({ ok: false, stage: 'started', electron: process.versions.electron });

  try {
    const env = await sidecar.call('env');
    write({ ok: true, electron: process.versions.electron, env });
    sidecar.stop();
    app.exit(0);
  } catch (e) {
    write({ ok: false, error: (e as Error).message });
    sidecar.stop();
    app.exit(1);
  }
  return new Promise<never>(() => {});
}

const MEDIA_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.png': 'image/png',
  '.wav': 'audio/wav',
};

/**
 * ローカルの動画をレンダラで再生できるようにする。
 *
 * 開発中はページが http://localhost なので file:// を直接読めない。
 * 配布時も file:// をそのまま許すのは避けたいので、専用のスキームを1つ用意して
 * そこ経由でだけ読む。
 *
 * 🔴 Range リクエストに応えること。
 *    ファイル全体を1本のレスポンスで返すと、Chromium は**任意の位置へシークできない**。
 *    レビュー用の1〜5秒クリップなら問題にならないが、
 *    テロップの確認では元素材（数百MB〜）の任意の時刻へ飛ぶ必要がある。
 */
function registerMediaProtocol(): void {
  protocol.handle('media', async (request) => {
    const url = new URL(request.url);
    // media://local/<エンコード済み絶対パス>
    const filePath = decodeURIComponent(url.pathname).replace(/^\//, '');

    let size: number;
    try {
      size = statSync(filePath).size;
    } catch (e) {
      console.error('[media] 読み込めませんでした:', filePath, e);
      return new Response('not found', { status: 404 });
    }

    const type = MEDIA_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    const range = request.headers.get('Range');
    const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;

    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start >= size || end < start) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${size}` },
        });
      }
      const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream;
      return new Response(stream, {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
        },
      });
    }

    const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': type,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
      },
    });
  });
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

app
  .whenReady()
  .then(() => {
    registerMediaProtocol();
    // 起動時の引数を必ず残す。診断情報として友達の実機からも回収する（§10.5）
    writeArtifact('last-launch.json', { argv: process.argv, cwd: process.cwd() });

    sidecar.start();

    if (process.env.SMOKE_TEST === '1' || process.argv.includes('--smoke-test')) {
      void runSmokeTest();
      return;
    }

    if (process.argv.includes('--t1-wysiwyg')) {
      void runT1(appRoot(), process.env.VITE_DEV_SERVER_URL)
        .then((code) => {
          sidecar.stop();
          app.exit(code);
        })
        .catch((e: Error) => {
          writeArtifact('t1-error.json', { message: e.message, stack: e.stack });
          console.error('T1 に失敗しました:', e);
          sidecar.stop();
          app.exit(1);
        });
      return;
    }

    if (process.argv.includes('--t2-budoux')) {
      void runT2(appRoot(), process.env.VITE_DEV_SERVER_URL)
        .then((code) => {
          sidecar.stop();
          app.exit(code);
        })
        .catch((e: Error) => {
          writeArtifact('t2-error.json', { message: e.message, stack: e.stack });
          console.error('T2 に失敗しました:', e);
          sidecar.stop();
          app.exit(1);
        });
      return;
    }

    if (process.argv.includes('--t5-telop')) {
      void runTelopE2E(appRoot(), process.env.VITE_DEV_SERVER_URL)
        .then((code) => {
          sidecar.stop();
          app.exit(code);
        })
        .catch((e: Error) => {
          writeArtifact('t5-error.json', { message: e.message, stack: e.stack });
          console.error('T5 に失敗しました:', e);
          sidecar.stop();
          app.exit(1);
        });
      return;
    }

    if (process.argv.includes('--t4-sidecar')) {
      void runT4(appRoot())
        .then((code) => {
          sidecar.stop();
          app.exit(code);
        })
        .catch((e: Error) => {
          writeArtifact('t4-error.json', { message: e.message, stack: e.stack });
          console.error('T4 に失敗しました:', e);
          sidecar.stop();
          app.exit(1);
        });
      return;
    }

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((e: Error) => {
    // 握り潰すと「終了コード0で何も起きない」という最悪のデバッグ体験になる。
    // Mac 実機を触れない体制では、起動時例外が必ず形に残ることが重要（§10.5）。
    writeArtifact('startup-error.json', { message: e.message, stack: e.stack });
    console.error('起動に失敗しました:', e);
    app.exit(1);
  });

app.on('window-all-closed', () => {
  sidecar.stop();
  app.quit();
});

app.on('before-quit', () => sidecar.stop());
