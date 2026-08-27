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

import type { Asset, Clip, Lane, Project, Telop } from './project';

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
  return {
    id,
    path,
    name: str(v.name) ?? path,
    duration,
    hasVideo: v.hasVideo !== false,
    hasAudio: v.hasAudio !== false,
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
  return {
    id,
    // 🔴 古い書類には名前が無い。無いものは素材の名前で補う
    name: str(v.name) ?? '素材',
    assetId,
    laneId,
    srcStart,
    srcEnd,
    ...(at === null ? {} : { at: Math.max(0, at) }),
  };
}

function toTelop(v: unknown, assets: Set<string>): Telop | null {
  if (!isObj(v)) return null;
  const id = str(v.id);
  const assetId = str(v.assetId);
  const srcStart = num(v.srcStart);
  const srcEnd = num(v.srcEnd);
  const text = typeof v.text === 'string' ? v.text : null;
  if (!id || !assetId || srcStart === null || srcEnd === null || text === null) return null;
  if (!assets.has(assetId) || srcEnd - srcStart <= 0) return null;
  return {
    id,
    assetId,
    srcStart,
    srcEnd,
    text,
    style: v.style === 'emphasis' ? 'emphasis' : 'normal',
  };
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
  const telops = (Array.isArray(body.telops) ? body.telops : [])
    .map((t) => toTelop(t, assetIds))
    .filter((t): t is Telop => t !== null);

  return { assets, lanes, clips, telops, magnetic: body.magnetic !== false };
}
