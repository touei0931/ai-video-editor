/**
 * タイムライン。編集ソフトで言うところの「下の帯」。
 *
 * 🔴 この部品が存在する理由は「端をドラッグして伸縮できること」。
 *    友達の指摘は「カット余白を伸ばしたりもしづらい」だった。
 *    以前は境界の調整がボタン（←→）でしかできず、
 *    しかも素材全体のどこを触っているのかが画面から分からなかった。
 *
 * 守る約束:
 *   - 秒とピクセルの換算は pxPerSec ただ一つを通す。ここを分けると必ずずれる
 *   - ドラッグ中は確定させない。確定は pointerup の一度だけ（onTrim）
 *   - フレームに吸着させる。素材の fps 未満の精度で切っても意味が無い
 *   - 掴んでいる間、動かした量を数値でその場に出す（何フレーム伸ばしたか分からないと戻せない）
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type RegionKind = 'cut' | 'keep' | 'hold' | 'telop' | 'music';

export interface TimelineRegion {
  id: string;
  /** 元素材での開始・終了（秒） */
  start: number;
  end: number;
  kind: RegionKind;
  label?: string;
  /** 端をドラッグできないもの（テロップの帯など） */
  fixed?: boolean;
}

export interface TimelineTrack {
  id: string;
  label: string;
  regions: TimelineRegion[];
  /** 背景に素材の帯を敷くか（カットのトラックだけ） */
  showSource?: boolean;
  height?: number;
  /**
   * 区間の代わりに自前で描くレーン（音の波・映像のコマ）。
   * 拡大率と、いま見えている範囲を受け取る。
   *
   * 🔴 見えている範囲を渡すのが要点。
   *    素材全体を一度に描こうとすると、20分の素材で固まる。
   *    コマの取り出しは重いので、見えている分だけ作る。
   */
  render?(view: TimelineView): ReactNode;
}

export interface TimelineView {
  /** 1秒あたりの画素数 */
  scale: number;
  /** 見えている左端（秒） */
  from: number;
  /** 見えている右端（秒） */
  to: number;
  /** レーンの高さ（画素） */
  height: number;
  /** 素材全体の長さ（秒） */
  duration: number;
}

export interface TimelineProps {
  /** 素材の長さ（秒） */
  duration: number;
  fps: number;
  currentTime: number;
  onSeek(time: number): void;
  tracks: TimelineTrack[];
  selectedId?: string | null;
  onSelect(id: string | null): void;
  /** 端をドラッグし終えたときに一度だけ呼ばれる */
  onTrim?(id: string, start: number, end: number): void;
  /** 拡大率の初期値。省略すると尺全体が収まる倍率から始める */
  initialPxPerSec?: number;
  /**
   * ここに指定した区間へ自動で寄る。外側（インスペクタや「次へ」）で
   * 選び直したときに、タイムライン側も同じ場所を映すために使う。
   */
  focusId?: string | null;
  /**
   * 目盛りの右に置く追加の操作（時間軸の切り替えなど）。
   */
  extraControls?: ReactNode;
}

/**
 * 掴める最低幅（px）。これを下回るクリップは端を掴めないので自動で寄る。
 *
 * 🔴 つまみは左右で 11px ずつある。全体表示だと 10分の素材で 2.4秒のクリップが
 *    5px にしかならず、つまみ同士が重なって**どちらも掴めない**。
 *    友達の「カット余白を伸ばしづらい」はここ。拡大を人任せにしない。
 */
const GRABBABLE = 64;

/** 0:00.0 形式。タイムラインの目盛りは短いほうが読みやすい */
function tick(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
}

/** 1:23.45 形式。数値の読み上げに使う */
export function clock(sec: number): string {
  const m = Math.floor(Math.abs(sec) / 60);
  const s = Math.abs(sec) % 60;
  const sign = sec < 0 ? '-' : '';
  return `${sign}${m}:${s.toFixed(2).padStart(5, '0')}`;
}

/** 目盛りの間隔。拡大率に応じて、ラベルが重ならない刻みを選ぶ */
const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
function chooseStep(pxPerSec: number): number {
  const wanted = 70 / pxPerSec; // ラベル1つに最低70px
  return STEPS.find((s) => s >= wanted) ?? STEPS[STEPS.length - 1];
}

/** ドラッグ中の状態。確定前の値はここだけに持つ */
interface Dragging {
  id: string;
  edge: 'start' | 'end' | 'move';
  originStart: number;
  originEnd: number;
  originX: number;
  start: number;
  end: number;
}

