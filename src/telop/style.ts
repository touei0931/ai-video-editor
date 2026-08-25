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

/**
 * スタイル（雛形）の識別子。
 *
 * `normal` / `note` / `emphasis` の3つは**必ず存在する**。
 * sidecar/telop.py が発言内容と感情からこの3つのどれかを割り当ててくるので、
 * 消せるようにすると、割り当て先の無いテロップができてしまう。
 *
 * 利用者が足した枠は任意の文字列（`slot-…`）。自動では割り当てられず、
 * 画面で数字キーを押したときだけ付く。
 */
export type TelopStyleName = 'normal' | 'note' | 'emphasis' | (string & {});

/** 消せない3つ。sidecar が割り当ててくる先 */
export const BUILTIN_STYLES = ['normal', 'note', 'emphasis'] as const;

export function isBuiltinStyle(name: string): boolean {
  return (BUILTIN_STYLES as readonly string[]).includes(name);
}

/** 利用者が足す枠の上限。数字キー（1〜9）で押せる範囲に合わせる */
export const MAX_STYLES = 9;

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
   * 画面に出す名前。「通常」「補足」「強調」や、利用者が付けた「オノマトペ」など。
   * 見た目の一部ではないが、雛形と一緒に持ち運ぶものなのでここに置く。
   */
  label: string;
  /**
   * 既定の表示位置。
   *
   * 🔴 位置は雛形側に持たせること。
   *    テロップ1枚ずつが持っていると、300枚を上に移すのに300回操作することになる。
   *    位置は最初に一度決めて全部に適用するもの。
   */
  position: TelopPosition;
  fontFamily: string;
  /**
   * 太字にするか。
   *
   * 🔴 これは「見た目の設定」であると同時に**どのフォントファイルを使うかの指定**でもある。
   *    同梱書体は普通（400）と太字（700）を別ファイルで持っているので、
   *    ここが true のときだけ太いほうのファイルが使われる。
   *    既定を true にしてあるのは、それが今までの見た目（白の太ゴシック）だから。
   */
  bold?: boolean;
  /**
   * 斜体にするか。
   *
   * 日本語書体に斜体の実物は存在しないので、字を傾けて作る（編集ソフトと同じやり方）。
   */
  italic?: boolean;
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
 * 既定のスタイル一式。白の太ゴシック + 黒の太い縁取り。
 *
 * 🔴 置き場所は3つとも「下」。
 *    喋り主体の動画では画面の下にテロップを置くのが一般的で、
 *    上に出すと人物の顔や背景の情報にかぶりやすい。
 *    枠ごとに違う場所から始めると、揃えるのに全部触ることになる。
 *    変えたいときは雛形（style）側を一度直せば、その枠のテロップ全部に効く。
 */
