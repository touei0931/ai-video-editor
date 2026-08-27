/**
 * 通し確認の段階。書き出す前に、出来上がりをそのまま見る。
 *
 * 🔴 他の段階と同じ骨格・同じタイムラインにすること。
 *    ここだけ別の作りにすると、最後の最後で操作を覚え直すことになる
 *    （友達の「他の編集ソフトと違い過ぎて違和感」と同じ問題）。
 *
 * 🔴 ここで見えているものが、そのまま書き出される。
 *    カットは飛ばし、テロップは同じ drawTelop で重ね、BGM も鳴らす。
 *    ここと書き出しがずれると、確認した意味が無くなる。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorShell } from './EditorShell';
import { Timeline, clock, type TimelineRegion } from './Timeline';
import { Transport } from './Transport';
import { Waveform } from './Waveform';
import { Filmstrip } from './Filmstrip';
import { useEditedPlayer } from './useEditedPlayer';
import { buildSegments, toOutput, toSource } from './editedTime';
import { isTyping, matchShortcut, nextShuttle } from './shortcuts';
import { mediaUrl } from './media';
import type { MusicTrack } from './TelopStage';
import type { ExportOptions } from '../telop/TelopScreen';
import { buildLines, drawTelop, type Frame } from '../telop/render';
import { resolveStyle, type StyleMap } from '../telop/style';
import type { TelopCard } from '../telop/split';

export interface FinalStageProps {
  videoPath: string;
  frame: Frame;
  duration: number;
  fps?: number;
  cuts: { srcStart: number; srcEnd: number }[];
  cards: TelopCard[];
  styles: StyleMap;
  audioPath?: string;
  music?: MusicTrack | null;
  /**
   * 人物アップに寄らなかった理由と件数。
   * 🔴 これを出さないと「なぜアップにならないのか」が分からず、不具合に見える。
   */
  skipped?: Record<string, number>;
  onBack(): void;
  onQuit?(): void;
  onExport(): void;
  /**
   * 下ごしらえの結果を、並べる画面へ送る。
   * 🔴 書き出しとは別のボタンにすること。ここで送るのは「素材の下ごしらえ」で、
   *    動画になるわけではない。同じボタンにすると、送ったのに何も出てこないと見える。
   */
  onSendToTimeline?(): void;
  exporting?: boolean;
  /**
   * 何を書き出すか。
   *
   * 🔴 画面から変えられるようにしておくこと。
   *    既定のまま隠していたので、**Final Cut 用のタイムラインを出す手段が
   *    どこにも無かった**。このアプリは Final Cut へ渡すためのものなので、
   *    それが出せないと存在意義ごと欠ける。
   */
  options: ExportOptions;
  onOptionsChange(o: ExportOptions): void;
}

