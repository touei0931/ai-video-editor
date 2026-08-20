/**
 * 通し確認（設計レポート §3.3.4）。
 *
 * 🔴 書き出す前に一度通しで見られること。
 *    1件ずつのレビューで分かるのは「その繋ぎ目が自然か」だけで、
 *    「カット後に話のテンポがどうなったか」は通してみないと分からない。
 *    実際の編集でも、書き出す前に必ず1回通す。
 *
 * 🔴 プロキシ動画を書き出してから見せる方式にはしない。
 *    それでは本番の書き出しとほぼ同じ待ち時間がかかり、
 *    「確認してから書き出す」が二度手間になって使われなくなる。
 *    元素材を再生しながらカット区間を飛ばせば、待ち時間ゼロで確認できる。
 *    飛ぶ瞬間に一瞬引っかかるが、テンポの確認には十分。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildLines, drawTelop } from '../telop/render';
import { resolveStyle, SAFE_AREA_RATIO } from '../telop/style';
import type { Frame, TelopCard } from '../telop/split';
import type { StyleMap } from '../telop/TelopScreen';
import './preview.css';

export interface Keep {
  start: number;
  end: number;
}

/** 元素材の正規化座標（0〜1）で表した切り出し範囲 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 人物アップに寄る1ショット（③ズーム・画角の自動化） */
export interface Shot {
  src_start: number;
  src_end: number;
  kind: string;
  reason: string;
  rect: Rect;
  enabled: boolean;
}

const WIDE: Rect = { x: 0, y: 0, w: 1, h: 1 };

