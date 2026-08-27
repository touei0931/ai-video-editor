/**
 * レーンに並んだクリップの上に、それぞれの音の波を敷く。
 *
 * 🔴 喋り主体の動画では、コマより波形のほうが効く。
 *    同じ人が10分喋っている素材のコマは、どこを見ても同じ顔で情報量が無い。
 *    切れ目の良し悪しは「波が立ち上がる直前で切れているか」で、
 *    再生しなくても目で判断できる。
 *
 * 🔴 素材ごとに一度だけ読むこと（peaks.ts が面倒を見る）。
 *    自動カットの結果は同じ素材から数十本のクリップになる。
 *
 * 🔴 見えているクリップだけ描くこと。
 *    20分の素材でクリップが200本あっても、画面に出ているのは十数本。
 */

import { useEffect, useRef, useState } from 'react';
import type { TimelineView } from '../shell/Timeline';
import { isGap, type Asset, type PlacedClip } from './project';
import { assetPeaks, drawPeaks, peaksNow, type Peaks } from './peaks';

interface Props extends TimelineView {
  clips: readonly PlacedClip[];
  assets: readonly Asset[];
  /** 波の色。音だけのレーンと、映像の下に敷くときで変える */
  color?: string;
  /**
   * 段のどちら側に寄せるか。
   * 映像のレーンではコマの上に重ねるので、下に寄せて絵を隠さないようにする。
   */
  align?: 'top' | 'bottom';
}

export function ClipWaveform({
  clips,
  assets,
  scale,
  from,
  to,
  height,
  color,
  align = 'top',
}: Props) {
  const byId = new Map(assets.map((a) => [a.id, a]));

  const visible = clips.filter(
    (c) => !isGap(c) && c.end >= from - 0.001 && c.start <= to + 0.001,
  );

  /*
    読み込みが済んだ素材を数える。
    🔴 これを state に持たないと、読み終わっても描き直されない。
       波形は非同期に来るのに、描くのは同期の useEffect なので、
       「読めたこと」を React に知らせる道が要る。
  */
  const [done, setDone] = useState(0);
  useEffect(() => {
    let alive = true;
    const paths = [...new Set(visible.map((c) => byId.get(c.assetId)?.path).filter(Boolean))];
    for (const path of paths as string[]) {
      if (peaksNow(path)) continue;
      assetPeaks(path)
        .then(() => {
          if (alive) setDone((n) => n + 1);
        })
        .catch(() => {
          /* 読めない素材は静かに諦める。偽の波を描くよりまし */
        });
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.map((c) => c.assetId).join(','), assets]);

  return (
    <>
      {visible.map((c) => {
        const asset = byId.get(c.assetId);
        if (!asset || !asset.hasAudio) return null;
        const peaks = peaksNow(asset.path);
        const left = c.start * scale;
        const width = Math.max(1, (c.end - c.start) * scale);
        return (
          <Band
            key={c.id}
            peaks={peaks}
            from={c.srcStart}
            to={c.srcEnd}
            left={left}
            width={width}
            height={height}
            color={color ?? 'rgba(160, 200, 255, 0.75)'}
            align={align}
            revision={done}
          />
        );
      })}
    </>
  );
}

function Band({
  peaks,
  from,
  to,
  left,
  width,
  height,
  color,
  align,
  revision,
}: {
  peaks: Peaks | null;
  from: number;
  to: number;
  left: number;
  width: number;
  height: number;
  color: string;
  align: 'top' | 'bottom';
  revision: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(width));
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(height * dpr);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, height);
    if (peaks) drawPeaks(ctx, peaks, from, to, w, height, color);
  }, [peaks, from, to, width, height, color, revision]);

  return (
    <canvas
      ref={ref}
      className={`tl-wave${align === 'bottom' ? ' tl-wave-bottom' : ''}`}
      style={{ left, width: Math.max(1, width), height }}
      aria-hidden
    />
  );
}
