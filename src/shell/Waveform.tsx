/**
 * 音の波。編集ソフトのタイムラインで、声のある場所を目で探すためのもの。
 *
 * 🔴 偽の波形は置かない。
 *    見た目のために適当な波を描くと、無音に見える場所に声があったりする。
 *    実際の音から作れないなら、何も出さないほうがまだ良い。
 *
 * 元にするのは解析で作った audio.wav（16kHz モノラル）。
 * 素材そのものではなく、これを使うのは
 *   - 既にディスクにある（作り直さなくてよい）
 *   - 16kHz モノラルなので軽い（10分で約19MB）
 * から。
 *
 * 🔴 山の値は一度だけ計算して持ち回す。
 *    拡大するたびに音を読み直すと、拡大が実用にならない。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { mediaUrl } from './media';
import type { TimelineView } from './Timeline';

/** 1秒あたりいくつの山を持つか。これ以上細かくしても画面では見えない */
const BUCKETS_PER_SEC = 40;

type Peaks = { min: Float32Array; max: Float32Array; perSec: number } | null;

/** 音を読んで、区間ごとの最小・最大を出す */
async function loadPeaks(path: string, signal: AbortSignal): Promise<Peaks> {
  const res = await fetch(mediaUrl(path));
  if (!res.ok) throw new Error(`音を読めません: ${res.status}`);
  const buf = await res.arrayBuffer();
  if (signal.aborted) return null;

  const ctx = new OfflineAudioContext(1, 1, 44100);
  const audio = await ctx.decodeAudioData(buf);
  if (signal.aborted) return null;

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
  return { min, max, perSec };
}

export interface WaveformProps extends TimelineView {
  /** 解析で作った audio.wav の絶対パス */
  audioPath?: string;
  color?: string;
}

export function Waveform({ audioPath, scale, from, to, height, duration, color }: WaveformProps) {
  const [peaks, setPeaks] = useState<Peaks>(null);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!audioPath) return;
    const ac = new AbortController();
    setError(null);
    loadPeaks(audioPath, ac.signal)
      .then((p) => {
        if (!ac.signal.aborted) setPeaks(p);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError(String(e?.message ?? e));
      });
    return () => ac.abort();
  }, [audioPath]);

  // 見えている範囲だけ描く。全体を一度に描くと 20分の素材で固まる
  const left = Math.max(0, Math.floor(from * scale) - 200);
  const right = Math.min(duration * scale, Math.ceil(to * scale) + 200);
  const w = Math.max(1, Math.round(right - left));

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !peaks) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(height * dpr);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, height);

    const mid = height / 2;
    ctx.fillStyle = color ?? 'rgba(160, 200, 255, 0.75)';

    for (let x = 0; x < w; x++) {
      const sec = (left + x) / scale;
      const i0 = Math.floor(sec * peaks.perSec);
      const i1 = Math.max(i0 + 1, Math.floor(((left + x + 1) / scale) * peaks.perSec));
      let lo = 0;
      let hi = 0;
      for (let i = i0; i < i1 && i < peaks.min.length; i++) {
        if (peaks.min[i] < lo) lo = peaks.min[i];
        if (peaks.max[i] > hi) hi = peaks.max[i];
      }
      const top = mid - hi * mid;
      const bottom = mid - lo * mid;
      // 完全な無音でも 1px は描く。線が途切れると「読めていない」のと区別が付かない
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
  }, [peaks, left, w, height, scale, color]);

  if (!audioPath) return null;

  if (error) {
    return (
      <div className="fcp-lane-note">
        音の波を出せませんでした（{error}）
      </div>
    );
  }

  if (!peaks) {
    return <div className="fcp-lane-note">音を読んでいます…</div>;
  }

  return (
    <canvas
      ref={canvasRef}
      className="fcp-lane-canvas"
      style={{ left, width: w, height }}
      aria-hidden="true"
    />
  );
}

/** 音の長さから、波形が出せるかだけ先に知りたいとき用 */
export function useHasAudio(path?: string): boolean {
  return useMemo(() => Boolean(path), [path]);
}
