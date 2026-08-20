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
import { buildLines, drawTelop } from './render';
import {
  DEFAULT_STYLES,
  resolveStyle,
  SAFE_AREA_RATIO,
  type TelopStyle,
  type TelopPosition,
  type TelopStyleName,
} from './style';
import type { Frame, TelopCard } from './split';
import './telop.css';

export type StyleMap = Record<TelopStyleName, TelopStyle>;

/** 書き出し方の選択。 */
export interface ExportOptions {
  /** 映像にテロップを焼き込むか */
  burn: boolean;
  /** 字幕ファイル(SRT)も出すか */
  srt: boolean;
}

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
  onExport: (cards: TelopCard[], styles: StyleMap, options: ExportOptions) => void;
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
  /**
   * スタイルの雛形。ここを変えると、そのスタイルのテロップが全部変わる。
   * 「通常のテロップの色を変えたい」は1枚ずつ直す作業ではないので、雛形側で持つ。
   */
  const [styles, setStyles] = useState<StyleMap>(() => structuredClone(DEFAULT_STYLES));
  /** 雛形の編集パネルで今どのスタイルを触っているか */
  const [editingStyle, setEditingStyle] = useState<TelopStyleName>('normal');
  const [exportOptions, setExportOptions] = useState<ExportOptions>({ burn: true, srt: true });
  /**
   * 直前の状態。Del で消したものを戻せないと、誤爆が怖くて Del を押せなくなる。
   * テロップは数百枚あるので、履歴は直近だけで十分。
   */
  const undoStack = useRef<TelopCard[][]>([]);

  const remember = useCallback(() => {
    undoStack.current.push(cards);
    if (undoStack.current.length > 30) undoStack.current.shift();
  }, [cards]);

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    setCards(prev);
    setIndex((i) => Math.min(i, prev.length - 1));
  }, []);

  /**
   * 全テロップの時刻をまとめてずらす。
   * 文字起こしのタイムスタンプは全体的に数十〜百数十ms遅れることがあり、
   * それを1枚ずつ直していたら数百回の操作になる。
   */
  const shiftAll = useCallback((delta: number) => {
    setCards((prev) =>
      prev.map((c) => ({
        ...c,
        srcStart: Number(Math.max(0, c.srcStart + delta).toFixed(3)),
        srcEnd: Number(Math.max(0.2, c.srcEnd + delta).toFixed(3)),
      })),
    );
  }, []);

  const patchStyle = useCallback((name: TelopStyleName, patch: Partial<TelopStyle>) => {
    setStyles((prev) => ({ ...prev, [name]: { ...prev[name], ...patch } }));
  }, []);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);

  const current = cards[index];
  /** 実際に使われる位置。1枚の上書きが無ければ雛形に従う */
  const currentPosition = current
    ? (current.positionOverride ?? styles[current.style].position)
    : 'bottom';
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
      setEditingStyle(name);
    },
    [current, rewrap, update],
  );

  /** 表示時刻をずらす / 伸縮する */
  const shiftTime = useCallback(
    (deltaStart: number, deltaEnd: number) => {
      if (!current) return;
      const start = Math.max(0, current.srcStart + deltaStart);
      const end = Math.max(start + 0.2, current.srcEnd + deltaEnd);
      update({ srcStart: Number(start.toFixed(3)), srcEnd: Number(end.toFixed(3)) });
    },
    [current, update],
  );

  /**
   * 今の再生位置に空のテロップを足す。
   *
   * 文字起こしが拾えなかった発言や、後から入れたい一言のため。
   * 既存の並びに割り込ませるので、追加後は時刻順に並べ直す。
   */
  const addTelop = useCallback(() => {
    const at = videoRef.current?.currentTime ?? current?.srcStart ?? 0;
    const card: TelopCard = {
      id: `manual-${Date.now()}`,
      unitId: `manual-${Date.now()}`,
      srcStart: Number(at.toFixed(3)),
      srcEnd: Number((at + 2).toFixed(3)),
      text: '新しいテロップ',
      lines: ['新しいテロップ'],
      style: 'normal',
      reason: '手で追加',
      needsCheck: false,
      confidence: 1,
      lowWords: 0,
      fontScale: 1,
      offsetX: 0,
      offsetY: 0,
      manual: true,
    };
    remember();
    setCards((prev) => {
      const next = [...prev, card].sort((a, b) => a.srcStart - b.srcStart);
      setIndex(next.findIndex((c) => c.id === card.id));
      return next;
    });
    setDraft(card.text);
    setEditing(true);
  }, [current, remember]);

  // ── プレビュー上でテロップを掴んで動かす ──
  //
  // 🔴 ドラッグ中は state を更新しない。
  //    1回動かすたびにテロップ一覧（数百件）ごと再描画されて引っかかる。
  //    動かしている間は Canvas を CSS でずらすだけにして、離したときに確定する。
  const dragRef = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);

  const onDragStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
  }, []);

  const onDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || !canvasRef.current) return;
    drag.dx = e.clientX - drag.x;
    drag.dy = e.clientY - drag.y;
    canvasRef.current.style.transform = `translate(${drag.dx}px, ${drag.dy}px)`;
  }, []);

  const onDragEnd = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag || !current) return;
      if (canvasRef.current) canvasRef.current.style.transform = '';
      if (Math.abs(drag.dx) < 2 && Math.abs(drag.dy) < 2) return;

      // 画面サイズに対する比率で持つので、解像度が変わっても同じ位置になる
      const box = e.currentTarget.getBoundingClientRect();
      update({
        offsetX: Number((current.offsetX + drag.dx / box.width).toFixed(4)),
        offsetY: Number((current.offsetY + drag.dy / box.height).toFixed(4)),
      });
    },
    [current, update],
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
    // 🔴 書き出しと同じ resolveStyle / buildLines を通す（rasterize.ts と対）
    const resolved = resolveStyle(styles, current.style, current.override, current.fontScale);
    drawTelop(
      ctx,
      {
        lines: buildLines(current.lines, current.highlight ?? undefined, resolved),
        style: resolved,
        position: current.positionOverride ?? resolved.position,
        offsetX: current.offsetX,
        offsetY: current.offsetY,
      },
      frame,
    );
  }, [current, styles, frame.width, frame.height]);

  // 選択中の項目が一覧の外に出たら追従させる
  useEffect(() => {
    const list = listRef.current;
    const item = list?.querySelector<HTMLElement>('[aria-current="true"]');
    item?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // メニューからの「通しで確認」「テロップを追加」
  useEffect(() => {
    const onMenu = (e: Event) => {
      const action = (e as CustomEvent<string>).detail;
      if (action === 'fullpreview' || action === 'export') onExport(cards, styles, exportOptions);
    };
    window.addEventListener('app:menu-action', onMenu);
    return () => window.removeEventListener('app:menu-action', onMenu);
  }, [cards, styles, exportOptions, onExport]);

  // Ctrl+T でテロップ追加
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't') {
        addTelop();
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addTelop]);

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
          const now = current.positionOverride ?? styles[current.style].position;
          const next = POSITION_ORDER[(POSITION_ORDER.indexOf(now) + 1) % POSITION_ORDER.length];
          update({ positionOverride: next });
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
          remember();
          setCards((prev) => prev.filter((_, i) => i !== index));
          setIndex((i) => Math.max(0, Math.min(cards.length - 2, i)));
          break;
        case 'z':
          if (e.ctrlKey || e.metaKey) undo();
          else return;
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, commitEdit, move, nextCheck, cycleStyle, update, restart, remember, undo, styles, current, index, cards.length]);

  if (!current) {
    return (
      <div className="telop empty">
        <h1>テロップがありません</h1>
        <p className="muted">文字起こしから作れるテロップがありませんでした。</p>
        <div className="actions">
          {onBack && <button onClick={onBack}>戻る</button>}
          <button className="primary" onClick={() => onExport([], styles, exportOptions)}>
            テロップ無しで進む
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
        <span className="shiftall" title="全テロップの表示時刻をまとめてずらします">
          全体
          <button onClick={() => shiftAll(-0.1)}>−0.1秒</button>
          <button onClick={() => shiftAll(0.1)}>+0.1秒</button>
        </span>
        <button onClick={addTelop} title="今の再生位置にテロップを足す">＋ テロップを追加</button>
        {/*
          焼き込み一択だと後工程が詰む。BGM も B-roll も足せず、
          あとからカットを1箇所足すだけでテロップが単語の途中で切れる。
          SRT を出せば「カットはこのアプリ、テロップは編集ソフト」が選べる。
        */}
        <label className="opt" title="映像にテロップを直接描き込みます">
          <input
            type="checkbox"
            checked={exportOptions.burn}
            onChange={(e) => setExportOptions((o) => ({ ...o, burn: e.target.checked }))}
          />
          焼き込む
        </label>
        <label className="opt" title="編集ソフトに読み込める字幕ファイルを出します">
          <input
            type="checkbox"
            checked={exportOptions.srt}
            onChange={(e) => setExportOptions((o) => ({ ...o, srt: e.target.checked }))}
          />
          字幕(SRT)
        </label>
        {onBack && <button onClick={onBack}>カットに戻る</button>}
        <button className="primary" disabled={exporting} onClick={() => onExport(cards, styles, exportOptions)}>
          {exporting ? '書き出し中…' : '通しで確認 →'}
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
          <div
            className="canvas-wrap"
            style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
            title="ドラッグでテロップの位置を動かせます"
          >
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

            {/*
              投稿先のUI（TikTokのキャプション帯、Shortsのタイトル行）が乗る領域。
              ここにテロップを置くと隠れる。
            */}
            <div className="safe-area" aria-hidden>
              <span className="band top" style={{ height: `${SAFE_AREA_RATIO.top * 100}%` }} />
              <span className="band bottom" style={{ height: `${SAFE_AREA_RATIO.bottom * 100}%` }} />
            </div>
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

            {/* ── この1枚の調整 ── */}
            <div className="panel">
              <div className="row">
                <label>表示時刻</label>
                <span className="value">
                  {formatTime(current.srcStart)} → {formatTime(current.srcEnd)}
                  （{(current.srcEnd - current.srcStart).toFixed(1)}秒）
                </span>
                <button type="button" onClick={() => shiftTime(-0.1, -0.1)} title="全体を早める">
                  ←
                </button>
                <button type="button" onClick={() => shiftTime(0.1, 0.1)} title="全体を遅らせる">
                  →
                </button>
                <button type="button" onClick={() => shiftTime(0, -0.2)} title="表示時間を短く">
                  短く
                </button>
                <button type="button" onClick={() => shiftTime(0, 0.2)} title="表示時間を長く">
                  長く
                </button>
              </div>

              <div className="row">
                <label>位置</label>
                {POSITION_ORDER.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={currentPosition === p ? 'on' : ''}
                    onClick={() => update({ positionOverride: p })}
                  >
                    {POSITION_LABEL[p]}
                  </button>
                ))}
                {current.positionOverride && (
                  <button type="button" onClick={() => update({ positionOverride: undefined })}>
                    雛形に戻す
                  </button>
                )}
                {(current.offsetX !== 0 || current.offsetY !== 0) && (
                  <button type="button" onClick={() => update({ offsetX: 0, offsetY: 0 })}>
                    ずらしを戻す
                  </button>
                )}
                <span className="hint">
                  {current.offsetX || current.offsetY
                    ? `ずらし ${(current.offsetX * 100).toFixed(0)}%, ${(current.offsetY * 100).toFixed(0)}%`
                    : 'プレビューをドラッグでも動かせます'}
                </span>
              </div>

              <div className="row">
                <label>強調する語</label>
                <input
                  type="text"
                  className="hl"
                  value={current.highlight ?? ''}
                  placeholder="例: めちゃくちゃ"
                  onChange={(e) => update({ highlight: e.target.value || null })}
                />
                <span className="hint">この語だけ色と大きさが変わります</span>
              </div>

              <div className="row">
                <label>この1枚の色</label>
                <input
                  type="color"
                  value={current.override?.color ?? styles[current.style].color}
                  onChange={(e) =>
                    update({ override: { ...current.override, color: e.target.value } })
                  }
                  title="文字色"
                />
                <input
                  type="color"
                  value={
                    current.override?.strokeColor ?? styles[current.style].stroke?.color ?? '#000000'
                  }
                  onChange={(e) =>
                    update({ override: { ...current.override, strokeColor: e.target.value } })
                  }
                  title="縁の色"
                />
                <label className="sub">大きさ</label>
                <input
                  type="range"
                  min={0.6}
                  max={1.8}
                  step={0.05}
                  value={current.override?.sizeScale ?? 1}
                  onChange={(e) =>
                    update({
                      override: { ...current.override, sizeScale: Number(e.target.value) },
                    })
                  }
                />
                {current.override && (
                  <button type="button" onClick={() => update({ override: undefined })}>
                    既定に戻す
                  </button>
                )}
              </div>
            </div>

            {/* ── スタイルの雛形（同じスタイルのテロップすべてに効く）── */}
            <div className="panel">
              <div className="row">
                <label>雛形を編集</label>
                {STYLE_ORDER.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={editingStyle === s ? 'on' : ''}
                    onClick={() => setEditingStyle(s)}
                  >
                    {STYLE_LABEL[s]}
                  </button>
                ))}
                <span className="hint">このスタイルのテロップすべてに効きます</span>
              </div>
              <div className="row">
                <label className="sub">文字色</label>
                <input
                  type="color"
                  value={styles[editingStyle].color}
                  onChange={(e) => patchStyle(editingStyle, { color: e.target.value })}
                />
                <label className="sub">縁の色</label>
                <input
                  type="color"
                  value={styles[editingStyle].stroke?.color ?? '#000000'}
                  onChange={(e) =>
                    patchStyle(editingStyle, {
                      stroke: {
                        widthRatio: styles[editingStyle].stroke?.widthRatio ?? 0.16,
                        color: e.target.value,
                      },
                    })
                  }
                />
                <label className="sub">大きさ</label>
                <input
                  type="range"
                  min={0.04}
                  max={0.16}
                  step={0.005}
                  value={styles[editingStyle].fontSizeRatio}
                  onChange={(e) =>
                    patchStyle(editingStyle, { fontSizeRatio: Number(e.target.value) })
                  }
                />
                <button type="button" onClick={() => patchStyle(editingStyle, DEFAULT_STYLES[editingStyle])}>
                  既定に戻す
                </button>
              </div>
              <div className="row">
                <label className="sub">位置</label>
                {POSITION_ORDER.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={styles[editingStyle].position === p ? 'on' : ''}
                    onClick={() => patchStyle(editingStyle, { position: p })}
                  >
                    {POSITION_LABEL[p]}
                  </button>
                ))}
                <label className="sub">強調色</label>
                <input
                  type="color"
                  value={styles[editingStyle].highlightColor ?? '#ffe14d'}
                  onChange={(e) => patchStyle(editingStyle, { highlightColor: e.target.value })}
                />
              </div>
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
        <kbd>1</kbd> 通常 <kbd>2</kbd> 補足 <kbd>3</kbd> 強調 <kbd>P</kbd> 位置 <kbd>Del</kbd> 削除{' '}
        <kbd>Ctrl</kbd>+<kbd>Z</kbd> 取消
        <span className="sep" />
        プレビューをドラッグで位置調整
        <span className="sep" />
        直さなかったものはそのまま焼き込まれます
      </footer>
    </div>
  );
}
