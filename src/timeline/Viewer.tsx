/**
 * プレビュー。並べたクリップと、その上に出るテロップを見せる。
 *
 * 🔴 <video> は2枚とも常に置いておくこと。
 *    表になっている方だけを描くと、裏で用意していたものが
 *    毎回作り直しになり、境目で用意が間に合わなくなる（黒くなる）。
 *    重ねて置いて、見せる方を切り替えるだけにする。
 */

import type { CSSProperties } from 'react';
import { telopsAt, type Project } from './project';
import type { TimelinePlayer } from './useTimelinePlayer';

interface Props {
  project: Project;
  player: TimelinePlayer;
}

const layer: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'contain',
  background: '#000',
};

export function Viewer({ project, player }: Props) {
  const showing = telopsAt(project, player.time);
  const empty = project.clips.length === 0;

  return (
    <div className="tl-viewer">
      <div className="tl-stage">
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

        {/*
          テロップ。
          🔴 見た目は「だいたいの位置」でよい。ここは中身と長さを確かめる場所で、
             正確な見え方は書き出し先（Final Cut）の雛形が決める。
        */}
        <div className="tl-telops">
          {showing.map((t) => (
            <div key={`${t.id}-${t.clipId}`} className={`tl-telop ${t.style}`}>
              {t.text}
            </div>
          ))}
        </div>

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