const MIN_LEN = 0.04; // 区間の下限（秒）。潰れると掴めなくなる

export function Timeline({
  duration,
  fps,
  currentTime,
  onSeek,
  tracks,
  selectedId,
  onSelect,
  onTrim,
  initialPxPerSec,
  focusId,
  extraControls,
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pxPerSec, setPxPerSec] = useState(initialPxPerSec ?? 0);
  const [drag, setDrag] = useState<Dragging | null>(null);
  // ドラッグ中の最新値。確定時に描画の外から読むために持つ（下の up を参照）
  const dragRef = useRef<Dragging | null>(null);
  dragRef.current = drag;

  // 尺全体が収まる倍率を初期値にする。開いた瞬間に全体が見えていないと
  // 「素材のどこを見ているか」が分からない（作り直しの発端になった指摘）
  useEffect(() => {
    if (pxPerSec > 0 || !duration) return;
    const w = scrollRef.current?.clientWidth ?? 900;
    setPxPerSec(Math.max(2, (w - 24) / duration));
  }, [duration, pxPerSec]);

  const scale = pxPerSec || 10;
  const width = Math.max(320, duration * scale);
  const step = useMemo(() => chooseStep(scale), [scale]);

  const snap = useCallback(
    (t: number, fine: boolean) => {
      const clamped = Math.min(duration, Math.max(0, t));
      if (fine) return Number(clamped.toFixed(3));
      const f = Math.round(clamped * fps);
      return Number((f / fps).toFixed(3));
    },
    [duration, fps],
  );

  /* --- 再生位置を動かす --- */
  const seekFromEvent = useCallback(
    (clientX: number, el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      onSeek(Math.min(duration, Math.max(0, (clientX - rect.left) / scale)));
    },
    [duration, onSeek, scale],
  );

  /**
   * 再生位置のドラッグ（スクラブ）。
   *
   * 🔴 押した瞬間に1回動かすだけにしないこと。
   *    編集ソフトの目盛りは、押したまま左右に動かすと映像が追いてくる。
   *    クリックだけだと、目当ての場所を一発で当てにいく操作になり、
   *    行ったり来たりが必要な確認作業に向かない。
   */
  const [scrubbing, setScrubbing] = useState(false);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  /** いま見えている範囲。重いレーン（波形・コマ）に渡す */
  const [view, setView] = useState({ left: 0, width: 900 });

  const startScrub = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      setScrubbing(true);
      if (canvasRef.current) seekFromEvent(e.clientX, canvasRef.current);
    },
    [seekFromEvent],
  );

  useEffect(() => {
    if (!scrubbing) return;
    const move = (e: PointerEvent) => {
      if (canvasRef.current) seekFromEvent(e.clientX, canvasRef.current);
    };
    const up = () => setScrubbing(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [scrubbing, seekFromEvent]);

  /* --- 端のドラッグ --- */
  const startDrag = useCallback(
    (e: React.PointerEvent, r: TimelineRegion, edge: Dragging['edge']) => {
      if (r.fixed) return;
      e.stopPropagation();
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      onSelect(r.id);
      setDrag({
        id: r.id,
        edge,
        originStart: r.start,
        originEnd: r.end,
        originX: e.clientX,
        start: r.start,
        end: r.end,
      });
    },
    [onSelect],
  );

  useEffect(() => {
    if (!drag) return;

    const move = (e: PointerEvent) => {
      const d = (e.clientX - drag.originX) / scale;
      const fine = e.shiftKey; // Shift で吸着を外す
      setDrag((cur) => {
        if (!cur) return cur;
        if (cur.edge === 'move') {
          const len = cur.originEnd - cur.originStart;
          let s = snap(cur.originStart + d, fine);
          s = Math.min(Math.max(0, s), Math.max(0, duration - len));
          return { ...cur, start: s, end: Number((s + len).toFixed(3)) };
        }
        if (cur.edge === 'start') {
          const s = Math.min(snap(cur.originStart + d, fine), cur.originEnd - MIN_LEN);
          return { ...cur, start: Math.max(0, s) };
        }
        const en = Math.max(snap(cur.originEnd + d, fine), cur.originStart + MIN_LEN);
        return { ...cur, end: Math.min(duration, en) };
      });
    };

    /*
      🔴 確定は setDrag の更新関数の**外**でやること。

      更新関数は React の描画中に走るので、その中で親の state を触ると
      「Cannot update a component while rendering a different component」になる。
      動いてはいるが、描画の途中で親を書き換えているので、
      いつ壊れてもおかしくない状態になる。最新値は ref から読む。
    */
    const up = () => {
      const cur = dragRef.current;
      if (cur && onTrim && (cur.start !== cur.originStart || cur.end !== cur.originEnd)) {
        onTrim(cur.id, cur.start, cur.end);
      }
      setDrag(null);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [drag, duration, onTrim, scale, snap]);

  /* --- 拡大縮小 --- */
  const zoom = useCallback(
    (factor: number, anchorSec?: number) => {
      const el = scrollRef.current;
      const before = anchorSec ?? currentTime;
      setPxPerSec((p) => {
        const next = Math.min(400, Math.max(1, (p || 10) * factor));
        if (el) {
          // 拡大の中心を保つ。ここを省くと拡大するたびに見ていた場所を見失う
          requestAnimationFrame(() => {
            el.scrollLeft = Math.max(0, before * next - el.clientWidth / 2);
          });
        }
        return next;
      });
    },
    [currentTime],
  );

  const fit = useCallback(() => {
    const w = scrollRef.current?.clientWidth ?? 900;
    if (duration > 0) setPxPerSec(Math.max(1, (w - 24) / duration));
  }, [duration]);

  const all = useMemo(() => tracks.flatMap((t) => t.regions), [tracks]);

  /**
   * その区間が掴める大きさになるまで寄って、画面の中央に置く。
   *
   * 前後の余白も一緒に映す。カットの良し悪しは「その前後がどう繋がるか」で
   * 決まるので、区間だけ大写しにしても判断できない。
   */
  const focus = useCallback(
    (id: string) => {
      const r = all.find((x) => x.id === id);
      const el = scrollRef.current;
      if (!r || !el) return;
      const len = Math.max(0.05, r.end - r.start);
      const view = el.clientWidth || 900;
      // 区間が画面の約35%を占める倍率。前後に約1.8倍の余白が残る
      const want = Math.min(300, Math.max(4, (view * 0.35) / len));
      setPxPerSec(want);
      requestAnimationFrame(() => {
        el.scrollLeft = Math.max(0, ((r.start + r.end) / 2) * want - view / 2);
      });
    },
    [all],
  );

  // 外から選び直されたら、そこへ寄る（インスペクタや「次へ」からの操作）
  useEffect(() => {
    if (focusId) focus(focusId);
  }, [focusId, focus]);

  // ctrl + ホイールで拡大縮小（編集ソフトの慣習）
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      const at = (e.clientX - rect.left + (scrollRef.current?.scrollLeft ?? 0)) / scale;
      zoom(e.deltaY < 0 ? 1.25 : 0.8, at);
    },
    [scale, zoom],
  );

  // 再生位置が画面の外に出たら追いかける
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || drag) return;
    const x = currentTime * scale;
    if (x < el.scrollLeft + 40 || x > el.scrollLeft + el.clientWidth - 40) {
      el.scrollLeft = Math.max(0, x - el.clientWidth / 2);
    }
  }, [currentTime, drag, scale]);

  const ticks = useMemo(() => {
    const out: { t: number; major: boolean }[] = [];
    for (let t = 0; t <= duration + 0.001; t += step) {
      out.push({ t: Number(t.toFixed(3)), major: true });
    }
    return out;
  }, [duration, step]);

  const shown = useCallback(
    (r: TimelineRegion) => (drag && drag.id === r.id ? { start: drag.start, end: drag.end } : r),
    [drag],
  );

  return (
    <section className="fcp-timeline" aria-label="タイムライン">
      <div className="fcp-tl-bar">
        <span className="fcp-dim">タイムライン</span>
        {extraControls}
        <div className="fcp-spacer" />
        <span className="fcp-dim" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {clock(currentTime)} / {clock(duration)}
        </span>
        <button className="icon" onClick={() => zoom(0.8)} title="縮小（Ctrl+ホイール）">
          −
        </button>
        <button className="icon" onClick={() => zoom(1.25)} title="拡大（Ctrl+ホイール）">
          ＋
        </button>
        <button onClick={fit} title="全体を表示">
          全体
        </button>
      </div>

      <div
        className="fcp-tl-scroll"
        ref={scrollRef}
        onWheel={onWheel}
        onScroll={(e) =>
          setView({ left: e.currentTarget.scrollLeft, width: e.currentTarget.clientWidth })
        }
      >
        <div className="fcp-tl-canvas" style={{ width }} ref={canvasRef}>
          <div
            className="fcp-ruler"
            onPointerDown={startScrub}
            role="slider"
            aria-label="再生位置"
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={currentTime}
            tabIndex={0}
          >
            {ticks.map((t) => (
              <div key={t.t} className="fcp-tick" style={{ left: t.t * scale }}>
                {tick(t.t)}
              </div>
            ))}
          </div>

          {tracks.map((track) => (
            <div className="fcp-track" key={track.id}>
              <span className="fcp-track-label">{track.label}</span>
              <div
                className="fcp-track-body"
                style={{ ['--track-h' as string]: `${track.height ?? 56}px` }}
                onPointerDown={(e) => {
                  if (e.target === e.currentTarget) {
                    onSelect(null);
                    seekFromEvent(e.clientX, e.currentTarget);
                  }
                }}
              >
                {track.showSource && <div className="fcp-source" />}

                {track.render?.({
                  scale,
                  from: view.left / scale,
                  to: (view.left + view.width) / scale,
                  height: track.height ?? 56,
                  duration,
                })}

                {track.regions.map((r) => {
                  const v = shown(r);
                  const left = v.start * scale;
                  const w = Math.max(3, (v.end - v.start) * scale);
                  const isDragging = drag?.id === r.id;
                  const moved = isDragging
                    ? Math.round((v.start - drag.originStart) * fps)
                    : 0;
                  const movedEnd = isDragging ? Math.round((v.end - drag.originEnd) * fps) : 0;
                  return (
                    <div
                      key={r.id}
                      className={[
                        'fcp-clip',
                        `kind-${r.kind}`,
                        selectedId === r.id ? 'selected' : '',
                        isDragging ? 'trimming' : '',
                        w < 26 ? 'narrow' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={{ left, width: w }}
                      onPointerDown={(e) => {
                        onSelect(r.id);
                        // 掴める大きさに足りないなら、その場で寄る。
                        // 「拡大してから掴んでください」を人にやらせない。
                        if (!r.fixed && w < GRABBABLE) {
                          focus(r.id);
                          return;
                        }
                        /*
                          🔴 本体を掴んだらそのまま動かせること。
                             以前は Alt を押しながらでないと動かせなかった。
                             編集ソフトのクリップは掴めば動く。修飾キーは要らない。
                             （端のつまみは伸縮。本体は移動、と役割を分ける）
                        */
                        if (!r.fixed) startDrag(e, r, 'move');
                      }}
                      title={`${clock(v.start)} 〜 ${clock(v.end)}（${(v.end - v.start).toFixed(2)}秒）`}
                    >
                      <span className="cap" />
                      {w > 44 && <span className="name">{r.label ?? ''}</span>}
                      {!r.fixed && (
                        <>
                          <span
                            className="fcp-handle left"
                            onPointerDown={(e) => startDrag(e, r, 'start')}
                            title="ここをドラッグして始まりを動かす"
                          />
                          <span
                            className="fcp-handle right"
                            onPointerDown={(e) => startDrag(e, r, 'end')}
                            title="ここをドラッグして終わりを動かす"
                          />
                        </>
                      )}
                      {isDragging && (
                        <span
                          className="fcp-trim-readout"
                          style={{ left: drag.edge === 'end' ? undefined : 0, right: drag.edge === 'end' ? 0 : undefined }}
                        >
                          {drag.edge === 'move'
                            ? `${moved >= 0 ? '+' : ''}${moved}f 移動`
                            : drag.edge === 'start'
                              ? `始まり ${moved >= 0 ? '+' : ''}${moved}f`
                              : `終わり ${movedEnd >= 0 ? '+' : ''}${movedEnd}f`}
                          {' / '}
                          {(v.end - v.start).toFixed(2)}秒
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/*
            再生位置。線そのものは 1px なので掴めない。
            🔴 見た目の細さと、掴める幅を分けること。
               当たり判定を線と同じ太さにすると、狙って掴むのが苦行になる。
          */}
          <div
            className={`fcp-playhead ${scrubbing ? 'grabbing' : ''}`}
            style={{ left: currentTime * scale }}
          >
            <span className="grip" onPointerDown={startScrub} title="ドラッグで再生位置を動かせます" />
          </div>
        </div>
      </div>
    </section>
  );
}
