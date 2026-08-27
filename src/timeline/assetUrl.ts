/**
 * 素材のファイルを <video> / <audio> に読ませる URL を作る。
 *
 * 中身はほぼ mediaUrl（media://local/…）そのままだが、
 * **すでに URL になっているものは触らない**。
 *
 * 🔴 「英字 + コロン」で URL と判断しないこと。
 *    Windows の絶対パスは `C:\Users\…` で始まる。これを URL と見なすと
 *    そのまま <video> に渡してしまい、読み込めずに
 *    **「この素材ではコマを出せません」**になる。
 *    実際にそう書いて、今まで開けていた動画が開けなくなった。
 *    通してよい入れ物を数え上げる形にする（ドライブ文字は1文字なので、
 *    2文字以上を要求するだけでも防げるが、数え上げのほうが後から読める）。
 *
 * これがあると、ブラウザ（Electron の外）でも動きを確かめられる。
 * media:// は Electron が登録するプロトコルなので、ブラウザでは何も出ない。
 */

import { mediaUrl } from '../shell/media';

/** そのまま通してよい入れ物。ここに無いものはファイルの場所として扱う */
const PASS_THROUGH = ['http://', 'https://', 'blob:', 'data:', 'media://', 'file://'];

export function assetUrl(pathOrUrl: string): string {
  const lower = pathOrUrl.toLowerCase();
  return PASS_THROUGH.some((p) => lower.startsWith(p)) ? pathOrUrl : mediaUrl(pathOrUrl);
}
