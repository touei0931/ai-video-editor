/**
 * テロップ確認画面（②）。
 *
 * ここでの目標は「全部読む」ではなく「**直すべきものだけ見つける**」。
 * 20分素材ならテロップは200〜400枚になるので、1枚ずつ承認させたら
 * カットの時短がそのまま消える。
 *
 * そこで:
 *   - 一覧で流し読みできるようにし、承認操作そのものを無くす（既定は「そのまま使う」）
 *   - 認識が怪しい箇所（needs_check）だけ赤く出し、そこへ直接飛べるようにする
 *   - プレビューは**実際の映像の上に**出す。文字だけ見ても顔にかぶるか分からない。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { drawTelop } from './render';
import { DEFAULT_STYLES, type TelopPosition, type TelopStyleName } from './style';
import type { Frame, TelopCard } from './split';
import './telop.css';

const STYLE_LABEL: Record<TelopStyleName, string> = {
  normal: '通常',
  note: '補足',
  emphasis: '強調',
};

const STYLE_ORDER: TelopStyleName[] = ['normal', 'note', 'emphasis'];

/**
 * 再生する範囲。テロップの表示区間の前後にこれだけ足す。
 *
 * テロップだけを見せても「その文言で合っているか」は判断できない。
 * 前の会話が聞こえて初めて、聞き取りが正しいか・区切りが自然かが分かる。
 */
const LEAD_IN = 2.5;
const TAIL = 1.0;
const POSITION_ORDER: TelopPosition[] = ['bottom', 'middle', 'top'];
const POSITION_LABEL: Record<TelopPosition, string> = {
  top: '上',
  middle: '中央',
  bottom: '下',
};

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export interface TelopScreenProps {
  cards: TelopCard[];
  /** 元素材のパス。プレビューの背景に使う */
  videoPath: string;
  frame: Frame;
  /** 実測幅で折り返す関数（編集したテキストを折り返し直すのに使う） */
  rewrap: (text: string, style: TelopStyleName) => { lines: string[]; fontScale: number };
  onBack?: () => void;
  onExport: (cards: TelopCard[]) => void;
  exporting?: boolean;
  /**
   * 書き出しに失敗したときの内容。
   * ここに出さないと、失敗して画面が戻っただけに見えて原因が分からない。
   */
  error?: string | null;
}

