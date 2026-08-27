/**
 * 並べたタイムラインを Final Cut Pro の XML にする。
 *
 * sidecar/fcpxml.py とは別物。あちらは「1本の素材のどこを残すか」だけを書き出す。
 * こちらは素材が複数あり、レーンが重なる。
 *
 * 🔴 中身の並びは決まっている。守らないと XML ごと読み込みを断られる。
 *    そのとき出るのは「DTD の検証でエラーが起きました」だけで、
 *    どのクリップが原因かは分からない。実際に2度踏んだ。
 *
 *      library    … 属性を付けない（name という属性は無い）
 *      sequence   … 中に置けるのは spine だけ
 *      title      … param → adjust-transform → text → text-style-def の順
 *      text-style-def … id は書類の中で1つきり
 *
 * 🔴 時刻はフレームの境に乗せること。
 *    秒のまま書くと、Final Cut が丸めた結果とこちらの計算がずれ、
 *    クリップの間に1フレームの隙間や重なりができる。
 *    20分の素材なら数十箇所で映像が一瞬途切れる。
 *
 * 🔴 重ねたものの offset は「親の時間」で書くこと。
 *    ぶら下げたクリップやテロップの offset は、タイムライン上の時刻ではなく
 *    **親クリップの中の時刻**で数える。ここを取り違えると、
 *    素材の途中から使っているクリップの上で、テロップが丸ごとずれる。
 */

import { isGap, layout, placedTelops, timelineDuration, type Project } from './project';
import { fcpLook } from '../telop/render';
import { macFontOf } from '../telop/fonts';
import { resolveStyle } from '../telop/style';

export const FCPXML_VERSION = '1.13';

/** Basic Title の見た目。雛形を渡さないときの既定 */
const BASIC_TITLE_UID =
  '.../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti';

export interface ExportOptions {
  /** 作品の名前 */
  name?: string;
  fps?: number;
  width?: number;
  height?: number;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** ファイルの場所を file:// の形にする */
export function fileUrl(path: string): string {
  const p = path.replace(/\\/g, '/');
  const withSlash = p.startsWith('/') ? p : `/${p}`;
  // 🔴 区切りは残すこと。まとめて encodeURIComponent すると / まで潰れる
  return `file://${withSlash.split('/').map(encodeURIComponent).join('/')}`;
}

/** その fps の1コマの長さ。29.97 のような半端も分数で表す */
export function frameDuration(fps: number): { num: number; den: number } {
  const near = Math.round(fps);
  // 29.97 / 59.94 / 23.976 は 1001/30000 系
  if (Math.abs(fps - near) > 0.001) return { num: 1001, den: Math.round(near * 1001) };
  return { num: 100, den: near * 100 };
}

/**
 * 秒をフレームの境に乗せた時刻にする。
 *
 * 🔴 「分子/分母s」の形で書くこと。小数の秒で書くと Final Cut 側で丸められ、
 *    こちらの積み上げとずれる。
 */
export function timeStr(sec: number, fps: number): string {
  const { num, den } = frameDuration(fps);
  const frames = Math.round((sec * den) / num);
  return frames === 0 ? '0s' : `${frames * num}/${den}s`;
}

/** フレーム数に直す。積み上げは必ずこちらで行う */
function frames(sec: number, fps: number): number {
  const { num, den } = frameDuration(fps);
  return Math.round((sec * den) / num);
}

function framesToStr(f: number, fps: number): string {
  const { num, den } = frameDuration(fps);
  return f === 0 ? '0s' : `${f * num}/${den}s`;
}

export function buildFCPXML(project: Project, options: ExportOptions = {}): string {
  /*
    🔴 既定はプロジェクトの決めごとから取ること。
       ここで 1920x1080 / 30fps を書き込むと、縦のプロジェクトを
       書き出したときに Final Cut 側だけ横になる。
  */
  const fps = options.fps ?? project.settings.fps;
  const width = options.width ?? project.settings.width;
  const height = options.height ?? project.settings.height;
  const frame = { width, height };
  const name = options.name ?? 'PAC';
  const { num, den } = frameDuration(fps);

  const placed = layout(project);
  const telops = placedTelops(project);
  const total = timelineDuration(project);

  const mainLaneIds = new Set(project.lanes.filter((l) => l.kind === 'main').map((l) => l.id));
  const main = placed.filter((c) => mainLaneIds.has(c.laneId)).sort((a, b) => a.start - b.start);
  const others = placed.filter((c) => !mainLaneIds.has(c.laneId));

  /*
    重ねるレーンの段番号。
    🔴 下から 1, 2, 3… と振ること。Final Cut では大きいほど手前。
       画面での並び（上が手前）と揃えないと、重ねたものが下に隠れる。
  */
  const laneNumber = new Map<string, number>();
  project.lanes
    .filter((l) => l.kind !== 'main')
    .forEach((l, i) => laneNumber.set(l.id, i + 1));
  /** テロップは、重ねる映像より上に出す */
  const telopLane = project.lanes.filter((l) => l.kind !== 'main').length + 1;

  /* ------------------------------------------------------------ resources */

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    `<fcpxml version="${FCPXML_VERSION}">`,
    '  <resources>',
    `    <format id="r0" name="FFVideoFormat${height}p${Math.round(fps)}"` +
      ` frameDuration="${num}/${den}s" width="${width}" height="${height}"` +
      ' colorSpace="1-1-1 (Rec. 709)"/>',
  ];

