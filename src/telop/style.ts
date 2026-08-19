/**
 * テロップのスタイル定義（設計レポート §6.3）。
 *
 * 拡張性の担保のしかた:
 *   友達の現在の要求は「白の太ゴシック + 黒の太い縁取り」だけだが、
 *   「後から装飾を追加できること」が条件だった。そこで
 *   **グラデーション・二重縁取り・背景・アニメのフィールドは最初からスキーマに定義しておき、
 *   実装だけ後回しにする**。スキーマが後から変わると保存済みプロジェクトの
 *   マイグレーションが必要になるので、器だけ先に作っておく。
 */

/** 発言内容と感情から自動判定されるスタイル種別（②）。 */
export type TelopStyleName = 'normal' | 'note' | 'emphasis';

/** 画面内の縦位置。顔にかぶるときに人間が動かせるよう3段階（§1.3）。 */
export type TelopPosition = 'top' | 'middle' | 'bottom';

export interface TelopStroke {
  color: string;
  /** フォントサイズに対する比率 */
  widthRatio: number;
}

export interface TelopStyle {
  fontFamily: string;
  /** 画面幅に対する比率。解像度が変わっても同じ見た目になるようにする */
  fontSizeRatio: number;
  color: string;
  stroke?: TelopStroke;
  /** 行送り。フォントサイズに対する比率 */
  lineHeightRatio: number;

  // ── ここから下は Phase 2 では未実装。スキーマだけ先に定義しておく ──
  gradient?: { from: string; to: string; angleDeg: number };
  secondStroke?: TelopStroke;
  background?: { color: string; paddingRatio: number; radiusRatio: number };
  shadow?: { color: string; blurRatio: number; offsetXRatio: number; offsetYRatio: number };
  animation?: 'none' | 'fadeIn' | 'popIn';
}

/**
 * 既定のスタイル一式。
 * 通常は友達の実際のテロップ（白の太ゴシック + 黒の太い縁取り、画面上部中央）に合わせてある。
 */
export const DEFAULT_STYLES: Record<TelopStyleName, TelopStyle> = {
  normal: {
    fontFamily: 'ZenKakuGothicNew',
    fontSizeRatio: 0.085,
    color: '#ffffff',
    stroke: { color: '#000000', widthRatio: 0.16 },
    lineHeightRatio: 1.25,
  },
  note: {
    fontFamily: 'ZenOldMincho',
    fontSizeRatio: 0.07,
    color: '#9fd8ff',
    stroke: { color: '#000000', widthRatio: 0.16 },
    lineHeightRatio: 1.3,
  },
  emphasis: {
    fontFamily: 'DelaGothicOne',
    fontSizeRatio: 0.1,
    color: '#ff3b30',
    stroke: { color: '#ffffff', widthRatio: 0.18 },
    lineHeightRatio: 1.2,
  },
};

export interface TelopSpec {
  /** 表示する行。改行位置は BudouX が文節単位で決める（§6.6 / T2） */
  lines: string[];
  style: TelopStyle;
  position: TelopPosition;
  /**
   * 既定位置からのずらし量。画面の幅・高さに対する比率。
   * 顔にかぶるときなど、人間が手で動かすために使う（§1.3）。
   */
  offsetX?: number;
  offsetY?: number;
}

/** 1枚だけ既定スタイルから変えたいときの上書き。 */
export interface TelopOverride {
  color?: string;
  strokeColor?: string;
  /** 文字の大きさ。既定に対する倍率 */
  sizeScale?: number;
}

/**
 * 実際に描くスタイルを決める。
 *
 * 🔴 プレビューも書き出しも必ずこの関数を通すこと。
 *    どちらかが別の計算をした瞬間に「プレビューと書き出しが違う」が始まる（§6）。
 */
export function resolveStyle(
  styles: Record<TelopStyleName, TelopStyle>,
  name: TelopStyleName,
  override?: TelopOverride,
  fontScale = 1,
): TelopStyle {
  const base = styles[name];
  const size = base.fontSizeRatio * fontScale * (override?.sizeScale ?? 1);
  return {
    ...base,
    fontSizeRatio: size,
    color: override?.color ?? base.color,
    stroke: base.stroke
      ? { ...base.stroke, color: override?.strokeColor ?? base.stroke.color }
      : override?.strokeColor
        ? { color: override.strokeColor, widthRatio: 0.16 }
        : undefined,
  };
}
