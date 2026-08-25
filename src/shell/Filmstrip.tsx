/**
 * 映像のコマを並べるレーン。編集ソフトのタイムラインで、
 * 「どのあたりに何が映っているか」を目で探すためのもの。
 *
 * 🔴 見えている範囲だけ作ること。
 *    素材全体のコマを一度に取り出すと、20分の素材で数百枚になり、
 *    取り出しのあいだ画面が固まる。実用にならない。
 *
 * 🔴 取り出しは1枚ずつ順番に。
 *    <video> は同時に複数の位置へは飛べない。並行にやると
 *    seek が互いに潰し合って、同じコマばかりになる。
 *
 * 作り方は「隠した <video> を目的の時刻へ飛ばして、canvas に写す」。
 * ffmpeg を呼ばずに済むので、追加の仕組みが要らない。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
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
   *    ここだけ別の時間で並べると、同じ横位置が別の瞬間を指すことになり、
   *    「コマを見て場所を決める」ができなくなる。
   *    渡す側（CutStage / TelopStage）が、目盛りごと切り替える。
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
  const busy = useRef(false);
  const queue = useRef<number[]>([]);

  const thumbW = Math.round(height * aspect);
  const step = stepFor(scale, thumbW);

  /*
    見えている範囲の、必要な時刻を並べる。

    segments が来ているときは、並べる位置は**カット後の時刻**で、
    そこに写すのは対応する**元素材の時刻**のコマ。
    ここを取り違えると、切ったはずの場面がコマに出る。
  */
  const slots = useMemo(() => {
    const out: { at: number; src: number }[] = [];
    const first = Math.max(0, Math.floor(from / step) * step);
    for (let t = first; t < Math.min(duration, to + step); t += step) {
      const at = Number(t.toFixed(2));
      out.push({ at, src: segments ? toSource(segments, at) : at });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, step, duration, segments]);

  useEffect(() => {
    if (!videoPath || failed) return;
    const need = slots.map((s) => s.src).filter((t) => !shots.has(t) && !queue.current.includes(t));
    if (need.length === 0) return;
    queue.current.push(...need);

    if (busy.current) return;
    busy.current = true;

    const v = videoRef.current;
    if (!v) {
      busy.current = false;
      return;
    }

    let alive = true;
    const canvas = document.createElement('canvas');

    const grab = (t: number) =>
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
            fin(canvas.toDataURL('image/jpeg', 0.6));
          } catch {
            fin(null);
          }
        };
        v.addEventListener('seeked', onSeeked);
        // 取り出せないまま止まらないように上限を置く
        setTimeout(() => fin(null), 4000);
        v.currentTime = Math.min(t, Math.max(0, duration - 0.05));
      });

    void (async () => {
      // メタデータが来るまで待つ。来ないうちに飛ばすと必ず失敗する
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
      while (alive && queue.current.length > 0) {
        const t = queue.current.shift()!;
        const url = await grab(t);
        if (!alive) break;
        if (url) {
          setShots((m) => new Map(m).set(t, url));
        } else if (++miss >= 3) {
          // 3回続けて取れないなら、この素材ではコマを出せない
          setFailed(true);
          break;
        }
      }
      busy.current = false;
    })();

    return () => {
      alive = false;
      busy.current = false;
    };
    // slots は毎回新しい配列になるので、中身を文字列にして比べる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoPath, slots.map((s) => s.src).join(','), thumbW, height, duration, failed]);

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