export function FinalStage({
  videoPath,
  frame,
  duration,
  fps = 30,
  cuts,
  cards,
  styles,
  audioPath,
  music,
  skipped,
  onBack,
  onQuit,
  onExport,
  onSendToTimeline,
  exporting,
  options,
  onOptionsChange,
}: FinalStageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const segments = useMemo(() => buildSegments(duration, cuts), [duration, cuts]);

  const player = useEditedPlayer({
    duration,
    cuts,
    // 🔴 ここは常に出来上がりを見る場所。切った場所は必ず飛ばす
    skipCuts: true,
    timeBase: 'edited',
    music: music ?? null,
    musicUrl: music ? mediaUrl(music.path) : null,
    reverseAudioPath: audioPath ? mediaUrl(audioPath) : null,
  });
  const { videoRef, audioRef } = player;

  /** 表示している時刻（出来上がり）→ 元素材の時刻 */
  const srcTime = segments.length ? toSource(segments, player.time) : player.time;

  const showing = useMemo(
    () => cards.find((c) => srcTime >= c.srcStart && srcTime < c.srcEnd) ?? null,
    [cards, srcTime],
  );

  /* ---------- 画面を描く ---------- */

  const paint = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    if (cv.width !== frame.width || cv.height !== frame.height) {
      cv.width = frame.width;
      cv.height = frame.height;
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    const v = videoRef.current;
    if (v && v.readyState >= 2) ctx.drawImage(v, 0, 0, cv.width, cv.height);
    else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cv.width, cv.height);
    }

    if (!showing) return;
    // 🔴 書き出しと同じ順序で通す（resolveStyle → buildLines → drawTelop）
    const style = resolveStyle(styles, showing.style, showing.override, showing.fontScale);
    drawTelop(
      ctx,
      {
        lines: buildLines(showing.lines, showing.highlight ?? undefined, style),
        style,
        position: showing.positionOverride ?? style.position,
        offsetX: showing.offsetX,
        offsetY: showing.offsetY,
      },
      frame,
    );
  }, [showing, styles, frame, videoRef]);

  useEffect(() => {
    paint();
  }, [paint, player.time]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const redraw = () => paint();
    for (const ev of ['loadeddata', 'seeked', 'canplay', 'timeupdate']) {
      v.addEventListener(ev, redraw);
    }
    return () => {
      for (const ev of ['loadeddata', 'seeked', 'canplay', 'timeupdate']) {
        v.removeEventListener(ev, redraw);
      }
    };
  }, [paint, videoRef]);

  useEffect(() => {
    if (!player.playing) return;
    let id = 0;
    const loop = () => {
      paint();
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [player.playing, paint]);

  /* ---------- タイムライン ---------- */

  const telopRegions = useMemo<TimelineRegion[]>(
    () =>
      cards.map((c) => ({
        id: c.id,
        start: segments.length ? toOutput(segments, c.srcStart) : c.srcStart,
        end: segments.length ? toOutput(segments, c.srcEnd) : c.srcEnd,
        kind: 'telop',
        label: c.text,
        fixed: true, // ここは確認するだけ。直すのはテロップの段階
      })),
    [cards, segments],
  );

  const musicRegions = useMemo<TimelineRegion[]>(
    () =>
      music
        ? [
            {
              id: 'music',
              start: music.start,
              end: player.duration,
              kind: 'music',
              label: `♪ ${music.path.split(/[\\/]/).pop() ?? 'BGM'}`,
              fixed: true,
            },
          ]
        : [],
    [music, player.duration],
  );

  /* ---------- キー操作 ---------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const action = matchShortcut(e);
      if (!action) return;
      e.preventDefault();
      switch (action) {
        case 'playPause':
          player.toggle();
          break;
        case 'shuttleForward':
          player.shuttle(nextShuttle(player.rate * (player.playing ? 1 : 0), true));
          break;
        case 'shuttleBack':
          player.shuttle(nextShuttle(player.rate * (player.playing ? 1 : 0), false));
          break;
        case 'stop':
          player.shuttle(0);
          break;
        case 'frameBack':
          player.seek(Math.max(0, player.time - 1 / fps));
          break;
        case 'frameForward':
          player.seek(Math.min(player.duration, player.time + 1 / fps));
          break;
        case 'jumpBack':
          player.seek(Math.max(0, player.time - 10 / fps));
          break;
        case 'jumpForward':
          player.seek(Math.min(player.duration, player.time + 10 / fps));
          break;
        case 'home':
          player.seek(0);
          break;
        case 'end':
          player.seek(player.duration);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [player, fps]);

  const cutSeconds = cuts.reduce((a, c) => a + (c.srcEnd - c.srcStart), 0);

  return (
    <EditorShell
      step="export"
      done={['source', 'cut', 'telop', 'framing']}
      toolbar={
        <>
          <button onClick={onBack}>← テロップに戻る</button>
          {onQuit && (
            <button className="danger" onClick={onQuit}>
              編集をやめる
            </button>
          )}
          {onSendToTimeline && (
            <button onClick={onSendToTimeline} disabled={exporting} title="並べる画面へ送ります">
              タイムラインに送る
            </button>
          )}
          <button className="go" onClick={onExport} disabled={exporting}>
            {exporting ? '書き出し中…' : '書き出す →'}
          </button>
        </>
      }
      viewer={
        <>
          <video ref={videoRef} src={mediaUrl(videoPath)} style={{ display: 'none' }} />
          <audio ref={audioRef} style={{ display: 'none' }} />
          <canvas ref={canvasRef} className="fcp-stage-inner" />
        </>
      }
      transport={
        <Transport
          player={player}
          fps={fps}
          info={
            <>
              <span className="fcp-chip">テロップ {cards.length}</span>
              <span className="fcp-chip">−{cutSeconds.toFixed(1)}秒</span>
              {music && <span className="fcp-chip">♪ BGM</span>}
            </>
          }
        />
      }
      inspectorTitle="書き出す前の確認"
      inspector={
        <>
          <div className="fcp-field">
            <label>出来上がりの長さ</label>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{clock(player.duration)}</div>
            <div className="fcp-dim">
              元の素材 {clock(duration)} から {cutSeconds.toFixed(1)} 秒を切ります
            </div>
          </div>

          <div className="fcp-field">
            <label>入るもの</label>
            <div>カット {cuts.length} 箇所</div>
            <div>テロップ {cards.length} 枚</div>
            <div>BGM {music ? 'あり' : 'なし'}</div>
          </div>

          {skipped && Object.keys(skipped).length > 0 && (
            <div className="fcp-field">
              <label>人物アップに寄らなかった理由</label>
              {Object.entries(skipped).map(([reason, n]) => (
                <div key={reason} className="fcp-dim">
                  {reason}: {n} 箇所
                </div>
              ))}
            </div>
          )}

          <div className="fcp-field">
            <label>書き出すもの</label>
            <label className="fcp-check">
              <input
                type="checkbox"
                checked={options.burn}
                onChange={(e) => onOptionsChange({ ...options, burn: e.target.checked })}
              />{' '}
              動画に文字を入れる
            </label>
            <label className="fcp-check">
              <input
                type="checkbox"
                checked={options.srt}
                onChange={(e) => onOptionsChange({ ...options, srt: e.target.checked })}
              />{' '}
              字幕ファイル（.srt）も作る
            </label>
            <label className="fcp-check">
              <input
                type="checkbox"
                checked={options.fcpxml}
                onChange={(e) => onOptionsChange({ ...options, fcpxml: e.target.checked })}
              />{' '}
              Final Cut 用（.fcpxml）も作る
            </label>
            <p className="fcp-dim">
              Final Cut 用は、カットとテロップが入ったタイムラインです。
              書き出したファイルの隣に「〜_フォント」のフォルダも作るので、
              初回だけ中の書体を入れてください（入れないと別の書体で開きます）。
            </p>
          </div>

          <p className="fcp-dim">
            ここで見えているものが、そのまま書き出されます。
            気になるところがあれば「テロップに戻る」で直してください。
          </p>

          <div className="fcp-field">
            <button className="go" onClick={onExport} disabled={exporting}>
              {exporting ? '書き出し中…' : '書き出す'}
            </button>
          </div>
        </>
      }
      timeline={
        <Timeline
          duration={player.duration}
          fps={fps}
          currentTime={player.time}
          onSeek={player.seek}
          selectedId={selected}
          onSelect={setSelected}
          tracks={[
            {
              id: 'film',
              label: 'コマ',
              regions: [],
              height: 46,
              render: (v) => (
                <Filmstrip
                  {...v}
                  videoPath={videoPath}
                  aspect={frame.width / frame.height}
                  segments={segments}
                />
              ),
            },
            { id: 'telop', label: 'テロップ', regions: telopRegions, height: 40 },
            {
              id: 'wave',
              label: '音',
              regions: [],
              height: 50,
              render: (v) => <Waveform {...v} audioPath={audioPath} />,
            },
            { id: 'music', label: 'BGM', regions: musicRegions, height: 32 },
          ]}
        />
      }
    />
  );
}
