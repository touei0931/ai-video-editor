/**
 * 下書きの索引。
 *
 * 🔴 下書きの本体（判定した内容と解析結果）は動画の隣の作業フォルダに置くが、
 *    **どこに何があるかはアプリ側で覚えておく**。
 *    覚えていないと「同じ動画をもう一度選ぶ」以外に下書きへ辿り着く道が無く、
 *    保存したのに開けない、という状態になる。
 *
 * 索引が壊れても本体は無事。だから索引は「失っても作り直せる情報」として扱い、
 * 読めなければ黙って空を返す。ここで例外を投げると起動できなくなる。
 *
 * Electron に依存しない形にしてある（索引ファイルの場所は呼び出し側が決める）。
 * こうしておくと索引の挙動だけを単体で確かめられる。
 */
import { basename, dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export interface DraftEntry {
  videoPath: string;
  workDir: string;
  savedAt: string;
  phase: string;
  /** 判定済みのカット候補数 */
  decided: number;
  /** カット候補の総数 */
  total: number;
  /** 素材の長さ（秒） */
  duration: number;
}

/** 一覧に出すときだけ足す情報 */
export interface DraftListItem extends DraftEntry {
  videoName: string;
  /** 元の動画が見つからない（移動・削除された） */
  videoMissing: boolean;
}

/** 索引に残す上限。これを超えるほど古いものは実用上たどらない */
const MAX_ENTRIES = 50;

export function readDrafts(indexPath: string): DraftEntry[] {
  try {
    if (!existsSync(indexPath)) return [];
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((d): d is DraftEntry => Boolean(d && typeof d.workDir === 'string'));
  } catch {
    return [];
  }
}

export function writeDrafts(indexPath: string, entries: DraftEntry[]): void {
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(indexPath, JSON.stringify(entries, null, 2), 'utf8');
}

/** 同じ作業フォルダのものは置き換える。最後に保存したものが先頭に来る。 */
export function rememberDraft(indexPath: string, entry: DraftEntry): void {
  const rest = readDrafts(indexPath).filter((d) => d.workDir !== entry.workDir);
  writeDrafts(indexPath, [entry, ...rest].slice(0, MAX_ENTRIES));
}

export function forgetDraft(indexPath: string, workDir: string): void {
  writeDrafts(
    indexPath,
    readDrafts(indexPath).filter((d) => d.workDir !== workDir),
  );
}

/**
 * 開ける下書きだけを返す。
 *
 * 作業フォルダごと消された、というのは普通に起きる（フォルダを掃除した等）。
 * 開けないものを一覧に並べても押せるだけ無駄なので、その場で索引から外す。
 *
 * 一方で「動画だけ移動した」場合は索引から外さない。
 * 判定した内容は無事なので、動画を戻せばそのまま続きから始められる。
 * 黙って消すと、直せる状態だったことに気づけない。
 */
export function listDrafts(indexPath: string): DraftListItem[] {
  const all = readDrafts(indexPath);
  const live = all.filter((d) => existsSync(join(d.workDir, 'project.json')));
  if (live.length !== all.length) writeDrafts(indexPath, live);

  return live
    .map((d) => ({
      ...d,
      videoName: basename(d.videoPath ?? ''),
      videoMissing: !d.videoPath || !existsSync(d.videoPath),
    }))
    .sort((a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? ''));
}

/**
 * 作業フォルダとして妥当か。
 *
 * 🔴 下書きの削除は渡されたパスをフォルダごと消す。
 *    レンダラから来た文字列をそのまま rm するのは危ない。
 *    アプリが作ったフォルダの中にしか無いはずの目印を必ず確かめる。
 */
export function isWorkDir(workDir: string | undefined | null): boolean {
  if (!workDir) return false;
  const p = workDir.replace(/\\/g, '/');
  return p.includes('/.ai-video-editor/') || isSharedWorkDir(workDir);
}

/**
 * 作業フォルダを素材ごとに分ける前の置き場所（`<動画のフォルダ>/.ai-video-editor` そのもの）。
 *
 * 🔴 ここはフォルダごと消してはいけない。
 *    素材ごとに分けたあとの作業フォルダが、この下にぶら下がっている。
 *    1本の下書きを消したつもりで、他の素材の下書きまで消えることになる。
 */
export function isSharedWorkDir(workDir: string | undefined | null): boolean {
  if (!workDir) return false;
  return /(^|[/\\])\.ai-video-editor[/\\]?$/.test(workDir);
}