export const DEFAULT_STYLES: StyleMap = {
  normal: {
    label: '通常',
    position: 'bottom',
    fontFamily: 'ZenKakuGothicNew',
    // 太字＝ Black のファイル。これまでの見た目をそのまま既定にしてある
    bold: true,
    fontSizeRatio: 0.085,
    color: '#ffffff',
    stroke: { color: '#000000', widthRatio: 0.16 },
    lineHeightRatio: 1.25,
    highlightColor: '#ffe14d',
    highlightScale: 1.15,
  },
  note: {
    label: '補足',
    position: 'bottom',
    fontFamily: 'ZenOldMincho',
    // 太字＝ Bold のファイル。これまでの見た目をそのまま既定にしてある
    bold: true,
    fontSizeRatio: 0.07,
    color: '#9fd8ff',
    stroke: { color: '#000000', widthRatio: 0.16 },
    lineHeightRatio: 1.3,
    highlightColor: '#ffe14d',
    highlightScale: 1.1,
  },
  emphasis: {
    label: '強調',
    position: 'bottom',
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
 * 雛形一式。
 * `normal` / `note` / `emphasis` は必ず入っている。利用者が足した枠はその後ろに続く。
 * 並び順は**入っている順**（数字キーの割り当てもこの順）。
 */
export type StyleMap = Record<TelopStyleName, TelopStyle>;

const POSITIONS: TelopPosition[] = ['top', 'middle', 'bottom'];

function isColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

function inRange(value: unknown, lo: number, hi: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= lo && value <= hi;
}

/**
 * 保存してある雛形を読み込める形に直す。
 *
 * 🔴 保存した既定は**次に使うときのアプリで読む**ものなので、
 *    書いたときと同じ形である保証がない（アプリを更新した／ファイルを手で触った／
 *    書き込み中に落ちた）。そのまま信じて描くと、色が undefined のまま
 *    Canvas に渡って**テロップが1枚も出ない**という壊れ方をする。
 *    しかも「既定として保存した設定」なので、作り直すまで毎回そうなる。
 *    分かる項目だけ受け取り、残りは既定で埋める。
 *
 * @param known 選べる書体。読み込めなかった書体は既定に戻す
 */
export function sanitizeStyles(raw: unknown, known?: readonly string[]): StyleMap {
  const out = structuredClone(DEFAULT_STYLES);
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;

  /*
    利用者が足した枠も受け取る。
    🔴 消せない3つ（normal / note / emphasis）は、保存内容に何が入っていても必ず残す。
       sidecar はこの3つのどれかを割り当ててくるので、消えると割り当て先が無くなる。
  */
  const extra = Object.keys(src).filter(
    (k) => !isBuiltinStyle(k) && src[k] && typeof src[k] === 'object',
  );
  for (const name of extra.slice(0, Math.max(0, MAX_STYLES - BUILTIN_STYLES.length))) {
    // 足した枠は「通常」を土台にする。土台が無いと色も大きさも未定義になる
    out[name] = { ...structuredClone(DEFAULT_STYLES.normal), label: name };
  }

  for (const name of Object.keys(out)) {
    const one = src[name];
    if (!one || typeof one !== 'object') continue;
    const s = one as Record<string, unknown>;
    const target = out[name];

    if (typeof s.label === 'string' && s.label.trim()) target.label = s.label.trim().slice(0, 12);
    if (typeof s.fontFamily === 'string' && (!known || known.includes(s.fontFamily))) {
      target.fontFamily = s.fontFamily;
    }
    if (typeof s.bold === 'boolean') target.bold = s.bold;
    if (typeof s.italic === 'boolean') target.italic = s.italic;
    if (POSITIONS.includes(s.position as TelopPosition)) target.position = s.position as TelopPosition;
    if (inRange(s.fontSizeRatio, 0.02, 0.3)) target.fontSizeRatio = s.fontSizeRatio;
    if (inRange(s.lineHeightRatio, 0.8, 3)) target.lineHeightRatio = s.lineHeightRatio;
    if (isColor(s.color)) target.color = s.color;
    if (isColor(s.highlightColor)) target.highlightColor = s.highlightColor;
    if (inRange(s.highlightScale, 0.5, 3)) target.highlightScale = s.highlightScale;

    const stroke = s.stroke as Record<string, unknown> | undefined;
    if (stroke && typeof stroke === 'object' && isColor(stroke.color)) {
      target.stroke = {
        color: stroke.color,
        widthRatio: inRange(stroke.widthRatio, 0, 0.5)
          ? stroke.widthRatio
          : (DEFAULT_STYLES[name]?.stroke?.widthRatio ?? 0.16),
      };
    }
  }

  return out;
}

/**
 * 名前を付けて保存した見た目のひと組。
 *
 * 🔴 1組を上書きするだけにしないこと。
 *    Vrew の「保存済み書式」、Premiere Pro の Local styles、
 *    Final Cut Pro の 2D Styles と、どの編集ソフトも
 *    「名前を付けて何組でも持ち、一覧から選び直す」形になっている。
 *    動画のジャンルごとに使い分ける、案を2つ作って見比べる、が
 *    1組だけだとできない。
 */
export interface StylePreset {
  name: string;
  styles: StyleMap;
}

/** 保存ファイルの中身 */
export interface StyleLibrary {
  presets: StylePreset[];
  /** 新しい動画を始めるときに使う組の名前。無ければアプリ最初の見た目 */
  current: string | null;
}

/** 保存する組数の上限。一覧から選べる範囲に収める */
export const MAX_PRESETS = 12;

/**
 * 保存ファイルを読み込める形に直す。
 *
 * 🔴 名前を付けて保存できるようにする前の形（雛形ひと組がそのまま入っている）も
 *    読めること。読めないと、それまで覚えさせた見た目が黙って消える。
 */
export function sanitizeLibrary(raw: unknown, known?: readonly string[]): StyleLibrary {
  const empty: StyleLibrary = { presets: [], current: null };
  if (!raw || typeof raw !== 'object') return empty;
  const src = raw as Record<string, unknown>;

  // 古い形（雛形ひと組がそのまま）。ひと組の保存として引き継ぐ
  if (!Array.isArray(src.presets)) {
    if (!isBuiltinStyle('normal') || !src.normal) return empty;
    const name = '前に保存した見た目';
    return { presets: [{ name, styles: sanitizeStyles(src, known) }], current: name };
  }

  const presets: StylePreset[] = [];
  for (const item of src.presets.slice(0, MAX_PRESETS)) {
    if (!item || typeof item !== 'object') continue;
    const one = item as Record<string, unknown>;
    const name = typeof one.name === 'string' ? one.name.trim().slice(0, 20) : '';
    if (!name || presets.some((p) => p.name === name)) continue;
    presets.push({ name, styles: sanitizeStyles(one.styles, known) });
  }

  const current =
    typeof src.current === 'string' && presets.some((p) => p.name === src.current)
      ? src.current
      : (presets[0]?.name ?? null);
  return { presets, current };
}

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
  /*
    🔴 知らない名前でも必ず何かを返すこと。

    枠を消したあとに、その枠を指したままのテロップが残ることがある
    （消す前に付けた1枚、古い下書き、手で書き換えられた保存ファイル）。
    undefined を返すと、色も大きさも未定義のまま Canvas に渡り、
    **そのテロップだけ1枚も描かれない**。しかも例外にならないので、
    書き出した動画を見るまで気づけない。
  */
  const base = styles[name] ?? styles.normal ?? DEFAULT_STYLES.normal;
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
