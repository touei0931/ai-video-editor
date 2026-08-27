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
import { assetUrl } from '../timeline/assetUrl';
/*
  🔴 刻みの決め方と取り出す倍率は、並べる画面と**同じものを使う**こと。
     以前はここに同じ処理を書き写していたため、並べる画面だけ直した結果、
     子画面（下ごしらえ）は**拡大するほどコマがぼやけるまま**だった。
     同じ仕組みは1か所に置き、どの画面からも同じ動きにする。
*/
import { captureScale, stepFor } from '../timeline/frames';
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

/**
 * 覚えておくコマの上限。増やしすぎると画像でメモリを食う。
 *
 * 🔴 捨てるときは「入れた順」ではなく「いま見ている場所から遠い順」にすること。
 *    入れた順で捨てると、拡大して作業しているあいだに
 *    **画面に見えているコマが捨てられ、すぐ取り直される**。
 *    これが「コマ割りが点滅する」の正体だった。
 */
const CACHE_MAX = 400;

/** 拡大やスクロールが落ち着くまで待つ時間（ミリ秒） */
const SETTLE_MS = 220;

/**
 * 見えている範囲の外側も、画面幅の何倍ぶんか先に取っておく。
 *
 * 🔴 見えている分しか取らないと、再生中に白線が端まで来て
 *    **半画面ぶん飛ぶたびに、その先が全部空白になる**。
 *    数秒おきにそれが繰り返されるので「点滅している」ように見える。
 *    先に取ってあれば、飛んだ先はもう出来ている。
 */
const PREFETCH = 1;

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
  /** いま見えている範囲（元素材の秒）。捨てる順を決めるのに使う */
  const window0 = useRef({ from: 0, to: 0 });
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

  /**
   * 取り出しておきたい時刻（元素材の秒）。
   * 見えている分を先に、その外側をあとに並べる。順番がそのまま優先順位になる。
   */
  const wantList = useMemo(() => {
    const seen = new Set<number>();
    const out: number[] = [];
    const push = (src: number) => {
      if (seen.has(src)) return;
      seen.add(src);
      out.push(src);
    };
    for (const s of slots) push(s.src);

    const span = Math.max(0, to - from) * PREFETCH;
    const lo = Math.max(0, Math.floor((from - span) / step) * step);
    const hi = Math.min(duration, to + span);
    for (let t = lo; t < hi; t += step) {
      const at = Number(t.toFixed(2));
      push(Number((segments ? toSource(segments, at) : at).toFixed(2)));
    }
    return out;
  }, [slots, from, to, step, duration, segments]);

  const wantKey = wantList.join(',');

  /**
   * まだ取れていないコマの代わりに、いちばん近いコマを出す。
   *
   * 🔴 空白にしないこと。空白と絵が入れ替わるのが「点滅」の見え方そのもの。
   * 🔴 代わりに出してよいのは **1コマ分より近いもの** だけ。
   *    このレーンはもともと step 秒ごとにしか絵を持っていないので、
   *    step 以内のずれは、このレーンが元から持っている粗さの範囲に収まる。
   *    ここを広げると、遠くの場面を平気で出すようになり嘘になる。
   */
  const sortedKeys = useMemo(() => [...shots.keys()].sort((a, b) => a - b), [shots]);
  const nearest = useCallback(
    (t: number): string | undefined => {
      if (sortedKeys.length === 0) return undefined;
      let lo = 0;
      let hi = sortedKeys.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedKeys[mid] < t) lo = mid + 1;
        else hi = mid;
      }
      let best = sortedKeys[lo];
      if (lo > 0 && Math.abs(sortedKeys[lo - 1] - t) < Math.abs(best - t)) best = sortedKeys[lo - 1];
      return Math.abs(best - t) <= step ? shots.get(best) : undefined;
    },
    [sortedKeys, shots, step],
  );

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
            /*
              🔴 見た目の大きさちょうどで取り出さないこと。
                 画素の細かい画面では CSS の 1px が実際には 2px なので、
                 等倍で取ると**そのぶんだけぼやける**。
            */
            const k = captureScale();
            canvas.width = Math.round(thumbW * k);
            canvas.height = Math.round(height * k);
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
    wanted.current = wantList;
    if (slots.length > 0) {
      window0.current = { from: slots[0].src, to: slots[slots.length - 1].src };
    }

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
                if (n.size > CACHE_MAX) {
                  /*
                    いま見えている範囲の**外側**から、遠い順に捨てる。
                    見えているものは絶対に捨てない（捨てると取り直しになり点滅する）。
                  */
                  const { from: vf, to: vt } = window0.current;
                  const dist = (t: number) => (t < vf ? vf - t : t > vt ? t - vt : 0);
                  const drop = [...n.keys()]
                    .filter((t) => dist(t) > 0)
                    .sort((a, b) => dist(b) - dist(a))
                    .slice(0, n.size - CACHE_MAX);
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
  }, [videoPath, wantKey, failed, grab]);

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
        src={assetUrl(videoPath)}
        muted
        preload="auto"
        style={{ display: 'none' }}
        crossOrigin="anonymous"
      />
      {slots.map((slot) => {
        // 取れていなければ、1コマ分より近いもので繋ぐ（空白にすると点滅して見える）
        const url = shots.get(slot.src) ?? nearest(slot.src);
        return (
          <div
            key={slot.at}
            className={`fcp-frame ${url ? '' : 'empty'}`}
            style={{ left: slot.at * scale, width: Math.max(2, step * scale), height }}
          >
            {/*
              🔴 枠いっぱいに広げること。
                 絵の幅（thumbW）と枠の幅（刻み×拡大率）は必ずしも一致しない。
                 絵の実寸で置くと、余った分が隙間になって**コマが飛び飛びに見える**。
                 はみ出す分は左右を切る（object-fit: cover）。
            */}
            {url && <img src={url} alt="" draggable={false} />}
          </div>
        );
      })}
      {failed && <div className="fcp-lane-note">この素材ではコマを出せません</div>}
    </>
  );
}
