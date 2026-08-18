/**
 * テロップ用フォントの読み込み。
 *
 * 🔴 相対パス（./fonts/...）で参照すること。
 * 絶対パス（/fonts/...）だと、配布時の file:// 読み込みで
 * ドライブ直下（C:/fonts/...）に解決されてフォントが載らない。
 * しかも**エラーにならず**フォールバックフォントで描かれるので、
 * 「なんか見た目が違う」としか分からない事故になる。
 *
 * 同梱フォントはすべて SIL Open Font License 1.1（商用利用・再配布可）。
 */

export const TELOP_FONTS: [family: string, url: string][] = [
  ['ZenKakuGothicNew', './fonts/ZenKakuGothicNew-Black.ttf'],
  ['DelaGothicOne', './fonts/DelaGothicOne-Regular.ttf'],
  ['ZenOldMincho', './fonts/ZenOldMincho-Bold.ttf'],
];

let loaded: Promise<string[]> | null = null;

/** 何度呼んでも読み込みは1回。描画前に必ず await すること。 */
export function loadTelopFonts(): Promise<string[]> {
  if (loaded) return loaded;

  loaded = (async () => {
    const families: string[] = [];
    for (const [family, url] of TELOP_FONTS) {
      const face = new FontFace(family, `url(${url})`);
      await face.load();
      document.fonts.add(face);
      families.push(family);
    }
    await document.fonts.ready;
    return families;
  })();

  return loaded;
}
