/**
 * 並べたタイムラインの保存と読み込み。
 *
 * 🔴 読み込んだ中身を信用しないこと。
 *    保存した書類は人が触れる場所にある。壊れたものや、
 *    古い版のものが来る前提で、1つずつ形を確かめてから通す。
 *    確かめずに入れると、画面が真っ白になって原因が分からなくなる。
 *
 * 🔴 素材そのものは入れない。
 *    入っているのは「どのファイルの、どこを、どこへ置いたか」だけ。
 *    素材が移動・削除されていることはあるので、開いた側で確かめる。
 */

import { DEFAULT_SETTINGS, GAIN_RANGE, type Asset, type Clip, type Lane, type Project, type ProjectSettings, type Telop } from './project';
import { sanitizeStyles, type StyleMap } from '../telop/style';

/** 書類の版。形を変えたら上げる */
export const SAVE_VERSION = 1;

export interface SavedTimeline {
  kind: 'pac-timeline';
  version: number;
  project: Project;
}

export function toSaved(project: Project): SavedTimeline {
  return { kind: 'pac-timeline', version: SAVE_VERSION, project };
}

/* ------------------------------------------------------------ 形の確かめ */

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback: number | null = null): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function toAsset(v: unknown): Asset | null {
  if (!isObj(v)) return null;
  const id = str(v.id);
  const path = str(v.path);
  const duration = num(v.duration);
  if (!id || !path || duration === null || duration <= 0) return null;
  const width = num(v.width);
  const height = num(v.height);
  return {
    id,
    path,
    name: str(v.name) ?? path,
    duration,
    hasVideo: v.hasVideo !== false,
    hasAudio: v.hasAudio !== false,
    ...(width && width > 0 ? { width } : {}),
    ...(height && height > 0 ? { height } : {}),
  };
}

/**
 * プロジェクトの決めごとを読む。
 *
 * 🔴 古い書類には無い。無いときは既定に落とすこと。
 *    ここで null を返すと、以前保存したタイムラインが丸ごと開けなくなる。
 * 🔴 大きさは偶数で、正の値であること。
 *    奇数だと yuv420p にできず、書き出しの ffmpeg が落ちる。
 *    人の手で書き換えられる書類なので、ここで直しておく。
 */
function toSettings(v: unknown): ProjectSettings {
  if (!isObj(v)) return { ...DEFAULT_SETTINGS };
  const w = num(v.width);
  const h = num(v.height);
  const fps = num(v.fps);
  const even = (n: number) => Math.max(16, Math.round(n / 2) * 2);
  // 🔴 入っていない項目は既定へ。古い書類が開けなくなる
  const flag = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  return {
    width: w && w > 0 ? even(w) : DEFAULT_SETTINGS.width,
    height: h && h > 0 ? even(h) : DEFAULT_SETTINGS.height,
    fps: fps && fps > 0 && fps <= 240 ? fps : DEFAULT_SETTINGS.fps,
    burnTelops: flag(v.burnTelops, DEFAULT_SETTINGS.burnTelops),
    writeSrt: flag(v.writeSrt, DEFAULT_SETTINGS.writeSrt),
    loudnorm: flag(v.loudnorm, DEFAULT_SETTINGS.loudnorm),
  };
}

function toLane(v: unknown): Lane | null {
  if (!isObj(v)) return null;
  const id = str(v.id);
  const kind = v.kind;
  if (!id || (kind !== 'main' && kind !== 'video' && kind !== 'audio')) return null;
  return { id, kind, name: str(v.name) ?? '' };
}

