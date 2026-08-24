/**
 * テロップの段階。カットと同じ骨格に載せる。
 *
 * 🔴 描画は既存の drawTelop をそのまま通すこと。
 *    プレビューと書き出しは**必ず同じ Canvas コード**を通す、という約束は
 *    このアプリの土台。ここを分けた瞬間に「プレビューと書き出しが違う」が起きる。
 *
 * 🔴 折り返し・雛形・重なり解消のロジックには手を入れない。
 *    wrap.ts / style.ts / split.ts は過去の不具合の積み重ねでできている。
 *    ここでやるのは**見せ方の載せ替えだけ**。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorShell } from './EditorShell';
import { Timeline, clock, type TimelineRegion } from './Timeline';
import { buildLines, drawTelop, type Frame } from '../telop/render';
import { resolveOverlaps, type TelopCard } from '../telop/split';
import {
  DEFAULT_STYLES,
  resolveStyle,
  type StyleLibrary,
  type StyleMap,
  type TelopStyleName,
} from '../telop/style';

export interface TelopStageProps {
  cards: TelopCard[];
  styles?: StyleMap;
  /** 雛形を書き換える。省略すると雛形の編集欄を出さない */
  onStylesChange?(s: StyleMap): void;
  /** 実際に読み込めた書体。ここに無いものは選ばせない */
  fontFamilies?: string[];
  /**
   * 名前を付けて保存してある見た目の一覧。
   * 🔴 これが無いと、動画を変えるたびに雛形を作り直すことになる。
   */
  library?: StyleLibrary;
  onLibraryChange?(l: StyleLibrary): Promise<boolean> | void;
  videoPath?: string;
  frame: Frame;
  /** 文言や大きさを変えたときに折り返し直す。既存の実装をそのまま渡す */
  rewrap?: (
    text: string,
    style: TelopStyleName,
    styles?: StyleMap,
    card?: { sizeScale?: number; breaks?: number[]; highlight?: string | null },
  ) => { lines: string[]; fontScale: number };
  onChange?(cards: TelopCard[]): void;
  onExport?(cards: TelopCard[]): void;
  onQuit?(): void;
  onBack?(): void;
  exporting?: boolean;
  /** カットの結果。テロップの下に並べて、どこを切ったかが見えるようにする */
  cutRegions?: { id: string; start: number; end: number }[];
  duration: number;
  fps?: number;
}

