/**
 * テロップ用フォントの読み込み。
 *
 * 🔴 相対パス（./fonts/...）で参照すること。
 * 絶対パス（/fonts/...）だと、配布時の file:// 読み込みで
 * ドライブ直下（C:/fonts/...）に解決されてフォントが載らない。
 * しかも**エラーにならず**フォールバックフォントで描かれるので、
 * 「なんか見た目が違う」としか分からない事故になる。
 *
 * 🔴 太さは実物を持つこと。
 * 1書体につき1ファイルしか登録しないと、「太字」を選んだときに
 * ブラウザが輪郭を太らせて偽の太字を作る。日本語書体でこれをやると
 * 濁点や画数の多い漢字が潰れて読めなくなる。
 * 普通（400）と太字（700）の実物を登録しておけば、選んだとおりの字が出る。
 *
 * 🔴 同梱フォントに斜体（イタリック）の実物は無い。
 * これは手抜きではなく、日本語書体には元々イタリックが存在しないため。
 * 編集ソフトの「斜体」も同じく傾けているだけなので、ここでも傾けて作る。
 *
 * 同梱フォントはすべて SIL Open Font License 1.1（商用利用・再配布可）。
 */

/** 太字として使う太さ。CSS の font-weight と同じ意味 */
export const BOLD_WEIGHT = 700;
export const NORMAL_WEIGHT = 400;

export interface TelopFamily {
  /** ctx.font に書く名前 */
  family: string;
  /** 画面に出す名前 */
  label: string;
  /**
   * macOS の書体名。Final Cut Pro へ渡すタイムラインにはこちらを書く。
   *
   * 🔴 ctx.font 用の名前（空白なし）をそのまま書かないこと。
   *    Final Cut は「ZenKakuGothicNew」という書体を知らないので、
   *    **警告も出さずに別の書体で開く**（たいていヒラギノ）。
   *    OS が持つ書体名は空白入りの「Zen Kaku Gothic New」。
   */
  macFamily: string;
  /** 太さごとのファイル。face は macOS 側のスタイル名（Final Cut の fontFace） */
  faces: { weight: number; url: string; face: string }[];
}

/**
 * 選べる書体。
 *
 * 見出しに使う書体を4つに絞ってある。増やすほど起動時の読み込みが延び、
 * 配布物も1書体あたり 2〜5MB 増える。
 * 「ゴシック / 丸ゴシック / 明朝 / インパクト」でテロップの用途はほぼ埋まる。
 */
export const TELOP_FAMILIES: TelopFamily[] = [
  {
    family: 'ZenKakuGothicNew',
    label: 'ゴシック体',
    macFamily: 'Zen Kaku Gothic New',
    faces: [
      { weight: NORMAL_WEIGHT, url: './fonts/ZenKakuGothicNew-Regular.ttf', face: 'Regular' },
      { weight: BOLD_WEIGHT, url: './fonts/ZenKakuGothicNew-Black.ttf', face: 'Black' },
    ],
  },
  {
    family: 'ZenMaruGothic',
    label: '丸ゴシック体',
    macFamily: 'Zen Maru Gothic',
    faces: [
      { weight: NORMAL_WEIGHT, url: './fonts/ZenMaruGothic-Regular.ttf', face: 'Regular' },
      { weight: BOLD_WEIGHT, url: './fonts/ZenMaruGothic-Black.ttf', face: 'Black' },
    ],
  },
  {
    family: 'ZenOldMincho',
    label: '明朝体',
    macFamily: 'Zen Old Mincho',
    faces: [
      { weight: NORMAL_WEIGHT, url: './fonts/ZenOldMincho-Regular.ttf', face: 'Regular' },
      { weight: BOLD_WEIGHT, url: './fonts/ZenOldMincho-Bold.ttf', face: 'Bold' },
    ],
  },
  {
    // 元から極太の見出し書体で、太さの種類が1つしか無い。
    // 太字を選ぶと輪郭を太らせた偽の太字になるので、画面でその旨を出す。
    family: 'DelaGothicOne',
    label: 'インパクト',
    macFamily: 'Dela Gothic One',
    faces: [{ weight: NORMAL_WEIGHT, url: './fonts/DelaGothicOne-Regular.ttf', face: 'Regular' }],
  },
];

/** その書体に「太字の実物」があるか。無ければ輪郭を太らせた偽の太字になる */
export function hasRealBold(family: string): boolean {
  const found = TELOP_FAMILIES.find((f) => f.family === family);
  return Boolean(found?.faces.some((f) => f.weight === BOLD_WEIGHT));
}

export function familyLabel(family: string): string {
  return TELOP_FAMILIES.find((f) => f.family === family)?.label ?? family;
}

export interface LoadedFonts {
  /** 1つでも読み込めた書体。画面の選択肢はこれに絞る */
  families: string[];
  /** 読み込めなかったファイル。0件が正常 */
  missing: string[];
}

let loaded: Promise<LoadedFonts> | null = null;

/**
 * 何度呼んでも読み込みは1回。描画前に必ず await すること。
 *
 * 🔴 1つ読めなくても全部を止めない。
 *    以前は順番に await していたので、1ファイル欠けただけでテロップ画面に
 *    たどり着けなかった。読めたものだけで進み、欠けたものは選択肢から外す。
 *    7ファイルで 24MB あるため、まとめて読むのと順番に読むのでは待ち時間も違う。
 */
export function loadTelopFonts(): Promise<LoadedFonts> {
  if (loaded) return loaded;

  loaded = (async () => {
    const missing: string[] = [];
    const ok = new Set<string>();

    await Promise.all(
      TELOP_FAMILIES.flatMap((entry) =>
        entry.faces.map(async (face) => {
          try {
            const loadedFace = await new FontFace(entry.family, `url(${face.url})`, {
              weight: String(face.weight),
            }).load();
            document.fonts.add(loadedFace);
            ok.add(entry.family);
          } catch {
            missing.push(face.url);
          }
        }),
      ),
    );

    await document.fonts.ready;
    return {
      families: TELOP_FAMILIES.map((f) => f.family).filter((f) => ok.has(f)),
      missing,
    };
  })();

  return loaded;
}

/**
 * Final Cut Pro へ渡すときの書体の指定。
 *
 * 🔴 同梱書体は**アプリの中にしか無い**。友達の Mac に入っていなければ、
 *    Final Cut は警告も出さずに別の書体で開く。
 *    書き出しのときにフォントファイルも一緒に置いて、
 *    一度だけ入れてもらう（docs/はじめての使い方.md）。
 */
export function macFontOf(
  family: string,
  bold?: boolean,
): { font: string; face: string; file: string } {
  const found = TELOP_FAMILIES.find((f) => f.family === family) ?? TELOP_FAMILIES[0];
  const want = bold ? BOLD_WEIGHT : NORMAL_WEIGHT;
  // 太字の実物が無い書体では、普通の太さのファイルを指す（画面と同じ扱い）
  const face = found.faces.find((f) => f.weight === want) ?? found.faces[0];
  return { font: found.macFamily, face: face.face, file: face.url.replace('./fonts/', '') };
}