export function TelopScreen({
  cards: initial,
  videoPath,
  frame,
  rewrap,
  onBack,
  onExport,
  exporting,
  error,
}: TelopScreenProps) {
  const [cards, setCards] = useState(initial);
  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);

  const current = cards[index];
  const checkCount = useMemo(() => cards.filter((c) => c.needsCheck).length, [cards]);
  const styleCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const c of cards) out[c.style] = (out[c.style] ?? 0) + 1;
    return out;
  }, [cards]);

  const update = useCallback(
    (patch: Partial<TelopCard>) => {
      setCards((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
    },
    [index],
  );

  const move = useCallback(
    (delta: number) => {
      setIndex((i) => Math.max(0, Math.min(cards.length - 1, i + delta)));
      setEditing(false);
    },
    [cards.length],
  );

  /** 次の「要確認」へ飛ぶ。ここだけ見れば済むようにするのが狙い。 */
  const nextCheck = useCallback(() => {
    const found = cards.findIndex((c, i) => i > index && c.needsCheck);
    setIndex(found >= 0 ? found : cards.findIndex((c) => c.needsCheck));
    setEditing(false);
  }, [cards, index]);

  const cycleStyle = useCallback(
    (name: TelopStyleName) => {
      if (!current) return;
      // スタイルが変わるとフォントも大きさも変わるので、折り返しを計算し直す
      const fit = rewrap(current.text, name);
      update({ style: name, lines: fit.lines, fontScale: fit.fontScale, reason: '手動で変更' });
    },
    [current, rewrap, update],
  );

  const commitEdit = useCallback(() => {
    if (!current) return;
    const text = draft.trim();
    setEditing(false);
    if (!text || text === current.text) return;
    const fit = rewrap(text, current.style);
    update({ text, lines: fit.lines, fontScale: fit.fontScale, needsCheck: false });
  }, [current, draft, rewrap, update]);

  // ── プレビュー ─────────────────────────────────────────
  // 元素材の該当箇所を、前後の会話込みでループ再生し、その上に Canvas で描く。
  const windowStart = Math.max(0, (current?.srcStart ?? 0) - LEAD_IN);
  const windowEnd = (current?.srcEnd ?? 0) + TAIL;
  const restart = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = windowStart;
    // 自動再生が拒否される環境でも、画面が止まるだけで済むようにする
    void video.play().catch(() => undefined);
  }, [windowStart]);

  useEffect(() => {
    if (current) restart();
  }, [current?.id, restart]);

  /**
   * 再生位置に応じて、テロップの表示/非表示と再生バーを更新する。
   *
   * 🔴 React の state ではなく DOM を直接触る。
   *    timeupdate イベントは 4回/秒 程度しか来ないので、テロップの出方が最大 250ms ずれる。
   *    かといって毎フレーム state を更新すると、テロップ数百件の一覧ごと再描画されて重くなる。
   *    ここで見たいのは「出るタイミングが合っているか」なので、精度が要る。
   */
  useEffect(() => {
    if (!current) return;
    let raf = 0;
    const span = windowEnd - windowStart;

    const tick = () => {
      const video = videoRef.current;
      if (video) {
        let t = video.currentTime;
        // 範囲を区切ったループ再生。前後の会話ごと繰り返す。
        if (t >= windowEnd || t < windowStart - 0.5) {
          video.currentTime = windowStart;
          t = windowStart;
        }
        if (canvasRef.current) {
          canvasRef.current.style.opacity =
            t >= current.srcStart && t <= current.srcEnd ? '1' : '0';
        }
        if (barRef.current) {
          barRef.current.style.width = `${Math.max(0, Math.min(1, (t - windowStart) / span)) * 100}%`;
        }
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [current, windowStart, windowEnd]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !current) return;
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, frame.width, frame.height);
    const base = DEFAULT_STYLES[current.style];
    drawTelop(
      ctx,
      {
        lines: current.lines,
        style: { ...base, fontSizeRatio: base.fontSizeRatio * current.fontScale },
        position: current.position,
      },
      frame,
    );
  }, [current, frame.width, frame.height]);

  // 選択中の項目が一覧の外に出たら追従させる
  useEffect(() => {
    const list = listRef.current;
    const item = list?.querySelector<HTMLElement>('[aria-current="true"]');
    item?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing) {
        if (e.key === 'Enter') {
          commitEdit();
          e.preventDefault();
        } else if (e.key === 'Escape') {
          setEditing(false);
          e.preventDefault();
        }
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'arrowdown':
        case 'j':
          move(1);
          break;
        case 'arrowup':
        case 'k':
          move(-1);
          break;
        case 'tab':
          nextCheck();
          break;
        case 'e':
          if (!current) return;
          setDraft(current.text);
          setEditing(true);
          break;
        case '1':
          cycleStyle('normal');
          break;
        case '2':
          cycleStyle('note');
          break;
        case '3':
          cycleStyle('emphasis');
          break;
        case 'p': {
          if (!current) return;
          const next = POSITION_ORDER[(POSITION_ORDER.indexOf(current.position) + 1) % POSITION_ORDER.length];
          update({ position: next });
          break;
        }
        case ' ': {
          const video = videoRef.current;
          if (!video) return;
          if (video.paused) void video.play().catch(() => undefined);
          else video.pause();
          break;
        }
        case 'r':
          restart();
          break;
        case 'delete':
        case 'backspace':
          setCards((prev) => prev.filter((_, i) => i !== index));
          setIndex((i) => Math.max(0, Math.min(cards.length - 2, i)));
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, commitEdit, move, nextCheck, cycleStyle, update, restart, current, index, cards.length]);

  if (!current) {
    return (
      <div className="telop empty">
        <h1>テロップがありません</h1>
        <p className="muted">文字起こしから作れるテロップがありませんでした。</p>
        <div className="actions">
          {onBack && <button onClick={onBack}>戻る</button>}
          <button className="primary" onClick={() => onExport([])}>
            テロップ無しで書き出す
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="telop">
      <header>
        <span className="counter">
          テロップ <strong>{cards.length}</strong> 枚
        </span>
        <span className="stats">
          {STYLE_ORDER.map((s) => (
            <span key={s} className={`chip ${s}`}>
              {STYLE_LABEL[s]} {styleCounts[s] ?? 0}
            </span>
          ))}
        </span>
        {checkCount > 0 && (
          <button className="check-jump" onClick={nextCheck}>
            要確認 {checkCount} 件へ（Tab）
          </button>
        )}
        <div className="grow" />
        {onBack && <button onClick={onBack}>カットに戻る</button>}
        <button className="primary" disabled={exporting} onClick={() => onExport(cards)}>
          {exporting ? '書き出し中…' : '書き出す'}
        </button>
      </header>

      {error && (
        <p className="export-error">
          書き出しに失敗しました: {error}
          <br />
          <small>
            詳細は <code>phase0-artifacts/last-error.json</code> に記録しています。
          </small>
        </p>
      )}

      <div className="body">
        <ul className="list" ref={listRef}>
          {cards.map((c, i) => (
            <li key={c.id}>
              <button
                type="button"
                className={`row ${i === index ? 'current' : ''} ${c.needsCheck ? 'check' : ''}`}
                aria-current={i === index}
                onClick={() => {
                  setIndex(i);
                  setEditing(false);
                }}
              >
                <span className="t">{formatTime(c.srcStart)}</span>
                <span className={`chip ${c.style}`}>{STYLE_LABEL[c.style]}</span>
                <span className="text">{c.text}</span>
                {c.needsCheck && <span className="flag" title="認識が怪しい箇所です">要確認</span>}
              </button>
            </li>
          ))}
        </ul>

        <section className="stage">
          <div className="canvas-wrap" style={{ aspectRatio: `${frame.width} / ${frame.height}` }}>
            <video
              ref={videoRef}
              className="bg"
              src={`media://local/${encodeURIComponent(videoPath.replace(/\\/g, '/'))}`}
              playsInline
              preload="auto"
              onLoadedMetadata={restart}
            />
            {/*
              テロップは表示区間の間だけ出す。
              ずっと出しっぱなしにすると「出るタイミングが正しいか」を確認できない。
              opacity は上の requestAnimationFrame が直接書き換える。
            */}
            <canvas ref={canvasRef} className="overlay" style={{ opacity: 0 }} />
          </div>

          {/* 再生位置と、テロップが出ている区間 */}
          <div className="playbar" aria-hidden>
            <span ref={barRef} className="played" />
            <span
              className="band"
              style={{
                left: `${((current.srcStart - windowStart) / (windowEnd - windowStart)) * 100}%`,
                width: `${((current.srcEnd - current.srcStart) / (windowEnd - windowStart)) * 100}%`,
              }}
            />
          </div>

          <div className="editor">
            {editing ? (
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitEdit}
                aria-label="テロップの文言"
              />
            ) : (
              <button type="button" className="text-display" onClick={() => {
                setDraft(current.text);
                setEditing(true);
              }}>
                {current.text}
              </button>
            )}

            <div className="meta">
              <span className="time">
                {formatTime(current.srcStart)} → {formatTime(current.srcEnd)}（
                {(current.srcEnd - current.srcStart).toFixed(1)}秒）
              </span>
              <span className="pos">位置 {POSITION_LABEL[current.position]}</span>
              {current.fontScale < 1 && (
                <span className="scale">収めるため {Math.round(current.fontScale * 100)}% に縮小</span>
              )}
              {current.reason && <span className="reason">{current.reason}</span>}
              {current.needsCheck && (
                <span className="flag">
                  聞き取りが怪しい（平均確度 {current.confidence.toFixed(2)}
                  {current.lowWords > 0 && ` / 怪しい語 ${current.lowWords}`}）
                </span>
              )}
            </div>
          </div>
        </section>
      </div>

      <footer>
        <kbd>↑</kbd>
        <kbd>↓</kbd> 移動 <kbd>Tab</kbd> 次の要確認 <kbd>E</kbd> 文言を直す
        <span className="sep" />
        <kbd>Space</kbd> 一時停止 <kbd>R</kbd> 頭から再生
        <span className="sep" />
        <kbd>1</kbd> 通常 <kbd>2</kbd> 補足 <kbd>3</kbd> 強調 <kbd>P</kbd> 位置 <kbd>Del</kbd> 削除
        <span className="sep" />
        直さなかったものはそのまま焼き込まれます
      </footer>
    </div>
  );
}
