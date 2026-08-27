/**
 * レーンに並んだクリップの上に、それぞれのコマを敷く。
 *
 * 既存の Filmstrip は「1本の素材」を前提にしている（そのために作られた）。
 * こちらのタイムラインは1つのレーンに複数の素材が並ぶので、
 * **クリップごとに1枚ずつ**敷いて、まとめて1本の帯に見せる。
 *
 * 🔴 見えているクリップだけ作ること。
 *    Filmstrip は1つにつき隠した <video> を1つ持つ。全部作ると、
 *    自動カットの結果（数十本）でその数だけ動画を抱えることになる。
 *
 * 🔴 中身は素材の時刻で並んでいる。ずらして合わせること。
 *    Filmstrip はコマを「素材の中の時刻 × 倍率」の位置に置く。
 *    素材の途中から使っているクリップでは、その分だけ左にずらさないと
 *    絵と帯が食い違う（30秒の素材の20秒目を頭に置いたクリップなら、
 *    20秒ぶん右にはみ出したところに絵が出てしまう）。
 */

import { Filmstrip } from '../shell/Filmstrip';
import type { TimelineView } from '../shell/Timeline';
import { isGap, type Asset, type PlacedClip } from './project';

interface Props extends TimelineView {
  clips: readonly PlacedClip[];
  assets: readonly Asset[];
}

export function ClipFilmstrip({ clips, assets, scale, from, to, height, duration }: Props) {
  const byId = new Map(assets.map((a) => [a.id, a]));

  return (
    <>
      {clips.map((c) => {
        if (isGap(c)) return null;
        // 見えている範囲に少しでもかかっているものだけ
        if (c.end < from - 0.001 || c.start > to + 0.001) return null;
        const asset = byId.get(c.assetId);
        if (!asset) return null;

        const left = c.start * scale;
        const width = Math.max(1, (c.end - c.start) * scale);
        return (
          <div
            key={c.id}
            className="tl-strip"
            style={{ left, width, height }}
            aria-hidden
          >
            <div
              className="tl-strip-inner"
              style={{ transform: `translateX(${-c.srcStart * scale}px)` }}
            >
              <Filmstrip
                videoPath={asset.path}
                scale={scale}
                from={c.srcStart}
                to={c.srcEnd}
                height={height}
                duration={asset.duration}
              />
            </div>
          </div>
        );
      })}
      {/* duration は使わないが、受け取る形を TimelineView に合わせておく */}
      {duration < 0 ? null : null}
    </>
  );
}
