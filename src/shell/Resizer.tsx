/**
 * パネルの境目。掴んで動かすと幅や高さが変わる。
 *
 * 🔴 変えた値は覚えておくこと。
 *    画面を移るたびに戻ると、そのたびに調整し直すことになる。
 *    編集ソフトのレイアウトは一度決めたら固定するもの。
 *
 * 🔴 掴める幅を狭くしすぎないこと。
 *    見た目は1〜2pxの線でも、当たり判定は 8px 以上ないと狙えない。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const STORE_KEY = 'pac.layout';

type Layout = { inspector: number; timeline: number };

const DEFAULTS: Layout = { inspector: 340, timeline: 320 };

/** 端に寄せきって使えなくならないための下限・上限 */
const LIMITS = {
  inspector: { min: 240, max: 640 },
  timeline: { min: 150, max: 760 },
};

function load(): Layout {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Layout>;
      return {
        inspector: clamp('inspector', p.inspector ?? DEFAULTS.inspector),
        timeline: clamp('timeline', p.timeline ?? DEFAULTS.timeline),
      };
    }
  } catch {
    /* 壊れていても既定で続ける */
  }
  return DEFAULTS;
}

function clamp(which: keyof Layout, v: number): number {
  const { min, max } = LIMITS[which];
  return Math.min(max, Math.max(min, Math.round(v)));
}

/**
 * 骨格の幅・高さを持つ。EditorShell から使う。
 * 値は CSS 変数として渡すので、レイアウトの計算は CSS 側に任せられる。
 */
export function useLayout() {
  const [layout, setLayout] = useState<Layout>(load);

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(layout));
    } catch {
      /* 保存できなくても操作は続く */
    }
  }, [layout]);

  const set = useCallback((which: keyof Layout, v: number) => {
    setLayout((l) => ({ ...l, [which]: clamp(which, v) }));
  }, []);

  const reset = useCallback(() => setLayout(DEFAULTS), []);

  return { layout, set, reset };
}

export interface ResizerProps {
  /** 'col' = 左右に動かす（インスペクタの幅） / 'row' = 上下に動かす（タイムラインの高さ） */
  direction: 'col' | 'row';
  /** いまの値（px） */
  value: number;
  onChange(v: number): void;
  /**
   * 動かす向き。
   * インスペクタは右端にあるので、左へ引くと広くなる（invert）。
   * タイムラインは下端にあるので、上へ引くと高くなる（invert）。
   */
  invert?: boolean;
  label: string;
}

export function Resizer({ direction, value, onChange, invert, label }: ResizerProps) {
  const start = useRef<{ pos: number; value: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      start.current = { pos: direction === 'col' ? e.clientX : e.clientY, value };
      setDragging(true);
    },
    [direction, value],
  );

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const s = start.current;
      if (!s) return;
      const now = direction === 'col' ? e.clientX : e.clientY;
      const d = (now - s.pos) * (invert ? -1 : 1);
      onChange(s.value + d);
    };
    const up = () => {
      start.current = null;
      setDragging(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [dragging, direction, invert, onChange]);

  return (
    <div
      className={`fcp-resizer ${direction} ${dragging ? 'dragging' : ''}`}
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation={direction === 'col' ? 'vertical' : 'horizontal'}
      aria-label={label}
      title={`${label}（ドラッグで変えられます）`}
      tabIndex={0}
      onKeyDown={(e) => {
        // キーボードでも動かせるようにする
        const step = e.shiftKey ? 40 : 10;
        if (direction === 'col' && e.key === 'ArrowLeft') onChange(value + (invert ? step : -step));
        else if (direction === 'col' && e.key === 'ArrowRight') onChange(value + (invert ? -step : step));
        else if (direction === 'row' && e.key === 'ArrowUp') onChange(value + (invert ? step : -step));
        else if (direction === 'row' && e.key === 'ArrowDown') onChange(value + (invert ? -step : step));
        else return;
        e.preventDefault();
      }}
    />
  );
}
