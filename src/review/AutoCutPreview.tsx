/**
 * 自動で決めたカットを、通しで確認する画面。
 *
 * 🔴 1件ずつ切り出したクリップを並べるのでは足りない。
 *    自動判定は数十件あり、1本ずつ開いて閉じてを繰り返すと
 *    「人間が見なくて済むようにした」意味が消える。
 *    通しで流し、おかしいと思ったところだけ止めて直せるほうが速い。
 *
 * 🔴 切った箇所は映像から消えている。
 *    シークバーに印を出さないと、どこを切ったのか二度と辿れない。
 *    印を押せばその場で戻せる。押した直後にそこから再生し直すので、
 *    「戻した結果どう聞こえるか」がそのまま分かる。
 *
 * プロキシ動画は書き出さない（通し確認 preview/PreviewScreen.tsx と同じ理由）。
 * 元素材を再生しながらカット区間を飛ばせば、待ち時間ゼロで確認できる。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { keepRanges } from '../preview/PreviewScreen';
import { KIND_LABEL, type CutCandidate, type CutKind } from './mockCandidates';
import './autocut.css';

/** 印を押したあと、その何秒前から流し直すか */
const REPLAY_LEAD = 1.5;

const SPEEDS = [1, 1.3, 1.5, 2];

export interface AutoCutItem extends CutCandidate {
  /** 今カットする設定になっているか */
  cut: boolean;
  /** 自動判定の既定（true=自動でカット / false=自動で見送り） */
  auto: boolean;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export interface AutoCutPreviewProps {
  videoPath: string;
  duration: number;
  frame: { width: number; height: number };
  /**
   * 人が1件ずつ判断したカット。この画面では触らせない。
   * 再生には反映する。反映しないと、実際に書き出すものと違うテンポを見ることになる。
   */
  fixedCuts: { srcStart: number; srcEnd: number }[];
  items: AutoCutItem[];
  onToggle: (id: string) => void;
  onClose: () => void;
}

export function AutoCutPreview({
  videoPath,
  duration,
  frame,
  fixedCuts,
  items,
  onToggle,
  onClose,
}: AutoCutPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  /** 再生位置に近いカット。毎フレーム setState すると重いので変わった時だけ */
  const nearRef = useRef<string | null>(null);

  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(true);
  const [nearId, setNearId] = useState<string | null>(null);
  /**
   * フィラーは件数が多く、出すとバーが密になる。
   * それでも既定では出す。隠すと「4箇所をカット」と書いてあるのに
   * 印が1つしか無い、という食い違いが起きる。
   * 密すぎると感じた人が下ろせればよい。
   */
  const [showFillers, setShowFillers] = useState(true);

  const cuts = useMemo(
    () => [...fixedCuts, ...items.filter((i) => i.cut)],
    [fixedCuts, items],
  );
  const keeps = useMemo(() => keepRanges(duration, cuts), [duration, cuts]);
  const keptTotal = useMemo(() => keeps.reduce((a, k) => a + (k.end - k.start), 0), [keeps]);

  /** 元素材の時刻 → カット後の時刻 */
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

  const pct = useCallback((out: number) => (out / Math.max(0.1, keptTotal)) * 100, [keptTotal]);

  /** バーに出す並び。フィラーは別の段にする */
  const shown = useMemo(
    () => items.filter((i) => showFillers || i.kind !== 'filler'),
    [items, showFillers],
  );
  const ordered = useMemo(() => [...shown].sort((a, b) => a.srcStart - b.srcStart), [shown]);

  const cutCount = items.filter((i) => i.cut).length;
  const changed = items.filter((i) => i.cut !== i.auto).length;
  const near = nearId ? items.find((i) => i.id === nearId) ?? null : null;

  /** 元素材の時刻へ飛んで再生する */
  const playFrom = useCallback((srcTime: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, srcTime);
    void video.play().catch(() => undefined);
    setPlaying(true);
  }, []);

  /**
   * 印を押したときの動き。
   * 切る/戻すを切り替えてから、その少し手前に飛んで流し直す。
   *
   * 🔴 切り替えるだけにしてはいけない。
   *    切り替えた結果どう聞こえるかが、まさに確かめたいことなので、
   *    そこまで手で戻させるとほぼ確かめられない。
   */
  const toggleAndReplay = useCallback(
    (item: AutoCutItem) => {
      onToggle(item.id);
      playFrom(item.srcStart - REPLAY_LEAD);
    },
    [onToggle, playFrom],
  );

