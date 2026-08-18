/**
 * paths.ts — アプリのパス解決・プラットフォーム差の閉じ込め先（設計レポート §10.4）
 *
 * 🔴 このファイルは「プラットフォーム分岐を書いてよい4ファイル」のひとつです。
 *    ここ以外に process.platform / darwin の分岐を書かないでください
 *    （`npm run guard` で機械的に検査されます）。
 *
 * 他の3ファイルは Python サイドカー側:
 *   - sidecar/asr/__init__.py          ASR バックエンド
 *   - sidecar/face/__init__.py         顔検出 delegate
 *   - sidecar/ffmpeg/platform_args.py  エンコーダ/デコーダ引数
 */
import { join } from 'node:path';
import { app } from 'electron';

export type Platform = 'mac' | 'windows';

export function currentPlatform(): Platform {
  return process.platform === 'darwin' ? 'mac' : 'windows';
}

export const isDev = !app.isPackaged;

/** リポジトリルート（開発時）／リソースディレクトリ（配布時） */
export function resourceRoot(): string {
  return isDev ? join(app.getAppPath()) : process.resourcesPath;
}

/**
 * Python サイドカーの起動コマンドを返す。
 * - 開発時: システムの Python で `python -m sidecar` を実行する
 * - 配布時: PyInstaller onedir でビルドした実行ファイルを直接叩く
 */
export function sidecarCommand(): { command: string; args: string[]; cwd: string } {
  // PyInstaller でビルドしたバイナリを開発中に試すための逃げ道。
  // 「配布形態でだけ壊れる」を開発中に踏めるようにしておく（Mac を触れない体制では特に重要）。
  const override = process.env.SIDECAR_BIN;
  if (override) {
    return { command: override, args: [], cwd: app.getAppPath() };
  }

  if (isDev) {
    const python = currentPlatform() === 'windows' ? 'python' : 'python3';
    return { command: python, args: ['-m', 'sidecar'], cwd: app.getAppPath() };
  }

  const exeName = currentPlatform() === 'windows' ? 'sidecar.exe' : 'sidecar';
  return {
    command: join(resourceRoot(), 'sidecar', exeName),
    args: [],
    cwd: resourceRoot(),
  };
}

/** 同梱 ffmpeg のパス（T3 で LGPL ビルドを vendor/ に置く） */
export function ffmpegPath(): string {
  const exeName = currentPlatform() === 'windows' ? 'ffmpeg.exe' : 'ffmpeg';
  return isDev
    ? join(app.getAppPath(), 'vendor', 'ffmpeg', exeName)
    : join(resourceRoot(), 'ffmpeg', exeName);
}

/** 中間ファイル置き場。書き出し完了後に自動削除する（§9.4 の容量目標） */
export function workDir(): string {
  return join(app.getPath('userData'), 'work');
}

/** 診断情報 zip の保存先（§10.5「診断情報を書き出す」ボタン） */
export function diagnosticsDir(): string {
  return app.getPath('desktop');
}
