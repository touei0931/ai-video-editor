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

/**
 * 画面の上下でこの割合は「置いてはいけない領域」。
 *
 * TikTok のキャプション・ユーザー名帯、YouTube Shorts のタイトル行が乗る場所で、
 * ここにテロップを置くと投稿先のUIに隠れる。
 * プレビューに枠として出し、既定位置もこの内側に収める。
 */
export const SAFE_AREA_RATIO = { top: 0.12, bottom: 0.15 };

export interface TelopStroke {
  color: string;
  /** フォントサイズに対する比率 */
  widthRatio: number;
}

export interface TelopStyle {
  /**
   * 既定の表示位置。
   *
   * 🔴 位置は雛形側に持たせること。
   *    テロップ1枚ずつが持っていると、300枚を上に移すのに300回操作することになる。
   *    位置は最初に一度決めて全部に適用するもの。
   */
  position: TelopPosition;
  fontFamily: string;
  /** 画面幅に対する比率。解像度が変わっても同じ見た目になるようにする */
  fontSizeRatio: number;
  color: string;
  stroke?: TelopStroke;
  /** 行送り。フォントサイズに対する比率 */
  lineHeightRatio: number;
  /** 強調する語の色と大きさ（「この5文字だけ黄色く大きく」用） */
  highlightColor?: string;
  highlightScale?: number;

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
    position: 'top',
    fontFamily: 'ZenKakuGothicNew',
    fontSizeRatio: 0.085,
    color: '#ffffff',
    stroke: { color: '#000000', widthRatio: 0.16 },
    lineHeightRatio: 1.25,
    highlightColor: '#ffe14d',
    highlightScale: 1.15,
  },
  note: {
    position: 'bottom',
    fontFamily: 'ZenOldMincho',
    fontSizeRatio: 0.07,
    color: '#9fd8ff',
    stroke: { color: '#000000', widthRatio: 0.16 },
    lineHeightRatio: 1.3,
    highlightColor: '#ffe14d',
    highlightScale: 1.1,
  },
  emphasis: {
    position: 'middle',
    fontFamily: 'DelaGothicOne',
    fontSizeRatio: 0.1,
    color: '#ff3b30',
    stroke: { color: '#ffffff', widthRatio: 0.18 },
    lineHeightRatio: 1.2,
    highlightColor: '#ffe14d',
    highlightScale: 1.15,
  },
};

/**
 * 行の中の一区切り。
 *
 * 🔴 日本語テロップで一番使う技法は「**この5文字だけ黄色く大きく**」。
 *    行を1色で描く実装だとこれが構造的にできない。
 *    そこで行を「区切りの列」として持ち、区切りごとに色と大きさを変えられるようにする。
 *    何も指定しなければ行全体が1区切りになるので、単色の場合と結果は変わらない。
 */
export interface TelopSpan {
  text: string;
  /** 未指定ならスタイルの色 */
  color?: string;
  /** 未指定ならスタイルの縁の色 */
  strokeColor?: string;
  /** 文字の大きさ。行の基準サイズに対する倍率 */
  scale?: number;
}

export type TelopLine = string | TelopSpan[];

export interface TelopSpec {
  /** 表示する行。改行位置は BudouX が文節単位で決める（§6.6 / T2） */
  lines: TelopLine[];
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
    position: base.position,
    color: override?.color ?? base.color,
    stroke: base.stroke
      ? { ...base.stroke, color: override?.strokeColor ?? base.stroke.color }
      : override?.strokeColor
        ? { color: override.strokeColor, widthRatio: 0.16 }
        : undefined,
  };
}
