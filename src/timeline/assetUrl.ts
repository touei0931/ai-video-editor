/**
 * 素材のファイルを <video> / <audio> に読ませる URL を作る。
 *
 * 中身はほぼ mediaUrl（media://local/…）そのままだが、
 * **すでに URL になっているものは触らない**。
 *
 * 🔴 二重に包まないこと。
 *    http:// で始まるものを media://local/http%3A%2F%2F… に変えてしまうと、
 *    Electron のプロトコル係が「そんなファイルは無い」で黙って失敗する。
 *    <video> は例外を投げないので、**映像が出ないだけ**の状態になる。
 *
 * これがあると、ブラウザ（Electron の外）でも動きを確かめられる。
 * media:// は Electron が登録するプロトコルなので、ブラウザでは何も出ない。
 */

import { mediaUrl } from '../shell/media';

/** すでに URL の形をしているか */
const HAS_SCHEME = /^[a-zA-Z][\w+.-]*:/;

export function assetUrl(pathOrUrl: string): string {
  return HAS_SCHEME.test(pathOrUrl) ? pathOrUrl : mediaUrl(pathOrUrl);
}