  const assetId = new Map<string, string>();
  project.assets.forEach((a, i) => {
    const id = `a${i + 1}`;
    assetId.set(a.id, id);
    lines.push(
      `    <asset id="${id}" name="${esc(a.name)}" start="0s"` +
        ` duration="${timeStr(a.duration, fps)}"` +
        ` hasVideo="${a.hasVideo ? 1 : 0}"${a.hasVideo ? ' videoSources="1"' : ''}` +
        ` hasAudio="${a.hasAudio ? 1 : 0}"${a.hasAudio ? ' audioSources="1" audioChannels="2"' : ''}` +
        ` format="r0">`,
      `      <media-rep kind="original-media" src="${esc(fileUrl(a.path))}"/>`,
      '    </asset>',
    );
  });

  if (telops.length) {
    lines.push(`    <effect id="rT" name="Basic Title" uid="${esc(BASIC_TITLE_UID)}"/>`);
  }
  lines.push('  </resources>');

  /* ------------------------------------------------------------- タイムライン */

  lines.push(
    '  <library>',
    `    <event name="${esc(name)}">`,
    `      <project name="${esc(name)}">`,
    `        <sequence format="r0" duration="${timeStr(total, fps)}"` +
      ' tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">',
    '          <spine>',
  );

  /**
   * 本編に何も無い所を埋める。
   *
   * 🔴 spine に隙間を残さないこと。offset を飛ばして書くと、
   *    Final Cut は**そこに前のクリップが伸びている**ものとして読む。
   *    穴を空けたつもりが、直前の絵が引き伸ばされる。
   */
  let cursor = 0;
  const body: { start: number; end: number; xml: string[] }[] = [];

