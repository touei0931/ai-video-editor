/**
 * 素材の音の山を作って覚えておく。
 *
 * 🔴 素材ごとに一度だけ読むこと。
 *    自動カットの結果は同じ素材から数十本のクリップになる。
 *    クリップごとに読み直すと、30分の素材を数十回復号することになり、
 *    メモリも時間も一瞬で尽きる。
 *
 * 🔴 読み込みの約束も覚えること（結果だけでなく）。
 *    覚えるのが結果だけだと、同じ素材の10本が同時に描き始めたときに
 *    10回とも走る。約束を覚えれば、後から来たものは待つだけで済む。
 *
 * 🔴 偽の波形は置かない。
 *    見た目のために適当な波を描くと、無音に見える場所に声があったりする。
 *    出せないなら何も出さない（shell/Waveform.tsx と同じ約束）。
 */

import { assetUrl } from './assetUrl';

/** 1秒あたりいくつの山を持つか。これ以上細かくしても画面では見えない */
export const BUCKETS_PER_SEC = 40;

export interface Peaks {
  min: Float32Array;
  max: Float32Array;
  perSec: number;
  duration: number;
}

const cache = new Map<string, Promise<Peaks>>();

/**
 * 素材の音の山。同じ場所なら何度呼んでも1回しか読まない。
 *
 * 🔴 失敗した約束は覚えから外すこと。
 *    残すと、一度の失敗（読み込み中に素材が移動した等）が
 *    そのセッションのあいだ永久に続く。
 */
export function assetPeaks(path: string): Promise<Peaks> {
  const hit = cache.get(path);
  if (hit) return hit;
  const p = load(path).catch((e) => {
    cache.delete(path);
    throw e;
  });
  cache.set(path, p);
  return p;
}

/** 覚えているものを、あれば同期で返す（描画のたびに await したくない） */
export function peaksNow(path: string): Peaks | null {
  return ready.get(path) ?? null;
}

const ready = new Map<string, Peaks>();

async function load(path: string): Promise<Peaks> {
  const res = await fetch(assetUrl(path));
  if (!res.ok) throw new Error(`音を読めません（${res.status}）`);
  const buf = await res.arrayBuffer();

  /*
    🔴 OfflineAudioContext で復号すること。
       AudioContext を作ると、素材の数だけ音の出口が開く。
       ブラウザは同時に開ける数を制限しているので、
       素材が増えたところで黙って失敗するようになる。
  */
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const audio = await ctx.decodeAudioData(buf);

  const data = audio.getChannelData(0);
  const perSec = BUCKETS_PER_SEC;
  const count = Math.max(1, Math.ceil(audio.duration * perSec));
  const per = data.length / count;
  const min = new Float32Array(count);
  const max = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const from = Math.floor(i * per);
    const to = Math.min(data.length, Math.floor((i + 1) * per));
    let lo = 0;
    let hi = 0;
    for (let j = from; j < to; j++) {
      const v = data[j];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[i] = lo;
    max[i] = hi;
  }

  const peaks: Peaks = { min, max, perSec, duration: audio.duration };
  ready.set(path, peaks);
  return peaks;
}

/**
 * 素材の中の [from, to) を、幅 w の帯として描く。
 *
 * 🔴 完全な無音でも 1px は描くこと。
 *    線が途切れると「無音」なのか「読めていない」のか区別が付かない。
 */
export function drawPeaks(
  ctx: CanvasRenderingContext2D,
  peaks: Peaks,
  from: number,
  to: number,
  w: number,
  height: number,
  color: string,
): void {
  const mid = height / 2;
  const span = Math.max(0.0001, to - from);
  ctx.fillStyle = color;

  for (let x = 0; x < w; x++) {
    const s0 = from + (x / w) * span;
    const s1 = from + ((x + 1) / w) * span;
    const i0 = Math.floor(s0 * peaks.perSec);
    const i1 = Math.max(i0 + 1, Math.floor(s1 * peaks.perSec));
    let lo = 0;
    let hi = 0;
    for (let i = i0; i < i1 && i < peaks.min.length; i++) {
      if (i < 0) continue;
      if (peaks.min[i] < lo) lo = peaks.min[i];
      if (peaks.max[i] > hi) hi = peaks.max[i];
    }
    const top = mid - hi * mid;
    const bottom = mid - lo * mid;
    ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
  }
}
