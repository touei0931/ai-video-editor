/**
 * メニューバー。
 *
 * 既定のままだと「File / Edit / View / Window」が英語で出るだけで、
 * アプリの機能に一切繋がっていない。IT知識のない人が使うので、
 * **キーボードショートカットを覚えていなくてもメニューから辿れる**ことが要る。
 *
 * 🔴 メニューの項目は、画面側のキーボード操作をそのまま呼ぶ。
 *    メニュー用に処理をもう一本書くと、片方だけ直して食い違う。
 *    そこで「このキーを押したことにする」という指示だけを送る。
 *
 * 🔴 今の画面で意味を持たない項目は無効にする。
 *    押しても何も起きない項目が並んでいるほうが、
 *    項目が無いより分かりにくい。
 */
import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron';

/** 画面の段階。どの項目を有効にするかを決める。 */
export type Phase =
  | 'idle'
  | 'analyzing'
  | 'no-speech'
  | 'review'
  | 'telops-building'
  | 'telop'
  | 'framing'
  | 'fullpreview'
  | 'exporting'
  | 'done';

export interface MenuContext {
  phase: Phase;
  /** 作業フォルダ。解析後にだけ存在する */
  workDir?: string | null;
  /** 書き出したファイル */
  outPath?: string | null;
}

function send(win: BrowserWindow | null, action: string): void {
  if (win && !win.isDestroyed()) win.webContents.send('app:menu', action);
}

/** 画面側のキーボード操作をそのまま呼ぶ */
function key(
  label: string,
  k: string,
  accelerator: string,
  win: BrowserWindow | null,
  enabled: boolean,
): MenuItemConstructorOptions {
  return { label, accelerator, enabled, click: () => send(win, `key:${k}`) };
}

export function buildMenu(win: BrowserWindow | null, ctx: MenuContext): void {
  const { phase } = ctx;
  const inReview = phase === 'review';
  const inTelop = phase === 'telop';
  const inPreview = phase === 'fullpreview';
  const idle = phase === 'idle' || phase === 'done' || phase === 'no-speech';
  const busy = phase === 'analyzing' || phase === 'exporting' || phase === 'telops-building' || phase === 'framing';

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'ファイル',
      submenu: [
        {
          label: '動画を読み込む…',
          accelerator: 'CmdOrCtrl+O',
          enabled: idle,
          click: () => send(win, 'open'),
        },
        {
          label: '下書きの続きから…',
          accelerator: 'CmdOrCtrl+R',
          enabled: idle,
          click: () => send(win, 'drafts'),
        },
        {
          label: '作業内容を保存',
          accelerator: 'CmdOrCtrl+S',
          enabled: inReview || inTelop,
          click: () => send(win, 'save'),
        },
        { type: 'separator' },
        {
          label: '書き出す…',
          accelerator: 'CmdOrCtrl+E',
          enabled: inPreview || inTelop,
          click: () => send(win, 'export'),
        },
        {
          label: '編集をやめる',
          accelerator: 'CmdOrCtrl+W',
          enabled: inReview || inTelop || inPreview,
          click: () => send(win, 'quit'),
        },
        {
          label: '解析をやめる',
          accelerator: 'Esc',
          enabled: phase === 'analyzing',
          click: () => send(win, 'cancel'),
        },
        { type: 'separator' },
        {
          label: '作業フォルダを開く',
          enabled: Boolean(ctx.workDir),
          click: () => {
            if (ctx.workDir) void shell.openPath(ctx.workDir);
          },
        },
        {
          label: '書き出したファイルの場所を開く',
          enabled: Boolean(ctx.outPath),
          click: () => {
            if (ctx.outPath) shell.showItemInFolder(ctx.outPath);
          },
        },
        { type: 'separator' },
        { label: '終了', role: 'quit' },
      ],
    },
    {
      label: '編集',
      submenu: [
        {
          label: '元に戻す',
          accelerator: 'CmdOrCtrl+Z',
          enabled: inReview || inTelop,
          // カット画面は U、テロップ画面は Ctrl+Z が取り消し
          click: () => send(win, inReview ? 'key:u' : 'undo'),
        },
        { type: 'separator' },
        { label: '切り取り', role: 'cut' },
        { label: 'コピー', role: 'copy' },
        { label: '貼り付け', role: 'paste' },
        { label: 'すべて選択', role: 'selectAll' },
      ],
    },
    {
      label: 'カット',
      submenu: [
        key('この候補をカットする', 'y', 'Y', win, inReview),
        key('この候補は残す', 'n', 'N', win, inReview),
        key('保留にする', 's', 'S', win, inReview),
        key('直前の判定を取り消す', 'u', 'U', win, inReview),
        { type: 'separator' },
        key('前の候補へ', '[', '[', win, inReview),
        key('次の候補へ', ']', ']', win, inReview),
        { type: 'separator' },
        key('カットの始まりを1コマ前へ', 'ArrowLeft', 'Left', win, inReview),
        key('カットの始まりを1コマ後へ', 'ArrowRight', 'Right', win, inReview),
        key('カットの終わりを1コマ前へ', 'Shift+ArrowLeft', 'Shift+Left', win, inReview),
        key('カットの終わりを1コマ後へ', 'Shift+ArrowRight', 'Shift+Right', win, inReview),
        { type: 'separator' },
        key('残りをまとめてカットする', 'Enter', 'Enter', win, inReview),
      ],
    },
    {
      label: 'テロップ',
      submenu: [
        key('文言を直す', 'e', 'E', win, inTelop),
        key('次の要確認へ', 'Tab', 'Tab', win, inTelop),
        { type: 'separator' },
        key('通常スタイル', '1', '1', win, inTelop),
        key('補足スタイル', '2', '2', win, inTelop),
        key('強調スタイル', '3', '3', win, inTelop),
        key('表示位置を変える', 'p', 'P', win, inTelop),
        { type: 'separator' },
        {
          label: 'テロップを追加',
          accelerator: 'CmdOrCtrl+T',
          enabled: inTelop,
          click: () => send(win, 'addTelop'),
        },
        key('このテロップを削除', 'Delete', 'Delete', win, inTelop),
      ],
    },
    {
      label: '再生',
      submenu: [
        key('再生 / 一時停止', ' ', 'Space', win, inReview || inTelop || inPreview),
        key('繋ぎ目から再生', 'r', 'R', win, inReview || inTelop),
        { type: 'separator' },
        {
          label: '通しで確認する',
          enabled: inTelop,
          click: () => send(win, 'fullpreview'),
        },
      ],
    },
    {
      label: '表示',
      submenu: [
        { label: '拡大', role: 'zoomIn' },
        { label: '縮小', role: 'zoomOut' },
        { label: '標準の大きさ', role: 'resetZoom' },
        { type: 'separator' },
        { label: '全画面表示', role: 'togglefullscreen' },
        { label: '再読み込み', role: 'reload', enabled: !busy },
        { type: 'separator' },
        { label: '開発者ツール', role: 'toggleDevTools' },
      ],
    },
    {
      label: 'ヘルプ',
      submenu: [
        {
          label: 'キーボード操作の一覧',
          accelerator: 'F1',
          click: () => send(win, 'shortcuts'),
        },
        { type: 'separator' },
        {
          label: '不具合の記録を開く',
          click: () => void shell.openPath(app.getAppPath() + '/phase0-artifacts'),
        },
        {
          label: `バージョン ${app.getVersion()}`,
          enabled: false,
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
