/**
 * 選んだファイルを「素材」にする。
 *
 * 🔴 ここで ffmpeg を呼ばないこと。
 *    長さと画の有無を知りたいだけなら <video> が答えを持っている。
 *    サイドカー越しに ffprobe を回すと、素材を1本足すたびに
 *    Python の起動を待つことになる（体感で1秒以上）。
 *
 * 🔴 読み込みに時間切れを設けること。
 *    壊れたファイルや、対応していない形式を渡されると
 *    loadedmetadata も error も来ないまま黙って止まることがある。
 */

import { newId, type Asset } from './project';
import { assetUrl } from './assetUrl';

/** 音だけの素材とみなす拡張子 */
const AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus'];

function baseName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || path;
}

function extOf(path: string): string {
  const name = baseName(path).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot);
}

export class ProbeError extends Error {}

/**
 * ファイルの中身を読んで素材を作る。
 *
 * @param timeoutMs 読み込みを諦めるまで。既定 20 秒
 */
export function probeAsset(path: string, timeoutMs = 20000): Promise<Asset> {
  const audioOnly = AUDIO_EXT.includes(extOf(path));

  return new Promise<Asset>((resolve, reject) => {
    const el = document.createElement(audioOnly ? 'audio' : 'video');
    el.preload = 'metadata';
    el.muted = true;

    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.removeEventListener('loadedmetadata', onLoaded);
      el.removeEventListener('error', onError);
      // 🔴 参照を切らないと、素材を足すたびに読み込み済みの動画が溜まる
      el.src = '';
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new ProbeError('読み込みに時間がかかりすぎました'))),
      timeoutMs,
    );

    const onLoaded = () => {
      const duration = el.duration;
      /*
        🔴 長さが取れない素材を通さないこと。
           Infinity や NaN のまま置くと、タイムラインの幅が計算できず
           **画面が真っ白になる**。
      */
      if (!Number.isFinite(duration) || duration <= 0) {
        finish(() => reject(new ProbeError('長さを読み取れませんでした')));
        return;
      }
      const width = (el as HTMLVideoElement).videoWidth ?? 0;
      finish(() =>
        resolve({
          id: newId('asset'),
          path,
          name: baseName(path),
          duration: Number(duration.toFixed(3)),
          hasVideo: !audioOnly && width > 0,
          /*
            🔴 音の有無は当てにできない。
               ブラウザには「音の入っていない動画」を確かめる手立てが無い
               （再生を始めるまで分からない）。ここでは有るものとして扱う。
               無い素材でも、音のレーンに置けば無音になるだけで壊れはしない。
          */
          hasAudio: true,
        }),
      );
    };

    const onError = () =>
      finish(() => reject(new ProbeError('この形式は読み込めませんでした')));

    el.addEventListener('loadedmetadata', onLoaded);
    el.addEventListener('error', onError);
    el.src = assetUrl(path);
  });
}
