/**
 * プレビュー。並べたクリップと、その上に出るテロップを見せる。
 *
 * 🔴 <video> は2枚とも常に置いておくこと。
 *    表になっている方だけを描くと、裏で用意していたものが
 *    毎回作り直しになり、境目で用意が間に合わなくなる（黒くなる）。
 *    重ねて置いて、見せる方を切り替えるだけにする。
 *
 * 🔴 テロップは Canvas に、書き出しと同じコードで描くこと（telopCanvas.ts）。
 *    以前は HTML の div に CSS で置いていた。渡す先が Final Cut だけだった頃は
 *    それでよかったが、PAC 自身が動画を書き出すようになった今は
 *    **画面と書き出しが別物になる**。
 *
 * 🔴 映像とテロップは「プロジェクトの枠」の中に揃えて置くこと。
 *    書き出しは素材をプロジェクトの大きさに収めて（余白を足して）composite する。
 *    プレビューだけ素材の形に合わせると、縦の素材を置いたときに
 *    テロップの位置が画面と書き出しでずれる。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { placedTelops, type Project } from './project';
import {
  DEFAULT_STYLES,
  buildTimelineCards,
  drawCardsAt,
  telopLayout,
  type TelopStyles,
} from './telopCanvas';
import type { TimelinePlayer } from './useTimelinePlayer';

interface Props {
  project: Project;
  player: TimelinePlayer;
  styles?: TelopStyles;
}

const layer: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'contain',
  background: '#000',
};

export function Viewer({ project, player, styles = DEFAULT_STYLES }: Props) {
  const empty = project.clips.length === 0;
  const frame = useMemo(
    () => ({ width: project.settings.width, height: project.settings.height }),
    [project.settings.width, project.settings.height],
  );

  /*
    🔴 札を作り直すのは、テロップか大きさが変わったときだけ。
       毎コマ作り直すと、1枚ごとに文字幅を測ることになって再生が落ちる。
  */
  const cards = useMemo(
    () => buildTimelineCards(placedTelops(project), frame, styles),
    [project, frame, styles],
  );
  const layout = useMemo(() => telopLayout(cards, styles, frame), [cards, styles, frame]);

  /*
    プロジェクトの枠の実寸を出す。

    🔴 CSS の aspect-ratio と max-width/max-height だけでは決まらない。
       幅も高さも auto のままだと中身が無い箱として 0x0 に潰れ、
       **音だけ鳴って何も映らない**（実際にそうなった）。
       どちらか一方を 100% にすると、今度ははみ出す側で比が壊れる。
       入る大きさは掛け算1つで出るので、素直に測って決める。
  */
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      const scale = Math.min(r.width / frame.width, r.height / frame.height);
      if (!Number.isFinite(scale) || scale <= 0) return;
      setBox({
        w: Math.max(1, Math.floor(frame.width * scale)),
        h: Math.max(1, Math.floor(frame.height * scale)),
      });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [frame.width, frame.height]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    drawCardsAt(ctx, cards, layout, styles, frame, player.time);
  }, [cards, layout, styles, frame, player.time]);

  return (
    <div className="tl-viewer">
      <div className="tl-stage" ref={stageRef}>
        <div className="tl-frame" style={{ width: box.w, height: box.h }}>
          <video
            ref={player.aRef}
            style={{ ...layer, opacity: player.frontIsA ? 1 : 0 }}
            playsInline
          />
          <video
            ref={player.bRef}
            style={{ ...layer, opacity: player.frontIsA ? 0 : 1 }}
            playsInline
          />
          {/* 音だけのレーン。画には出さない */}
          <audio ref={player.audioRef} />

          <canvas
            ref={canvasRef}
            className="tl-telop-canvas"
            width={frame.width}
            height={frame.height}
            aria-hidden
          />

          {empty && (
            <div className="tl-stage-empty">
              <p>まだ何も置かれていません。</p>
              <p>
                「取り込み」で下ごしらえ（自動カット・自動テロップ）をしてから並べるか、
                <br />
                「素材を追加」でそのまま置いてください。
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="tl-transport">
        <button onClick={player.toggle} disabled={empty}>
          {player.playing ? '⏸ 一時停止' : '▶ 再生'}
        </button>
        <button onClick={() => player.seek(0)} disabled={empty}>
          ⏮ 先頭
        </button>
        <span className="tl-clock">
          {fmt(player.time)} / {fmt(player.duration)}
        </span>
        <span className="tl-frame-size">
          {frame.width}×{frame.height}
        </span>
      </div>
    </div>
  );
}

/** 分:秒.10分の1 */
function fmt(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(2).padStart(5, '0')}`;
}