/** カット区間から残る区間を求める（sidecar/cut.py の keep_ranges と同じ） */
export function keepRanges(duration: number, cuts: { srcStart: number; srcEnd: number }[]): Keep[] {
  if (cuts.length === 0) return [{ start: 0, end: duration }];

  const merged: Keep[] = [];
  for (const c of [...cuts].sort((a, b) => a.srcStart - b.srcStart)) {
    const last = merged[merged.length - 1];
    if (last && c.srcStart <= last.end + 0.001) last.end = Math.max(last.end, c.srcEnd);
    else merged.push({ start: c.srcStart, end: c.srcEnd });
  }

  const keeps: Keep[] = [];
  let cursor = 0;
  for (const m of merged) {
    if (m.start - cursor > 0.02) keeps.push({ start: cursor, end: m.start });
    cursor = Math.max(cursor, m.end);
  }
  if (duration - cursor > 0.02) keeps.push({ start: cursor, end: duration });
  return keeps;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const SPEEDS = [1, 1.3, 1.5, 2];

export interface PreviewScreenProps {
  videoPath: string;
  frame: Frame;
  duration: number;
  cuts: { srcStart: number; srcEnd: number }[];
  cards: TelopCard[];
  styles: StyleMap;
  /** 人物アップに寄るショット。空なら常に引き */
  shots: Shot[];
  /** 寄らなかった理由と件数 */
  skipped?: Record<string, number>;
  onShotsChange: (shots: Shot[]) => void;
  onBack: () => void;
  /** 編集をやめて動画の選択に戻る */
  onQuit?: () => void;
  onExport: () => void;
}

export function PreviewScreen({
  videoPath,
  frame,
  duration,
  cuts,
  cards,
  styles,
  shots,
  skipped,
  onShotsChange,
  onBack,
  onQuit,
  onExport,
}: PreviewScreenProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  /** 今どのテロップを描いているか。毎フレーム描き直さないための記録 */
  const drawnRef = useRef<string | null>(null);

  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(true);
  /** ズームをまとめて切る。使わない人は一括で外せたほうが早い */
  const [useZoom, setUseZoom] = useState(true);

  const activeShots = useMemo(
    () => (useZoom ? shots.filter((s) => s.enabled) : []),
    [shots, useZoom],
  );

  const keeps = useMemo(() => keepRanges(duration, cuts), [duration, cuts]);
  const keptTotal = useMemo(() => keeps.reduce((a, k) => a + (k.end - k.start), 0), [keeps]);

  /**
   * カットで繋いだ位置（編集後タイムラインの時刻）。
   *
   * 🔴 書き出したあとに「どこを切ったか」を確かめる手段が要る。
   *    切った箇所は映像から消えているので、印を出さないと二度と辿れない。
   */
  const joins = useMemo(() => {
    const out: { at: number; cut: number }[] = [];
    let acc = 0;
    for (let i = 0; i < keeps.length - 1; i++) {
      acc += keeps[i].end - keeps[i].start;
      out.push({ at: acc, cut: keeps[i + 1].start - keeps[i].end });
    }
    return out;
  }, [keeps]);

  /** 元素材の時刻 → 編集後タイムラインの時刻 */
  const toOutputTime = useCallback(
    (t: number) => {
      let acc = 0;
      for (const k of keeps) {
        if (t < k.start) return acc;
        if (t <= k.end) return acc + (t - k.start);
        acc += k.end - k.start;
      }
      return acc;
    },
    [keeps],
  );

  /**
   * カット区間に入っていたら次の残存区間へ飛ぶ。
   *
   * 🔴 requestAnimationFrame だけに任せてはいけない。
   *    ウィンドウが他のウィンドウに隠れると Chromium は rAF を止める。
   *    止まった間はカット区間が飛ばされず、切ったはずの音がそのまま流れる。
   *    timeupdate は隠れていても 4回/秒 ほど届くので、こちらからも呼ぶ。
   */
  const skipCuts = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.paused) return;
    const t = video.currentTime;
    const keep = keeps.find((k) => t >= k.start && t < k.end);
    if (keep) return;
    const next = keeps.find((k) => k.start > t);
    if (next) video.currentTime = next.start;
    else video.pause();
  }, [keeps]);

  /**
   * 毎フレーム、カット区間に入っていたら次の残存区間へ飛ぶ。
   * あわせて、その時刻に出るテロップを描く。
   */
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const video = videoRef.current;
      if (video && !video.paused) {
        const t = video.currentTime;

        skipCuts();

        // その時刻に出るテロップ
        const card = cards.find((c) => t >= c.srcStart && t <= c.srcEnd) ?? null;
        const key = card?.id ?? null;
        if (key !== drawnRef.current) {
          drawnRef.current = key;
          const canvas = canvasRef.current;
          const ctx = canvas?.getContext('2d');
          if (canvas && ctx) {
            ctx.clearRect(0, 0, frame.width, frame.height);
            if (card) {
              // 🔴 書き出しと同じ resolveStyle / buildLines / drawTelop を通す
              const resolved = resolveStyle(styles, card.style, card.override, card.fontScale);
              drawTelop(
                ctx,
                {
                  lines: buildLines(card.lines, card.highlight ?? undefined, resolved),
                  style: resolved,
                  position: card.positionOverride ?? resolved.position,
                  offsetX: card.offsetX,
                  offsetY: card.offsetY,
                },
                frame,
              );
            }
          }
        }

        // ③ズーム・画角の自動化。書き出しでは crop するが、
        // ここでは元映像を CSS で拡大してずらすだけで同じ見え方になる。
        const shot = activeShots.find((sh) => t >= sh.src_start && t < sh.src_end);
        const rect = shot?.rect ?? WIDE;
        const video2 = videoRef.current;
        if (video2) {
          if (rect.w >= 0.999) {
            video2.style.transform = '';
          } else {
            video2.style.transformOrigin = '0 0';
            video2.style.transform =
              `scale(${(1 / rect.w).toFixed(4)}) translate(${(-rect.x * 100).toFixed(2)}%, ${(-rect.y * 100).toFixed(2)}%)`;
          }
        }

        const out = toOutputTime(t);
        if (barRef.current) barRef.current.style.width = `${(out / Math.max(0.1, keptTotal)) * 100}%`;
        if (labelRef.current) {
          labelRef.current.textContent = `${formatTime(out)} / ${formatTime(keptTotal)}`;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [skipCuts, cards, styles, frame, toOutputTime, keptTotal, activeShots]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.playbackRate = speed;
  }, [speed]);

  const toggle = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => undefined);
      setPlaying(true);
    } else {
      video.pause();
      setPlaying(false);
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        toggle();
        e.preventDefault();
      }
    };
    const onMenu = (e: Event) => {
      if ((e as CustomEvent<string>).detail === 'export') onExport();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('app:menu-action', onMenu);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('app:menu-action', onMenu);
    };
  }, [toggle, onExport]);

  /** バーの位置（0〜1）を編集後タイムラインの割合にする */
  const pct = useCallback(
    (outTime: number) => (outTime / Math.max(0.1, keptTotal)) * 100,
    [keptTotal],
  );

  /** バーを押した位置へ飛ぶ。編集後の時刻から元素材の時刻に戻して探す。 */
  const seekTo = useCallback(
    (e: React.MouseEvent<HTMLSpanElement>) => {
      const video = videoRef.current;
      if (!video) return;
      const box = e.currentTarget.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width));
      let want = ratio * keptTotal;
      for (const k of keeps) {
        const length = k.end - k.start;
        if (want <= length) {
          video.currentTime = k.start + want;
          return;
        }
        want -= length;
      }
      video.currentTime = keeps[keeps.length - 1]?.end ?? 0;
    },
    [keeps, keptTotal],
  );

  const start = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = keeps[0]?.start ?? 0;
    video.playbackRate = speed;
    void video.play().catch(() => undefined);
    setPlaying(true);
  }, [keeps, speed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = frame.width;
      canvas.height = frame.height;
    }
  }, [frame.width, frame.height]);

  return (
    <div className="fullpreview">
      <header>
        <span className="counter">
          通し確認 <strong>{formatTime(keptTotal)}</strong>
          <span className="muted">
            {' '}
            （元 {formatTime(duration)} から {Math.round((1 - keptTotal / duration) * 100)}% 短縮）
          </span>
        </span>
        <div className="grow" />
        {shots.length > 0 && (
          <label className="opt" title="人物アップへの切り替えをまとめて止めます">
            <input type="checkbox" checked={useZoom} onChange={(e) => setUseZoom(e.target.checked)} />
            人物アップ {shots.filter((s) => s.enabled).length}/{shots.length}
          </label>
        )}
        <button onClick={onBack}>テロップに戻る</button>
        {onQuit && <button onClick={onQuit}>編集をやめる</button>}
        <button className="primary" onClick={onExport}>
          書き出す
        </button>
      </header>

      <div className="stage">
        <div className="canvas-wrap" style={{ aspectRatio: `${frame.width} / ${frame.height}` }}>
          <video
            ref={videoRef}
            className="bg"
            src={`media://local/${encodeURIComponent(videoPath.replace(/\\/g, '/'))}`}
            playsInline
            preload="auto"
            onLoadedMetadata={start}
            onTimeUpdate={skipCuts}
            onClick={toggle}
          />
          <canvas ref={canvasRef} className="overlay" />
          <div className="safe-area" aria-hidden>
            <span className="band top" style={{ height: `${SAFE_AREA_RATIO.top * 100}%` }} />
            <span className="band bottom" style={{ height: `${SAFE_AREA_RATIO.bottom * 100}%` }} />
          </div>
        </div>

        <div className="controls">
          <button onClick={toggle}>{playing ? '一時停止' : '再生'}</button>
          <button onClick={start}>最初から</button>
          <span className="bar" onClick={seekTo} title="押すとその位置へ飛びます">
            {/* 人物アップの区間。押すとその1回だけ止められる */}
            {useZoom &&
              shots.map((sh, i) => (
                <button
                  key={`z${i}`}
                  type="button"
                  className={`shot ${sh.enabled ? 'on' : ''}`}
                  title={`人物アップ（${sh.reason}）：${sh.src_start.toFixed(1)}秒から${(sh.src_end - sh.src_start).toFixed(1)}秒。押すとこの1回だけ止めます`}
                  style={{
                    left: `${pct(toOutputTime(sh.src_start))}%`,
                    width: `${Math.max(0.4, pct(toOutputTime(sh.src_end)) - pct(toOutputTime(sh.src_start)))}%`,
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onShotsChange(shots.map((x, j) => (j === i ? { ...x, enabled: !x.enabled } : x)));
                  }}
                />
              ))}

            {/* テロップが出ている区間 */}
            {cards.map((c) => (
              <span
                key={`t${c.id}`}
                className="tel"
                title={`テロップ「${c.text}」`}
                style={{
                  left: `${pct(toOutputTime(c.srcStart))}%`,
                  width: `${Math.max(0.3, pct(toOutputTime(c.srcEnd)) - pct(toOutputTime(c.srcStart)))}%`,
                }}
              />
            ))}

            {/* カットで繋いだ位置 */}
            {joins.map((j, i) => (
              <span
                key={`c${i}`}
                className="join"
                title={`ここで ${j.cut.toFixed(1)} 秒カットしました`}
                style={{ left: `${pct(j.at)}%` }}
              />
            ))}

            <span ref={barRef} className="played" />
          </span>
          <span ref={labelRef} className="time">
            0:00 / {formatTime(keptTotal)}
          </span>
          <span className="speeds">
            {SPEEDS.map((s) => (
              <button key={s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)}>
                {s}x
              </button>
            ))}
          </span>
        </div>

        <div className="legend">
          <span className="k-join">
            <i />
            カットで繋いだ位置 {joins.length}箇所
          </span>
          <span className="k-tel">
            <i />
            テロップ {cards.length}枚
          </span>
          {shots.length > 0 && (
            <span className="k-zoom">
              <i />
              人物アップ {shots.filter((s) => s.enabled).length}箇所
            </span>
          )}
          <span>バーを押すとその位置へ飛びます</span>
        </div>

        <p className="note">
          カットした部分を飛ばしながら再生しています。飛ぶ瞬間に一瞬引っかかりますが、
          書き出した動画では滑らかに繋がります。
          <br />
          テンポ・テロップの出るタイミング・人物アップへの切り替わりを確認してください。
          {shots.length > 0 && 'バーの色が付いた部分が人物アップです。押すとその1回だけ止められます。'}
          <kbd>Space</kbd> で一時停止。
          {skipped && Object.keys(skipped).length > 0 && (
            <>
              <br />
              <span className="skipped">
                アップにしなかった箇所:{' '}
                {Object.entries(skipped)
                  .map(([reason, n]) => `${reason} ${n}件`)
                  .join(' / ')}
              </span>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
