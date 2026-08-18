import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { sidecar } from './sidecar.js';
import { isDev } from './paths.js';
import { runT1 } from './t1.js';
import { runT2 } from './t2.js';

// バンドル後は import.meta.url が当てにならないので、基準は必ず app.getAppPath() を使う
// （パッケージ後は app.asar のルートを指すので、配布時も同じ相対関係で解決できる）
const appRoot = () => app.getAppPath();

/**
 * Windows では Electron の stdout/stderr が親コンソールに繋がらないことがあるため、
 * 診断情報はファイルに残す（CI ではアーティファクトとして回収する）。
 */
function writeArtifact(name: string, data: Record<string, unknown>): void {
  try {
    const dir = join(appRoot(), 'phase0-artifacts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('診断ファイルを書けませんでした:', e);
  }
}

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

  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}

ipcMain.handle('sidecar:call', (_e, method: string, params: Record<string, unknown>) =>
  sidecar.call(method, params),
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

app
  .whenReady()
  .then(() => {
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
