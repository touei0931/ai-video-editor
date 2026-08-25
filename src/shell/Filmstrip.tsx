/**
 * 映像のコマを並べるレーン。編集ソフトのタイムラインで、
 * 「どのあたりに何が映っているか」を目で探すためのもの。
 *
 * 🔴 見えている範囲だけ作ること。
 *    素材全体のコマを一度に取り出すと、20分の素材で数百枚になり、
 *    取り出しのあいだ画面が固まる。
 *
 * 🔴 取り出しは1枚ずつ順番に。
 *    <video> は同時に複数の位置へは飛べない。並行にやると
 *    seek が互いに潰し合って、同じコマばかりになる。
 *
 * 🔴 拡大やスクロールの最中は取り出しを始めないこと（2026-08-25 に踏んだ）。
 *    ＋/− を続けて押すと、押すたびに新しい取り出しが始まって前のが残り、
 *    **コマが点滅し、全体/＋/− が押せなくなる**。
 *    落ち着くまで待ってから、1本の流れだけで取り出す。
 *
 * 🔴 toDataURL は使わない。
 *    同期で走るうえ Base64 の文字列を作るので、main を止める。
 *    toBlob（非同期）＋ createObjectURL にする。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mediaUrl } from './media';
import type { TimelineView } from './Timeline';
import { toSource, type Segment } from './editedTime';

export interface FilmstripProps extends TimelineView {
  videoPath?: string;
  /** コマの縦横比。素材の解像度から渡す */
  aspect?: number;
  /**
   * 残る区間。渡すと**カット後の並び**になる。
   *
   * 🔴 タイムラインの目盛りと同じ時間軸で置くこと。
   *    ここだけ別の時間で並べると、同じ横位置が別の瞬間を指すことになる。
   */
  segments?: readonly Segment[];
}

/** その拡大率で、何秒ごとにコマを置くか */
function stepFor(scale: number, thumbW: number): number {
  const sec = thumbW / scale;
  // 半端な刻みだと拡大のたびに全部作り直しになる。決まった段階に丸める
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  return steps.find((s) => s >= sec) ?? steps[steps.length - 1];
}

/** 覚えておくコマの上限。増やしすぎると画像でメモリを食う */
const CACHE_MAX = 240;

/** 拡大やスクロールが落ち着くまで待つ時間（ミリ秒） */
const SETTLE_MS = 220;

export function Filmstrip({
  videoPath,
  scale,
  from,
  to,
  height,
  duration,
  aspect = 16 / 9,
  segments,
}: FilmstripProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [shots, setShots] = useState<Map<number, string>>(new Map());
  const [failed, setFailed] = useState(false);

  /** 取り出しの流れは常に1本だけ。ここが true の間は新しく始めない */
  const running = useRef(false);
  /** いま欲しい時刻。落ち着いたらこれを見に行く */
  const wanted = useRef<number[]>([]);
  const shotsRef = useRef(shots);
  shotsRef.current = shots;

  const thumbW = Math.round(height * aspect);
  const step = stepFor(scale, thumbW);

  const slots = useMemo(() => {
    const out: { at: number; src: number }[] = [];
    const first = Math.max(0, Math.floor(from / step) * step);
    for (let t = first; t < Math.min(duration, to + step); t += step) {
      const at = Number(t.toFixed(2));
      out.push({ at, src: Number((segments ? toSource(segments, at) : at).toFixed(2)) });
    }
    return out;
  }, [from, to, step, duration, segments]);

  const slotKey = slots.map((s) => s.src).join(',');

  /** 1枚取り出す */
  const grab = useCallback(
    (v: HTMLVideoElement, canvas: HTMLCanvasElement, t: number) =>
      new Promise<string | null>((resolve) => {
        let done = false;
        const fin = (r: string | null) => {
          if (done) return;
          done = true;
          v.removeEventListener('seeked', onSeeked);
          resolve(r);
        };
        const onSeeked = () => {
          try {
            canvas.width = thumbW;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (!ctx) return fin(null);
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            // 🔴 toBlob は非同期。toDataURL のように main を止めない
            canvas.toBlob(
              (blob) => fin(blob ? URL.createObjectURL(blob) : null),
              'image/jpeg',
              0.6,
            );
          } catch {
            fin(null);
          }
        };
        v.addEventListener('seeked', onSeeked);
        setTimeout(() => fin(null), 4000);
        v.currentTime = Math.min(t, Math.max(0, duration - 0.05));
      }),
    [thumbW, height, duration],
  );

  useEffect(() => {
    if (!videoPath || failed) return;
    wanted.current = slots.map((s) => s.src);

    /*
      🔴 少し待ってから始める。
         拡大やスクロールの途中は毎フレームここへ来るので、
         そのたびに取り出しを始めると点滅して操作も効かなくなる。
    */
    const timer = setTimeout(() => {
      if (running.current) return;
      const v = videoRef.current;
      if (!v) return;
      running.current = true;

      let alive = true;
      const canvas = document.createElement('canvas');

      void (async () => {
        try {
          if (v.readyState < 1) {
            await new Promise<void>((r) => {
              const ok = () => {
                v.removeEventListener('loadedmetadata', ok);
                r();
              };
              v.addEventListener('loadedmetadata', ok);
              setTimeout(ok, 5000);
            });
          }
          let miss = 0;
          // 途中で見る場所が変わったら、そのときの「欲しい時刻」に従う
          for (;;) {
            if (!alive) break;
            const next = wanted.current.find((t) => !shotsRef.current.has(t));
            if (next === undefined) break;
            const url = await grab(v, canvas, next);
            if (!alive) break;
            if (url) {
              miss = 0;
              setShots((m) => {
                const n = new Map(m).set(next, url);
                // 古いものから捨てる。画像を持ちすぎない
                if (n.size > CACHE_MAX) {
                  const drop = [...n.keys()].slice(0, n.size - CACHE_MAX);
                  for (const k of drop) {
                    URL.revokeObjectURL(n.get(k)!);
                    n.delete(k);
                  }
                }
                return n;
              });
            } else if (++miss >= 3) {
              setFailed(true);
              break;
            }
          }
        } finally {
          running.current = false;
        }
      })();

      return () => {
        alive = false;
      };
    }, SETTLE_MS);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoPath, slotKey, failed, grab]);

  // 出来た画像は必ず片付ける。放っておくとメモリに残り続ける
  useEffect(
    () => () => {
      for (const url of shotsRef.current.values()) URL.revokeObjectURL(url);
    },
    [],
  );

  if (!videoPath) return null;

  return (
    <>
      <video
        ref={videoRef}
        src={mediaUrl(videoPath)}
        muted
        preload="auto"
        style={{ display: 'none' }}
        crossOrigin="anonymous"
      />
      {slots.map((slot) => {
        const url = shots.get(slot.src);
        return (
          <div
            key={slot.at}
            className={`fcp-frame ${url ? '' : 'empty'}`}
            style={{ left: slot.at * scale, width: Math.max(2, step * scale), height }}
          >
            {url && <img src={url} alt="" draggable={false} style={{ height }} />}
          </div>
        );
      })}
      {failed && <div className="fcp-lane-note">この素材ではコマを出せません</div>}
    </>
  );
}
