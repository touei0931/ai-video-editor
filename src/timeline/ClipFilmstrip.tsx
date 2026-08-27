/**
 * レーンに並んだクリップの上に、それぞれのコマを敷く。
 *
 * 🔴 クリップごとに <video> を作らないこと（frames.ts が面倒を見る）。
 *    自動カットの結果は同じ素材から数十本のクリップになる。
 *    以前はクリップごとに隠し <video> を持っていたので、
 *    同じファイルを何本ものデコーダが同時に開いて奪い合い、
 *    **一部のクリップだけコマが出なかった**（実機で踏んだ）。
 *
 * 🔴 見えているクリップだけ描くこと。
 *    20分の素材でクリップが200本あっても、画面に出ているのは十数本。
 *
 * 🔴 コマの位置は「タイムラインの時刻」で置き、絵は「素材の中の時刻」で引くこと。
 *    素材の時刻で置くと、途中から使っているクリップでは
 *    その分だけ右へずれた所に絵が出る。
 */

import { useEffect, useSyncExternalStore } from 'react';
import type { TimelineView } from '../shell/Timeline';
import { isGap, type Asset, type PlacedClip } from './project';
import {
  frameAt,
  framesFailed,
  framesVersion,
  requestFrames,
  stepFor,
  subscribeFrames,
} from './frames';

interface Props extends TimelineView {
  clips: readonly PlacedClip[];
  assets: readonly Asset[];
}

export function ClipFilmstrip({ clips, assets, scale, from, to, height }: Props) {
  const byId = new Map(assets.map((a) => [a.id, a]));

  const visible = clips.filter(
    (c) => !isGap(c) && c.end >= from - 0.001 && c.start <= to + 0.001,
  );

  /*
    素材ごとに「欲しい時刻」をまとめて伝える。
    🔴 クリップごとに伝えないこと。あとから伝えたクリップが前のを打ち消して、
       画面の左半分だけ絵が出る、という形になる。
  */
  const wants = new Map<string, { times: number[]; aspect: number }>();
  const placement: { clip: PlacedClip; path: string; step: number; slots: number[] }[] = [];

  for (const c of visible) {
    const asset = byId.get(c.assetId);
    if (!asset || !asset.hasVideo) continue;
    const aspect = asset.width && asset.height ? asset.width / asset.height : 16 / 9;
    const step = stepFor(scale, Math.round(height * aspect));

    // 見えている範囲に絞る。クリップ全体を作ると、拡大時に何百枚にもなる
    const lo = Math.max(c.start, from - step);
    const hi = Math.min(c.end, to + step);
    const slots: number[] = [];
    for (let t = Math.floor(lo / step) * step; t < hi; t += step) {
      if (t + step <= c.start || t >= c.end) continue;
      slots.push(Number(t.toFixed(2)));
    }
    if (slots.length === 0) continue;

    placement.push({ clip: c, path: asset.path, step, slots });

    const entry = wants.get(asset.path) ?? { times: [], aspect };
    for (const at of slots) {
      // タイムラインの時刻 → 素材の中の時刻
      entry.times.push(Number((c.srcStart + (at - c.start)).toFixed(2)));
    }
    wants.set(asset.path, entry);
  }

  const wantKey = [...wants.entries()].map(([p, w]) => `${p}:${w.times.join(',')}`).join('|');

  useEffect(() => {
    for (const [path, w] of wants) {
      requestFrames(path, w.times, { w: Math.round(height * w.aspect), h: Math.round(height) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantKey, height]);

  /*
    取り出しは非同期に進む。出来たことを React に伝える道が要る。
    🔴 useState で数えるとレンダー中に setState することになる。
       useSyncExternalStore なら、店（frames.ts）の変化をそのまま購読できる。
  */
  const paths = [...wants.keys()].join('|');
  const revision = useSyncExternalStore(
    (cb) => {
      const offs = paths ? paths.split('|').map((p) => subscribeFrames(p, cb)) : [];
      return () => offs.forEach((off) => off());
    },
    framesVersion,
  );
  void revision;

  return (
    <>
      {placement.map(({ clip, path, step, slots }) => {
        const failed = framesFailed(path);
        return (
          <div key={clip.id} className="tl-strip" style={{ left: clip.start * scale, width: Math.max(1, (clip.end - clip.start) * scale), height }} aria-hidden>
            {slots.map((at) => {
              const src = clip.srcStart + (at - clip.start);
              const url = frameAt(path, src, step);
              // 帯の中での位置。左へはみ出す分は切る
              const left = (at - clip.start) * scale;
              return (
                <div
                  key={at}
                  className={`fcp-frame ${url ? '' : 'empty'}`}
                  style={{ left, width: Math.max(2, step * scale), height }}
                >
                  {url && <img src={url} alt="" draggable={false} />}
                </div>
              );
            })}
            {failed && <div className="fcp-lane-note">この素材ではコマを出せません</div>}
          </div>
        );
      })}
    </>
  );
}
