/**
 * 再生まわりの操作。プレビューのある画面はすべてこれを使う。
 *
 * 🔴 音量は必ず出すこと。
 *    素材の録音レベルはまちまちで、既定のままだと大きすぎることがある。
 *    毎回OSの音量を触らせるのは道具として不親切（友達の指摘）。
 *
 * 🔴 音量と消音は覚えておくこと（useEditedPlayer が保存する）。
 *    画面を移るたびに戻ると、そのたびに下げ直すことになる。
 */

import type { EditedPlayer } from './useEditedPlayer';
import { clock } from './Timeline';

const RATES = [0.5, 1, 1.5, 2];

export interface TransportProps {
  player: EditedPlayer;
  fps: number;
  /** 左端に置く追加の操作（表示の切り替えなど） */
  children?: React.ReactNode;
  /** 右端に置く情報（件数など） */
  info?: React.ReactNode;
}

export function Transport({ player, fps, children, info }: TransportProps) {
  const { time, duration, playing, volume, muted, rate } = player;

  return (
    <>
      {children}

      <button className="icon" onClick={() => player.seek(0)} title="先頭（Home）">
        ⏮
      </button>
      <button
        className="icon"
        onClick={() => player.seek(Math.max(0, time - 1 / fps))}
        title="1コマ戻る（←）"
      >
        ◁
      </button>
      <button className="icon" onClick={player.toggle} title="再生 / 一時停止（Space）">
        {playing ? '⏸' : '▶'}
      </button>
      <button
        className="icon"
        onClick={() => player.seek(Math.min(duration, time + 1 / fps))}
        title="1コマ進む（→）"
      >
        ▷
      </button>
      <button className="icon" onClick={() => player.seek(duration)} title="末尾（End）">
        ⏭
      </button>

      <span className="fcp-time">
        <strong>{clock(time)}</strong> / {clock(duration)}
      </span>

      {/* 再生速度 */}
      <div className="fcp-rate" title="再生速度">
        {RATES.map((r) => (
          <button
            key={r}
            className={Math.abs(rate) === r ? 'on' : ''}
            onClick={() => player.setRate(r)}
          >
            {r}×
          </button>
        ))}
      </div>

      {/* 音量 */}
      <div className="fcp-volume">
        <button
          className="icon"
          onClick={() => player.setMuted(!muted)}
          title={muted ? '音を出す' : '音を消す'}
          aria-pressed={muted}
        >
          {muted || volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={muted ? 0 : volume}
          onChange={(e) => {
            player.setVolume(Number(e.target.value));
            if (muted) player.setMuted(false);
          }}
          aria-label="音量"
          title={`音量 ${Math.round((muted ? 0 : volume) * 100)}%`}
        />
        <span className="fcp-dim" style={{ minWidth: 34, textAlign: 'right' }}>
          {Math.round((muted ? 0 : volume) * 100)}%
        </span>
      </div>

      <div className="fcp-spacer" />
      {info}
    </>
  );
}