  for (const c of main) {
    const startF = frames(c.start, fps);
    const endF = frames(c.end, fps);
    if (startF > cursor) {
      body.push({
        start: cursor,
        end: startF,
        xml: [
          `            <gap name="Gap" offset="${framesToStr(cursor, fps)}"` +
            ` start="0s" duration="${framesToStr(startF - cursor, fps)}"/>`,
        ],
      });
    }
    /*
      🔴 空きは <gap> として書くこと。飛ばすと、そのぶん後ろが前に詰まって
         書き出される。画面で空けた間合いが Final Cut では消える。
    */
    if (isGap(c)) {
      body.push({
        start: startF,
        end: endF,
        xml: [
          `            <gap name="Gap" offset="${framesToStr(startF, fps)}"` +
            ` start="0s" duration="${framesToStr(endF - startF, fps)}"/>`,
        ],
      });
      cursor = endF;
      continue;
    }
    const ref = assetId.get(c.assetId);
    if (!ref) continue;

    const inner: string[] = [];
    /*
      この本編クリップにぶら下げるもの（重ねた映像・音・テロップ）。
      🔴 重なっている範囲だけを対象にすること。
         またがっているものを丸ごとぶら下げると、親を縮めたときに
         はみ出した分が消える。
    */
    for (const o of others) {
      const s = Math.max(o.start, c.start);
      const e = Math.min(o.end, c.end);
      if (e - s <= 0.001) continue;
      const oref = assetId.get(o.assetId);
      if (!oref) continue;
      const lane = laneNumber.get(o.laneId) ?? 1;
      const kind = project.lanes.find((l) => l.id === o.laneId)?.kind;
      // 親の中の時刻に直す
      const offset = c.srcStart + (s - c.start);
      const srcStart = o.srcStart + (s - o.start);
      inner.push(
        `              <asset-clip ref="${oref}" lane="${lane}" name="${esc(o.id)}"` +
          ` offset="${timeStr(offset, fps)}" start="${timeStr(srcStart, fps)}"` +
          ` duration="${timeStr(e - s, fps)}" format="r0" tcFormat="NDF"` +
          `${kind === 'audio' ? ' audioRole="music"' : ''}/>`,
      );
    }

    let styleSeq = 0;
    for (const t of telops) {
      const s = Math.max(t.start, c.start);
      const e = Math.min(t.end, c.end);
      if (e - s <= 0.001) continue;
      const offset = c.srcStart + (s - c.start);
      styleSeq += 1;
      const sid = `ts_${startF}_${styleSeq}`;

      /*
        見た目は雛形から写す。
        🔴 「強調かどうか」の2択で決め打ちしないこと。
           名前を付けた雛形は何組でも作れる。決め打ちだと、
           **画面で整えた見た目と、Final Cut で開いた見た目が別物**になる。
           しかも向こうで開くまで気付けない。
        🔴 完全一致はしない（Canvas と Basic Title は別物）。近い所までは寄せる。
      */
      const resolved = resolveStyle(project.styles, t.style);
      const look = fcpLook(
        resolved,
        resolved.position,
        frame,
        macFontOf(resolved.fontFamily, resolved.bold),
      );
      const rgb = (v: [number, number, number]) => `${v[0]} ${v[1]} ${v[2]} 1`;

      inner.push(
        `              <title ref="rT" lane="${telopLane}" name="${esc(t.text)}"` +
          ` offset="${timeStr(offset, fps)}" start="3600s" duration="${timeStr(e - s, fps)}">`,
        `                <text><text-style ref="${sid}">${esc(t.text)}</text-style></text>`,
        `                <text-style-def id="${sid}"><text-style` +
          ` font="${esc(look.font)}" fontFace="${esc(look.font_face)}"` +
          ` fontSize="${Math.round(look.font_size)}" fontColor="${rgb(look.color)}"` +
          ` alignment="center"${look.italic ? ' italic="1"' : ''}` +
          (look.stroke_color
            ? ` strokeColor="${rgb(look.stroke_color)}" strokeWidth="${look.stroke_width.toFixed(2)}"`
            : '') +
          '/></text-style-def>',
        '              </title>',
      );
    }

    /*
      クリップごとの音量。
      🔴 これを落とすと、PAC で揃えた声の大きさが Final Cut では全部 0dB に戻る。
         対談で2人の声量が違うときは、向こうでやり直しになる。
      🔴 adjust-volume は asset-clip の**中身の先頭**に置くこと（DTD の並び）。
    */
    const gain = c.gainDb ?? 0;
    if (gain !== 0) {
      inner.unshift(`              <adjust-volume amount="${gain.toFixed(1)}dB"/>`);
    }

    /*
      画角（位置と大きさ）。

      🔴 これを落とすと、PAC で決めた画角が Final Cut では全部
         等倍・中央に戻る。縦の素材を横の枠いっぱいにした指定が消えるので、
         向こうで開くと黒帯が戻る。
      🔴 並びを守ること。FCPXML では adjust-transform が adjust-volume より**前**。
         逆にすると DTD の検証で弾かれ、XML ごと読み込みを断られる。
         （unshift なので、音量を入れたあとに入れると前へ回る）
      🔴 縦の向きは Final Cut と逆。あちらは上が正、こちらは下が正。
         テロップの位置（fcpLook）と同じ約束にそろえる。
    */
    const tf = c.transform;
    if (tf) {
      const px = Math.round(tf.x * width * 10) / 10;
      const py = Math.round(-tf.y * height * 10) / 10;
      inner.unshift(
        `              <adjust-transform position="${px} ${py}"` +
          ` scale="${tf.scale} ${tf.scale}"/>`,
      );
    }

    const open =
      `            <asset-clip ref="${ref}" name="${esc(c.id)}"` +
      ` offset="${framesToStr(startF, fps)}" start="${timeStr(c.srcStart, fps)}"` +
      ` duration="${framesToStr(endF - startF, fps)}" format="r0" tcFormat="NDF">`;
    body.push({
      start: startF,
      end: endF,
      xml: inner.length
        ? [open, ...inner, '            </asset-clip>']
        : [open.replace(/>$/, '/>'), ],
    });
    cursor = endF;
  }

  for (const b of body) lines.push(...b.xml);

  lines.push(
    '          </spine>',
    '        </sequence>',
    '      </project>',
    '    </event>',
    '  </library>',
    '</fcpxml>',
  );

  return `${lines.join('\n')}\n`;
}