  /** 前後の自動判定へ移動して、その手前から流す */
  const step = useCallback(
    (dir: 1 | -1) => {
      const video = videoRef.current;
      if (!video || ordered.length === 0) return;
      const t = video.currentTime;
      const target =
        dir === 1
          ? ordered.find((i) => i.srcStart > t + 0.05) ?? ordered[0]
          : [...ordered].reverse().find((i) => i.srcStart < t - REPLAY_LEAD - 0.05) ??
            ordered[ordered.length - 1];
      setNearId(target.id);
      nearRef.current = target.id;
      playFrom(target.srcStart - REPLAY_LEAD);
    },
    [ordered, playFrom],
  );

  /**
   * カット区間に入っていたら次へ飛び、今どのカットの近くかを更新する。
   *
   * 🔴 requestAnimationFrame だけに任せてはいけない。
   *    ウィンドウが他のウィンドウに隠れると Chromium は rAF を止める。
   *    止まった間はカット区間が飛ばされず、切ったはずの音がそのまま流れる
   *    （実際に、裏に回した状態で再生したら最後まで素通しになった）。
   *    timeupdate は隠れていても 4回/秒 ほど届くので、こちらからも呼ぶ。
   */
  const advance = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.paused) return;
    const t = video.currentTime;

    const keep = keeps.find((k) => t >= k.start && t < k.end);
    if (!keep) {
      const next = keeps.find((k) => k.start > t);
      if (next) video.currentTime = next.start;
      else video.pause();
    }

    // 再生位置の少し手前からカットを「今見ているもの」として出す。
    // 切った箇所は一瞬で通り過ぎるので、手前から拾わないと表示が間に合わない。
    const found = ordered.find((i) => t >= i.srcStart - REPLAY_LEAD && t <= i.srcEnd + 0.4) ?? null;
    const key = found?.id ?? null;
    if (key !== nearRef.current) {
      nearRef.current = key;
      setNearId(key);
    }

    const out = toOutputTime(video.currentTime);
    if (barRef.current) barRef.current.style.width = `${pct(out)}%`;
    if (labelRef.current) {
      labelRef.current.textContent = `${formatTime(out)} / ${formatTime(keptTotal)}`;
    }
  }, [keeps, ordered, toOutputTime, pct, keptTotal]);

  /** 見えている間は毎フレーム。滑らかに動くのはこちら。 */
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      advance();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [advance]);

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

  const start = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = keeps[0]?.start ?? 0;
    video.playbackRate = speed;
    void video.play().catch(() => undefined);
    setPlaying(true);
  }, [keeps, speed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case ' ':
          toggle();
          break;
        case 'ArrowRight':
        case ']':
          step(1);
          break;
        case 'ArrowLeft':
        case '[':
          step(-1);
          break;
        case 'Enter':
          // 今見ているカットを切る/戻す
          if (near) toggleAndReplay(near);
          break;
        case 'Escape':
          onClose();
          break;
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    // 🔴 捕捉フェーズで受ける。カットレビュー画面のキー操作がまだ生きているので、
    //    そちらに届くと候補の判定が書き換わる。
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [toggle, step, near, toggleAndReplay, onClose]);

  /** バーの空いている場所を押したらその位置へ飛ぶ */
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

  /** 1件ぶんの印。切ってあれば線、残してあれば帯。 */
  const mark = (item: AutoCutItem, lane: string) => {
    // 末尾のカットは繋ぎ目がちょうど 100% に来る。そのままだとバーの外に出て押せない。
    // 0.4% ずらしても 20分素材で 5 秒未満、見た目には分からない。
    const left = Math.min(99.6, pct(toOutputTime(item.srcStart)));
    const width = item.cut
      ? 0
      : Math.max(0.35, pct(toOutputTime(item.srcEnd)) - left);
    const label =
      `${formatTime(item.srcStart)} ${KIND_LABEL[item.kind]}` +
      `${item.word ? `「${item.word}」` : ''} ${(item.srcEnd - item.srcStart).toFixed(2)}秒 / ` +
      `確信度${item.confidence.toFixed(2)} / ` +
      `${item.cut ? '今はカットしています。押すと戻します' : '今は残しています。押すとカットします'}`;

    return (
      <button
        key={item.id}
        type="button"
        className={
          `mk ${lane} ${item.cut ? 'cut' : 'kept'}` +
          `${item.cut !== item.auto ? ' changed' : ''}` +
          `${item.id === nearId ? ' near' : ''}`
        }
        style={item.cut ? { left: `${left}%` } : { left: `${left}%`, width: `${width}%` }}
        title={label}
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          toggleAndReplay(item);
        }}
      />
    );
  };

  const silences = ordered.filter((i) => i.kind !== 'filler');
  const fillers = ordered.filter((i) => i.kind === 'filler');

  return (
    <div className="autocut">
      <header>
        <span className="counter">
          自動で決めたカットの確認{' '}
          <strong>
            {cutCount}/{items.length}
          </strong>
          <span className="muted"> 箇所をカット</span>
          {changed > 0 && <span className="changed"> ・ {changed} 件を手で直しました</span>}
        </span>
        <div className="grow" />
        <label className="opt" title="フィラーは件数が多いので、密すぎるときは下ろしてください">
          <input
            type="checkbox"
            checked={showFillers}
            onChange={(e) => setShowFillers(e.target.checked)}
          />
          フィラーも出す（{items.filter((i) => i.kind === 'filler').length}件）
        </label>
        <button className="primary" onClick={onClose}>
          確認を終える
        </button>
      </header>

      <div className="stage">
        <div className="canvas-wrap" style={{ aspectRatio: `${frame.width} / ${frame.height}` }}>
          <video
            ref={videoRef}
            src={`media://local/${encodeURIComponent(videoPath.replace(/\\/g, '/'))}`}
            playsInline
            preload="auto"
            onLoadedMetadata={start}
            onTimeUpdate={advance}
            onClick={toggle}
          />
        </div>

        <div className="controls">
          <button onClick={toggle}>{playing ? '一時停止' : '再生'}</button>
          <button onClick={start}>最初から</button>
          <button onClick={() => step(-1)} title="前のカットの手前から流します">
            ◀ 前
          </button>
          <button onClick={() => step(1)} title="次のカットの手前から流します">
            次 ▶
          </button>

          <span className="bar" onClick={seekTo} title="押すとその位置へ飛びます">
            {silences.map((i) => mark(i, 'main'))}
            {showFillers && fillers.map((i) => mark(i, 'sub'))}
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

        {/*
          今どこを見ているかを文字でも出す。
          切った箇所は一瞬で通り過ぎるので、映像だけでは
          「今のがカットだったのか」が分からない。
        */}
        <div className={`nowat ${near ? '' : 'empty'}`}>
          {near ? (
            <>
              <span className={`kind ${near.kind}`}>{KIND_LABEL[near.kind]}</span>
              <span className="time">{formatTime(near.srcStart)}</span>
              <span className="ctx">
                …{near.before}
                <em>
                  {near.word ? `「${near.word}」` : ''}⟨{(near.srcEnd - near.srcStart).toFixed(2)}秒⟩
                </em>
                {near.after}…
              </span>
              <span className="conf">確信度 {near.confidence.toFixed(2)}</span>
              <button
                className={near.cut ? 'restore' : 'docut'}
                onClick={() => toggleAndReplay(near)}
              >
                {near.cut ? 'ここは残す' : 'ここはカットする'}
              </button>
            </>
          ) : (
            <span className="muted">
              カットのある場所に来ると、ここに内容が出ます（
              <kbd>Enter</kbd> で切る／戻す）
            </span>
          )}
        </div>

        <div className="legend">
          <span className="k-cut">
            <i />
            カットした位置（線）{items.filter((i) => i.cut).length}箇所
          </span>
          <span className="k-kept">
            <i />
            残している候補（帯）{items.filter((i) => !i.cut).length}箇所
          </span>
          <span className="k-changed">
            <i />
            手で直した箇所
          </span>
        </div>

        <p className="note">
          カットした部分を飛ばしながら再生しています。飛ぶ瞬間に一瞬引っかかりますが、
          書き出した動画では滑らかに繋がります。
          <br />
          バーの印を押すと、その場で切る／戻すが切り替わり、
          <strong>その少し手前から流し直します</strong>。
          <kbd>Space</kbd> 一時停止 / <kbd>←</kbd>
          <kbd>→</kbd> 前後のカットへ / <kbd>Enter</kbd> 切る・戻す / <kbd>Esc</kbd> 閉じる
        </p>
      </div>
    </div>
  );
}

export type { CutKind };
