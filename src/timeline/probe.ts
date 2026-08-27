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

/**
 * 画の大きさが来るのを待つ上限。
 *
 * 🔴 短くしておくこと。これは「あれば嬉しい」情報で、無くても素材は使える。
 *    長くすると、見えていない窓では素材1本ごとにこの秒数だけ止まる。
 */
const SIZE_WAIT_MS = 1500;

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
    /*
      コマが1枚 decode されないと videoWidth が入らないことがあるので、
      映像は 'auto' で読む。読み終わり次第 src を外すので溜まりはしない。
    */
    el.preload = audioOnly ? 'metadata' : 'auto';
    el.muted = true;

    let done = false;
    /** 大きさを待ち直したか。何度も待たないための印 */
    let waited = false;
    let sizeTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(sizeTimer);
      el.removeEventListener('loadedmetadata', onLoaded);
      el.removeEventListener('loadeddata', onSized);
      el.removeEventListener('resize', onSized);
      el.removeEventListener('error', onError);
      // 🔴 参照を切らないと、素材を足すたびに読み込み済みの動画が溜まる
      el.src = '';
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new ProbeError('読み込みに時間がかかりすぎました'))),
      timeoutMs,
    );

    /*
      画の大きさは「取れたら使う」。**待ち続けないこと**。

      🔴 loadedmetadata の時点で videoWidth が 0 のことがある。
         見えていない窓（画面に出していない BrowserWindow やブラウザの裏タブ）では
         コマが decode されないので、待っても永久に来ない。
         実際に検証用の窓で 20 秒待って時間切れになった。
      🔴 そして、取れなかったことを「映像が無い」にしないこと。
         そうすると**書き出しがその素材のぶんだけ真っ黒になる**。
         エラーは出ないので、出来た動画を最後まで見るまで気付けない（T6 で捕まえた）。
         大きさはプロジェクトの初期値を決める手掛かりに使うだけで、
         取れなければ既定（1920x1080）のままにする。
    */
    const onSized = () => {
      if ((el as HTMLVideoElement).videoWidth > 0) onLoaded();
    };

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
      const height = (el as HTMLVideoElement).videoHeight ?? 0;

      // まだ分からないなら、少しだけ待つ。来なければ大きさ無しで進む
      if (!audioOnly && width === 0 && !waited) {
        waited = true;
        el.addEventListener('loadeddata', onSized);
        el.addEventListener('resize', onSized);
        sizeTimer = setTimeout(onLoaded, SIZE_WAIT_MS);
        return;
      }
      clearTimeout(sizeTimer);

      finish(() =>
        resolve({
          id: newId('asset'),
          path,
          name: baseName(path),
          duration: Number(duration.toFixed(3)),
          /*
            🔴 大きさが取れなかったことを「映像が無い」にしないこと。
               入れ物（拡張子）が動画なら映像はある前提で扱う。
               取り違えると、書き出しがその素材のぶんだけ黒くなる。
               逆（音だけの .mp4 を映像ありと見なす）は、
               書き出しで ffmpeg が「映像の流れが無い」と言って止まるので気付ける。
          */
          hasVideo: !audioOnly,
          ...(width > 0 && height > 0 ? { width, height } : {}),
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