export function TelopStage({
  cards: initial,
  styles = DEFAULT_STYLES,
  onStylesChange,
  fontFamilies,
  library,
  onLibraryChange,
  videoPath,
  frame,
  rewrap,
  onChange,
  onExport,
  onQuit,
  onBack,
  exporting,
  cutRegions = [],
  duration,
  fps = 30,
}: TelopStageProps) {
  const [cards, setCards] = useState<TelopCard[]>(initial);
  const [selected, setSelected] = useState<string | null>(initial[0]?.id ?? null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [onlyCheck, setOnlyCheck] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // 🔴 呼び出し側の関数を依存に入れない。毎描画で作り直されると無限に鳴る
  const notify = useRef(onChange);
  notify.current = onChange;
  useEffect(() => {
    notify.current?.(cards);
  }, [cards]);

  const cur = useMemo(() => cards.find((c) => c.id === selected) ?? null, [cards, selected]);

  /** いま画面に出ているべきテロップ */
  const showing = useMemo(
    () => cards.find((c) => time >= c.srcStart && time < c.srcEnd) ?? null,
    [cards, time],
  );

  /* ---------- プレビュー ---------- */

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    cv.width = frame.width;
    cv.height = frame.height;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);

    const v = videoRef.current;
    if (v && v.readyState >= 2) {
      ctx.drawImage(v, 0, 0, cv.width, cv.height);
    } else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cv.width, cv.height);
    }

    const card = showing ?? (cur && time === 0 ? cur : null);
    if (!card) return;

    /*
      🔴 書き出しと同じ関数を、同じ順序で通すこと。

      resolveStyle → buildLines → drawTelop。
      とくに buildLines を飛ばすと、強調した語が**プレビューにだけ出ない**。
      lines は素の文字列で持ち、色と大きさは描く直前に決める作りになっている。
    */
    const style = resolveStyle(styles, card.style, card.override, card.fontScale);
    drawTelop(
      ctx,
      {
        lines: buildLines(card.lines, card.highlight ?? undefined, style),
        style,
        position: card.positionOverride ?? style.position,
        offsetX: card.offsetX,
        offsetY: card.offsetY,
      },
      frame,
    );
  }, [showing, cur, time, styles, frame]);

  /* ---------- 再生 ---------- */

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setTime(v.currentTime);
    v.addEventListener('timeupdate', onTime);
    return () => v.removeEventListener('timeupdate', onTime);
  }, []);

  const seek = useCallback((t: number) => {
    setTime(t);
    const v = videoRef.current;
    if (v && Number.isFinite(t)) v.currentTime = t;
  }, []);

  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().then(() => setPlaying(true));
    else {
      v.pause();
      setPlaying(false);
    }
  }, []);

  /* ---------- 直す ---------- */

  const patch = useCallback(
    (id: string, next: Partial<TelopCard>) => {
      setCards((cs) =>
        resolveOverlaps(
          cs.map((c) => (c.id === id ? { ...c, ...next, edited: true } : c)),
        ),
      );
    },
    [],
  );

  /** 文言や大きさを変えたら折り返しをやり直す */
  const retext = useCallback(
    (id: string, text: string) => {
      const c = cards.find((x) => x.id === id);
      if (!c) return;
      const r = rewrap?.(text, c.style, styles, {
        breaks: c.breaks,
        highlight: c.highlight ?? null,
      });
      patch(id, r ? { text, lines: r.lines, fontScale: r.fontScale } : { text, lines: [text] });
    },
    [cards, rewrap, styles, patch],
  );

  const restyle = useCallback(
    (id: string, style: TelopStyleName) => {
      const c = cards.find((x) => x.id === id);
      if (!c) return;
      // 🔴 書体が変わると字の幅が変わる。折り返しを必ず計算し直す
      const r = rewrap?.(c.text, style, styles, {
        breaks: c.breaks,
        highlight: c.highlight ?? null,
      });
      patch(id, r ? { style, lines: r.lines, fontScale: r.fontScale } : { style });
    },
    [cards, rewrap, styles, patch],
  );

  /** タイムラインで端を引いたとき */
  const onTrim = useCallback(
    (id: string, start: number, end: number) => {
      patch(id, { srcStart: Number(start.toFixed(3)), srcEnd: Number(end.toFixed(3)) });
    },
    [patch],
  );

  const remove = useCallback((id: string) => {
    setCards((cs) => cs.filter((c) => c.id !== id));
    setSelected(null);
  }, []);

  /**
   * 雛形（その枠を使うテロップ全部）の見た目を変える。
   *
   * 🔴 位置・書体・大きさは雛形側に持たせること。
   *    1枚ずつが持つと、300枚を上に移すのに300回操作することになる。
   */
  const patchStyle = useCallback(
    (name: TelopStyleName, next: Partial<StyleMap[TelopStyleName]>) => {
      if (!onStylesChange) return;
      onStylesChange({ ...styles, [name]: { ...styles[name], ...next } });
    },
    [styles, onStylesChange],
  );

  /**
   * 手で決めた改行位置。文と文のあいだを押すとそこで折り返す。
   * 🔴 変えたら必ず折り返しを計算し直す。lines を放置すると画面と書き出しがずれる。
   */
  const toggleBreak = useCallback(
    (at: number) => {
      if (!cur) return;
      const now = cur.breaks ?? [];
      const next = now.includes(at) ? now.filter((x) => x !== at) : [...now, at].sort((a, b) => a - b);
      const r = rewrap?.(cur.text, cur.style, styles, {
        breaks: next,
        highlight: cur.highlight ?? null,
      });
      patch(cur.id, r ? { breaks: next, lines: r.lines, fontScale: r.fontScale } : { breaks: next });
    },
    [cur, rewrap, styles, patch],
  );

  const setHighlight = useCallback(
    (word: string | null) => {
      if (!cur) return;
      const r = rewrap?.(cur.text, cur.style, styles, {
        breaks: cur.breaks,
        highlight: word,
      });
      patch(cur.id, r ? { highlight: word, lines: r.lines, fontScale: r.fontScale } : { highlight: word });
    },
    [cur, rewrap, styles, patch],
  );

  /* ---------- プレビュー上でテロップを掴んで動かす ---------- */

  const dragPos = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const onStagePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!cur) return;
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      dragPos.current = { x: e.clientX, y: e.clientY, ox: cur.offsetX, oy: cur.offsetY };
    },
    [cur],
  );
  const onStagePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const d = dragPos.current;
      if (!d || !cur) return;
      const rect = (e.target as HTMLElement).getBoundingClientRect();
      patch(cur.id, {
        offsetX: Number((d.ox + (e.clientX - d.x) / rect.width).toFixed(4)),
        offsetY: Number((d.oy + (e.clientY - d.y) / rect.height).toFixed(4)),
      });
    },
    [cur, patch],
  );
  const endStageDrag = useCallback(() => {
    dragPos.current = null;
  }, []);

  /* ---------- タイムライン ---------- */

  const shownCards = useMemo(
    () => (onlyCheck ? cards.filter((c) => c.needsCheck) : cards),
    [cards, onlyCheck],
  );

  const telopRegions = useMemo<TimelineRegion[]>(
    () =>
      shownCards.map((c) => ({
        id: c.id,
        start: c.srcStart,
        end: c.srcEnd,
        kind: 'telop',
        label: c.needsCheck ? `⚠ ${c.text}` : c.text,
      })),
    [shownCards],
  );

  const cutTrack = useMemo<TimelineRegion[]>(
    () =>
      cutRegions.map((r) => ({
        id: `cut-${r.id}`,
        start: r.start,
        end: r.end,
        kind: 'cut',
        label: '',
        fixed: true, // ここでは触らせない。カットの段階で決めたもの
      })),
    [cutRegions],
  );

  const needCheck = cards.filter((c) => c.needsCheck).length;

  const styleNames = useMemo(
    () => Object.keys(styles) as TelopStyleName[],
    [styles],
  );

  /* ---------- キー操作 ---------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === ' ') {
        toggle();
        e.preventDefault();
        return;
      }
      // 1〜9 で雛形を切り替える（既存の操作をそのまま残す）
      const n = Number(e.key);
      if (cur && n >= 1 && n <= 9 && styleNames[n - 1]) {
        restyle(cur.id, styleNames[n - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cur, styleNames, restyle, toggle]);

  return (
    <EditorShell
      step="telop"
      done={['source', 'cut']}
      toolbar={
        <>
          {onBack && <button onClick={onBack}>← カットに戻る</button>}
          {onQuit && (
            <button className="danger" onClick={onQuit}>
              編集をやめる
            </button>
          )}
          <button
            className={onlyCheck ? 'on' : ''}
            onClick={() => setOnlyCheck((v) => !v)}
            title="自信の無いものだけ表示"
          >
            ⚠ 要確認だけ（{needCheck}）
          </button>
          <button className="go" onClick={() => onExport?.(cards)} disabled={exporting}>
            {exporting ? '書き出し中…' : '書き出しへ進む →'}
          </button>
        </>
      }
      viewer={
        <>
          {videoPath && (
            <video
              ref={videoRef}
              src={`app-media://${encodeURI(videoPath)}`}
              style={{ display: 'none' }}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
            />
          )}
          <canvas
            ref={canvasRef}
            className="fcp-stage-inner"
            style={{ cursor: cur ? 'move' : 'default' }}
            onPointerDown={onStagePointerDown}
            onPointerMove={onStagePointerMove}
            onPointerUp={endStageDrag}
            onPointerCancel={endStageDrag}
            title={cur ? 'ドラッグでテロップの位置を動かせます' : undefined}
          />
        </>
      }
      transport={
        <>
          <button className="icon" onClick={() => seek(0)} title="頭出し">
            ⏮
          </button>
          <button className="icon" onClick={toggle} title="再生 / 一時停止（Space）">
            {playing ? '⏸' : '▶'}
          </button>
          <button
            className="icon"
            onClick={() => cur && seek(Math.max(0, cur.srcStart - 1.5))}
            disabled={!cur}
            title="選んだテロップの少し手前から"
          >
            ⟲
          </button>
          <span className="fcp-time">
            <strong>{clock(time)}</strong> / {clock(duration)}
          </span>
          <div className="fcp-spacer" />
          <span className="fcp-chip">テロップ {cards.length}</span>
          {needCheck > 0 && (
            <span className="fcp-chip" style={{ color: 'var(--sel)' }}>
              ⚠ 要確認 {needCheck}
            </span>
          )}
        </>
      }
      inspectorTitle={cur ? 'テロップ' : 'テロップ全体'}
      inspector={
        cur ? (
          <>
            <div className="fcp-field">
              <label>文言</label>
              <textarea
                value={cur.text}
                onChange={(e) => retext(cur.id, e.target.value)}
                rows={3}
                style={{
                  font: 'inherit',
                  fontSize: 14,
                  background: 'var(--s0)',
                  color: 'var(--text)',
                  border: '1px solid var(--line)',
                  borderRadius: 5,
                  padding: 8,
                  resize: 'vertical',
                }}
              />
              <div className="fcp-dim">
                実際の改行: {cur.lines.join(' / ')}
                {cur.fontScale < 1 && `（収めるため ${Math.round(cur.fontScale * 100)}% に縮小）`}
              </div>
            </div>

            <div className="fcp-field">
              <label>雛形（数字キーでも切り替えられます）</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {styleNames.map((n, i) => (
                  <button
                    key={n}
                    className={cur.style === n ? 'on' : ''}
                    onClick={() => restyle(cur.id, n)}
                    title={`${i + 1}`}
                  >
                    {styles[n]?.label ?? n}
                  </button>
                ))}
              </div>
            </div>

            <div className="fcp-field">
              <label>出る時間</label>
              <div className="fcp-stepper">
                <button onClick={() => patch(cur.id, { srcStart: Math.max(0, cur.srcStart - 1 / fps) })}>
                  −1f
                </button>
                <output>{clock(cur.srcStart)}</output>
                <button onClick={() => patch(cur.id, { srcStart: cur.srcStart + 1 / fps })}>
                  +1f
                </button>
              </div>
              <div className="fcp-stepper">
                <button onClick={() => patch(cur.id, { srcEnd: Math.max(cur.srcStart + 0.1, cur.srcEnd - 1 / fps) })}>
                  −1f
                </button>
                <output>{clock(cur.srcEnd)}</output>
                <button onClick={() => patch(cur.id, { srcEnd: cur.srcEnd + 1 / fps })}>+1f</button>
              </div>
              <div className="fcp-dim">
                長さ {(cur.srcEnd - cur.srcStart).toFixed(2)} 秒。
                タイムラインの端をドラッグしても変えられます。
              </div>
            </div>

            <div className="fcp-field">
              <label>改行の位置</label>
              <div className="fcp-breaks">
                {[...cur.text].map((ch, i) => (
                  <span key={i}>
                    {ch}
                    {i < cur.text.length - 1 && (
                      <button
                        className={`brk ${cur.breaks?.includes(i + 1) ? 'on' : ''}`}
                        onClick={() => toggleBreak(i + 1)}
                        title={cur.breaks?.includes(i + 1) ? 'ここの改行をやめる' : 'ここで改行する'}
                      >
                        {cur.breaks?.includes(i + 1) ? '↵' : '·'}
                      </button>
                    )}
                  </span>
                ))}
              </div>
              {cur.breaks?.length ? (
                <button onClick={() => patch(cur.id, { breaks: undefined })}>自動に戻す</button>
              ) : null}
            </div>

            <div className="fcp-field">
              <label>目立たせる語</label>
              <input
                value={cur.highlight ?? ''}
                onChange={(e) => setHighlight(e.target.value || null)}
                placeholder="（例）いちばん"
                style={{
                  font: 'inherit',
                  fontSize: 14,
                  background: 'var(--s0)',
                  color: 'var(--text)',
                  border: '1px solid var(--line)',
                  borderRadius: 5,
                  padding: '6px 8px',
                }}
              />
            </div>

            <div className="fcp-field">
              <label>位置</label>
              <div className="fcp-dim">
                プレビューの文字を<strong>ドラッグ</strong>すると動かせます。
              </div>
              {(cur.offsetX !== 0 || cur.offsetY !== 0) && (
                <button onClick={() => patch(cur.id, { offsetX: 0, offsetY: 0 })}>
                  位置をもとに戻す
                </button>
              )}
            </div>

            {cur.needsCheck && (
              <p className="fcp-dim" style={{ color: 'var(--sel)' }}>
                ⚠ 聞き取りに自信がありません。声を聞いて確かめてください。
              </p>
            )}

            <button className="danger" onClick={() => remove(cur.id)}>
              このテロップを消す
            </button>

            {onStylesChange && (
              <details className="fcp-styleedit">
                <summary>雛形「{styles[cur.style]?.label ?? cur.style}」を編集</summary>
                <p className="fcp-dim">この枠を使っているテロップ全部に効きます。</p>

                <div className="fcp-field">
                  <label>書体</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {(fontFamilies ?? [styles[cur.style]?.fontFamily]).filter(Boolean).map((f) => (
                      <button
                        key={f}
                        className={styles[cur.style]?.fontFamily === f ? 'on' : ''}
                        style={{ fontFamily: f }}
                        onClick={() => patchStyle(cur.style, { fontFamily: f })}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      className={styles[cur.style]?.bold ? 'on' : ''}
                      onClick={() => patchStyle(cur.style, { bold: !styles[cur.style]?.bold })}
                    >
                      太字
                    </button>
                    <button
                      className={styles[cur.style]?.italic ? 'on' : ''}
                      onClick={() => patchStyle(cur.style, { italic: !styles[cur.style]?.italic })}
                    >
                      斜体
                    </button>
                  </div>
                </div>

                <div className="fcp-field">
                  <label>色</label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      type="color"
                      value={styles[cur.style]?.color ?? '#ffffff'}
                      onChange={(e) => patchStyle(cur.style, { color: e.target.value })}
                    />
                    <span className="fcp-dim">縁</span>
                    <input
                      type="color"
                      value={styles[cur.style]?.stroke?.color ?? '#000000'}
                      onChange={(e) =>
                        patchStyle(cur.style, {
                          stroke: {
                            color: e.target.value,
                            widthRatio: styles[cur.style]?.stroke?.widthRatio ?? 0.12,
                          },
                        })
                      }
                    />
                  </div>
                </div>

                <div className="fcp-field">
                  <label>大きさ</label>
                  <input
                    type="range"
                    min={0.02}
                    max={0.12}
                    step={0.002}
                    value={styles[cur.style]?.fontSizeRatio ?? 0.055}
                    onChange={(e) =>
                      patchStyle(cur.style, { fontSizeRatio: Number(e.target.value) })
                    }
                  />
                </div>

                <div className="fcp-field">
                  <label>置く場所</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {(['top', 'middle', 'bottom'] as const).map((p) => (
                      <button
                        key={p}
                        className={styles[cur.style]?.position === p ? 'on' : ''}
                        onClick={() => patchStyle(cur.style, { position: p })}
                      >
                        {{ top: '上', middle: '中央', bottom: '下' }[p]}
                      </button>
                    ))}
                  </div>
                </div>
              </details>
            )}
          </>
        ) : (
          <>
            {library && onLibraryChange && (
              <div className="fcp-field">
                <label>保存した見た目</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {library.presets.map((p) => (
                    <button
                      key={p.name}
                      className={p.name === library.current ? 'on' : ''}
                      onClick={() => {
                        onStylesChange?.(structuredClone(p.styles));
                        void onLibraryChange({ ...library, current: p.name });
                      }}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => {
                    const name = window.prompt('この見た目に名前を付けてください', '普段用');
                    if (!name) return;
                    const rest = library.presets.filter((p) => p.name !== name);
                    void onLibraryChange({
                      current: name,
                      presets: [...rest, { name, styles: structuredClone(styles) }],
                    });
                  }}
                >
                  ＋ 今の見た目を保存
                </button>
                <p className="fcp-dim">
                  次に別の動画を編集するとき、最後に使った組で始まります。
                </p>
              </div>
            )}

            <div className="fcp-field">
              <label>枚数</label>
              <div>{cards.length} 枚</div>
            </div>
            <div className="fcp-field">
              <label>要確認</label>
              <div>{needCheck} 枚</div>
            </div>
            <p className="fcp-dim">
              タイムラインのテロップを選ぶと、ここで文言や雛形を直せます。
              下の段はカットした場所です（ここでは動かせません）。
            </p>
          </>
        )
      }
      timeline={
        <Timeline
          duration={duration}
          fps={fps}
          currentTime={time}
          onSeek={seek}
          selectedId={selected}
          onSelect={setSelected}
          onTrim={onTrim}
          tracks={[
            { id: 'telop', label: 'テロップ', regions: telopRegions, height: 44 },
            { id: 'cut', label: 'カット', regions: cutTrack, showSource: true, height: 34 },
          ]}
        />
      }
    />
  );
}
