/**
 * ローカルの動画ファイルを <video> に読ませるための URL を組み立てる。
 *
 * 🔴 形式を勝手に決めないこと。
 *    electron/main/index.ts が `media` プロトコルを登録していて、
 *    受け取る形は **media://local/<encodeURIComponent した絶対パス>** と決まっている。
 *
 *    作り直しのときに `app-media://...` という存在しない形で書いてしまい、
 *    カット画面もテロップ画面も**映像が一切出ない**状態で友達に見せてしまった。
 *    存在しないプロトコルは例外にならず、ただ黙って何も出ない。
 *
 * 🔴 Windows のバックスラッシュはスラッシュに直すこと。
 *    直さないと URL の中でエスケープ扱いになり、パスが壊れる。
 */
export function mediaUrl(absolutePath: string): string {
  return `media://local/${encodeURIComponent(absolutePath.replace(/\\/g, '/'))}`;
}