function toClip(v: unknown, assets: Set<string>, lanes: Set<string>): Clip | null {
  if (!isObj(v)) return null;
  const id = str(v.id);
  const assetId = str(v.assetId);
  const laneId = str(v.laneId);
  const srcStart = num(v.srcStart);
  const srcEnd = num(v.srcEnd);
  if (!id || !assetId || !laneId || srcStart === null || srcEnd === null) return null;
  // 🔴 行き先の無いクリップは捨てる。残すと画面に出せない幽霊になる
  if (!assets.has(assetId) || !lanes.has(laneId)) return null;
  if (srcEnd - srcStart <= 0) return null;
  const at = num(v.at);
  /*
    🔴 音量は範囲で縛ること。
       書類は人が手で書き換えられる場所にある。+60dB のまま通すと
       書き出しが割れるうえ、再生でも耳を痛める。
  */
  const gain = num(v.gainDb);
  const gainDb =
    gain === null || gain === 0
      ? null
      : Math.max(GAIN_RANGE.min, Math.min(GAIN_RANGE.max, gain));
  return {
    id,
    // 🔴 古い書類には名前が無い。無いものは素材の名前で補う
    name: str(v.name) ?? '素材',
    assetId,
    laneId,
    srcStart,
    srcEnd,
    ...(at === null ? {} : { at: Math.max(0, at) }),
    ...(gainDb === null ? {} : { gainDb }),
  };
}

function toTelop(v: unknown, assets: Set<string>, styleNames: Set<string>): Telop | null {
  if (!isObj(v)) return null;
  const id = str(v.id);
  const assetId = str(v.assetId);
  const srcStart = num(v.srcStart);
  const srcEnd = num(v.srcEnd);
  const text = typeof v.text === 'string' ? v.text : null;
  if (!id || !assetId || srcStart === null || srcEnd === null || text === null) return null;
  if (!assets.has(assetId) || srcEnd - srcStart <= 0) return null;
  /*
    🔴 知らない雛形の名前は通常へ寄せること。
       名前を付けた雛形は消せる。消えた名前をそのまま残すと、
       描くたびに雛形を探して見つからない状態が続く。
       雛形が残っている名前は、そのまま通す（せっかく整えた見た目を潰さない）。
  */
  const style = typeof v.style === 'string' && styleNames.has(v.style) ? v.style : 'normal';
  return { id, assetId, srcStart, srcEnd, text, style };
}

/**
 * 保存された中身を、使える形にする。無理なら null。
 *
 * 🔴 一部が壊れていても、通せるものは通すこと。
 *    1件おかしいだけで全部開けないと、直す手立てが無くなる。
 *    ただし「本編のレーンが無い」は通さない。置き場所の無い書類になる。
 */
export function fromSaved(raw: unknown): Project | null {
  if (!isObj(raw)) return null;
  if (raw.kind !== 'pac-timeline') return null;
  const body = isObj(raw.project) ? raw.project : null;
  if (!body) return null;

  const assets = (Array.isArray(body.assets) ? body.assets : [])
    .map(toAsset)
    .filter((a): a is Asset => a !== null);
  const lanes = (Array.isArray(body.lanes) ? body.lanes : [])
    .map(toLane)
    .filter((l): l is Lane => l !== null);
  if (!lanes.some((l) => l.kind === 'main')) return null;

  const assetIds = new Set(assets.map((a) => a.id));
  const laneIds = new Set(lanes.map((l) => l.id));

  const clips = (Array.isArray(body.clips) ? body.clips : [])
    .map((c) => toClip(c, assetIds, laneIds))
    .filter((c): c is Clip => c !== null);
  /*
    🔴 雛形は telops より先に整えること。
       どの名前が生きているかが決まらないと、テロップの見た目を確かめられない。
  */
  const styles: StyleMap = sanitizeStyles(body.styles);
  const styleNames = new Set(Object.keys(styles));

  const telops = (Array.isArray(body.telops) ? body.telops : [])
    .map((t) => toTelop(t, assetIds, styleNames))
    .filter((t): t is Telop => t !== null);

  return {
    assets,
    lanes,
    clips,
    telops,
    magnetic: body.magnetic !== false,
    settings: toSettings(body.settings),
    styles,
  };
}
