/**
 * タイムラインの中身（素材・レーン・クリップ）と、その上での操作。
 *
 * ここは Final Cut に寄せた「編集ソフトの土台」。画面も React も知らない
 * 純粋な計算だけを置く。理由は2つ:
 *   - 置く場所の計算がずれると、映像が1コマ抜ける・音がずれるといった
 *     **書き出すまで気づけない壊れ方**をする。机上で潰せる形にしておく。
 *   - 画面に埋め込むと、同じ計算が描画とドラッグと書き出しに散らばる。
 *
 * 🔴 保存するものは必ず「素材の中の時刻」で持つこと。
 *    タイムライン上の位置で持つと、前のクリップを1つ縮めただけで
 *    後ろ全部の時刻を書き換えることになる。位置は毎回 layout() で出す。
 *
 * 🔴 メインレーンの並び順は、clips の**配列の順**が正。
 *    マグネティック（詰める）が入っているとき、位置は順に足して決まる。
 *    位置から順番を決めると、同じ位置に2つ来たときに順番が揺れる。
 */

/** レーンの種類 */
export type LaneKind =
  /** 土台。ここに置いたものが作品の背骨になる（Final Cut のプライマリ） */
  | 'main'
  /** 上に重ねる映像（B-roll・差し込み） */
  | 'video'
  /** 音だけ（BGM・効果音） */
  | 'audio';

/** 読み込んだ素材そのもの */
export interface Asset {
  id: string;
  /** 元ファイルの場所 */
  path: string;
  /** 画面に出す名前 */
  name: string;
  /** 素材全体の長さ（秒） */
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface Lane {
  id: string;
  kind: LaneKind;
  name: string;
}

/** タイムラインに置かれたひとかたまり */
export interface Clip {
  id: string;
  assetId: string;
  laneId: string;
  /** 素材の中での範囲（秒） */
  srcStart: number;
  srcEnd: number;
  /**
   * 置いた位置（秒）。
   *
   * 🔴 メインレーンでマグネティックが入っているときは**見ない**。
   *    そこでは前のクリップの終わりが次の始まりなので、位置を持つと
   *    実際の並びと食い違った数字が残り続ける。
   */
  at?: number;
}

export interface Project {
  assets: Asset[];
  lanes: Lane[];
  clips: Clip[];
  /** メインレーンで隙間を詰めるか（Final Cut のマグネティックタイムライン） */
  magnetic: boolean;
}

/** 位置が決まったクリップ */
export interface PlacedClip extends Clip {
  start: number;
  end: number;
}

/** クリップの長さ */
export function clipLength(c: Clip): number {
  return Math.max(0, c.srcEnd - c.srcStart);
}

/** 秒をきれいな桁に丸める。積み上げで誤差が育つのを防ぐ */
function round(v: number): number {
  return Number(v.toFixed(4));
}

/* ---------------------------------------------------------------- 置き場所 */

/**
 * すべてのクリップの、タイムライン上の位置を出す。
 *
 * 🔴 メインレーンは、マグネティックが入っていれば**前から足していく**。
 *    at は見ない。切ったり消したりしたときに後ろが自動で詰まるのは、
 *    この計算がそうなっているからで、消す側で位置を書き換えてはいけない。
 */
export function layout(project: Project): PlacedClip[] {
  const out: PlacedClip[] = [];
  const mainIds = new Set(project.lanes.filter((l) => l.kind === 'main').map((l) => l.id));

  let cursor = 0;
  for (const c of project.clips) {
    const len = clipLength(c);
    if (mainIds.has(c.laneId) && project.magnetic) {
      out.push({ ...c, start: round(cursor), end: round(cursor + len) });
      cursor = round(cursor + len);
    } else {
      const start = Math.max(0, c.at ?? 0);
      out.push({ ...c, start: round(start), end: round(start + len) });
    }
  }
  return out;
}

/** 作品全体の長さ */
export function timelineDuration(project: Project): number {
  return layout(project).reduce((m, c) => Math.max(m, c.end), 0);
}

/** そのレーンの、その時刻にあるクリップ */
export function clipAt(project: Project, laneId: string, t: number): PlacedClip | null {
  return (
    layout(project).find(
      (c) => c.laneId === laneId && t >= c.start - 0.0005 && t < c.end - 0.0005,
    ) ?? null
  );
}

/**
 * その時刻に映っている映像。上のレーンが手前。
 *
 * 🔴 上から探すこと。B-roll を重ねる意味は「その間だけ差し替わる」ことなので、
 *    下（メイン）を先に見つけてしまうと重ねた意味が無くなる。
 */
export function videoAt(project: Project, t: number): PlacedClip | null {
  const order = project.lanes
    .filter((l) => l.kind === 'main' || l.kind === 'video')
    .map((l) => l.id);
  const placed = layout(project);
  for (const laneId of [...order].reverse()) {
    const hit = placed.find(
      (c) => c.laneId === laneId && t >= c.start - 0.0005 && t < c.end - 0.0005,
    );
    if (hit) return hit;
  }
  return null;
}

/** タイムラインの時刻 → 素材の中の時刻 */
export function toSourceTime(clip: PlacedClip, t: number): number {
  return round(clip.srcStart + (t - clip.start));
}

/* ------------------------------------------------------------------ 出し入れ */

export function emptyProject(): Project {
  return {
    assets: [],
    lanes: [{ id: 'main', kind: 'main', name: '本編' }],
    clips: [],
    magnetic: true,
  };
}

export function addAsset(project: Project, asset: Asset): Project {
  if (project.assets.some((a) => a.id === asset.id)) return project;
  return { ...project, assets: [...project.assets, asset] };
}

export function addLane(project: Project, lane: Lane): Project {
  if (project.lanes.some((l) => l.id === lane.id)) return project;
  return { ...project, lanes: [...project.lanes, lane] };
}

let seq = 0;
/** 重ならない名前を作る。時刻だけだと、同じミリ秒に2つ作ったときにぶつかる */
export function newId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

/**
 * 素材をメインレーンの末尾に足す。
 *
 * 🔴 範囲を省いたら素材まるごと。0 を渡されたときと区別すること。
 */
export function appendToMain(
  project: Project,
  assetId: string,
  srcStart?: number,
  srcEnd?: number,
): Project {
  const asset = project.assets.find((a) => a.id === assetId);
  const main = project.lanes.find((l) => l.kind === 'main');
  if (!asset || !main) return project;
  const s = Math.max(0, srcStart ?? 0);
  const e = Math.min(asset.duration, srcEnd ?? asset.duration);
  if (e - s <= 0) return project;
  const clip: Clip = {
    id: newId('clip'),
    assetId,
    laneId: main.id,
    srcStart: round(s),
    srcEnd: round(e),
  };
  return { ...project, clips: [...project.clips, clip] };
}

/** 上のレーンに、位置を指定して置く */
export function placeOnLane(
  project: Project,
  laneId: string,
  assetId: string,
  at: number,
  srcStart?: number,
  srcEnd?: number,
): Project {
  const asset = project.assets.find((a) => a.id === assetId);
  const lane = project.lanes.find((l) => l.id === laneId);
  if (!asset || !lane) return project;
  const s = Math.max(0, srcStart ?? 0);
  const e = Math.min(asset.duration, srcEnd ?? asset.duration);
  if (e - s <= 0) return project;
  const clip: Clip = {
    id: newId('clip'),
    assetId,
    laneId,
    srcStart: round(s),
    srcEnd: round(e),
    at: Math.max(0, round(at)),
  };
  return { ...project, clips: [...project.clips, clip] };
}

/* ------------------------------------------------------------------ 分ける */

/**
 * その時刻でクリップを分ける（Final Cut の ⌘B）。
 *
 * 🔴 分けても長さの合計は変わらない。ここで詰めたり空けたりしないこと。
 * 🔴 端ちょうどでは分けないこと。長さ0のクリップが残る。
 * 🔴 分けた後ろ側は、**元のクリップのすぐ後ろ**に入れること。
 *    配列の末尾に足すと、マグネティックでは作品の最後へ飛ぶ。
 */
export function bladeAt(project: Project, laneId: string, t: number): Project {
  const target = clipAt(project, laneId, t);
  if (!target) return project;
  if (t - target.start < 0.001 || target.end - t < 0.001) return project;

  const cutSrc = toSourceTime(target, t);
  const i = project.clips.findIndex((c) => c.id === target.id);
  if (i < 0) return project;

  const original = project.clips[i];
  const head: Clip = { ...original, srcEnd: cutSrc };
  const tail: Clip = {
    ...original,
    id: newId('clip'),
    srcStart: cutSrc,
    at: original.at === undefined ? undefined : round(t),
  };
  const clips = [...project.clips];
  clips.splice(i, 1, head, tail);
  return { ...project, clips };
}

/* -------------------------------------------------------------------- 消す */

/**
 * クリップを消す。
 *
 * mode:
 *   'ripple' … 後ろを詰める（マグネティックの既定）
 *   'lift'   … その場に穴を空ける（前後の位置を動かさない）
 *
 * 🔴 メインでマグネティックが入っているときは、配列から抜くだけで詰まる。
 *    位置は layout() が毎回出しているので、ここで何かを足し引きすると二重に動く。
 *
 * 🔴 lift でメインから抜くときは、抜く前の位置を残りに書き込むこと。
 *    書かないと、詰まらないはずのものが詰まる。
 */
export function removeClip(
  project: Project,
  clipId: string,
  mode: 'ripple' | 'lift' = 'ripple',
): Project {
  const target = layout(project).find((c) => c.id === clipId);
  if (!target) return project;

  const isMain = project.lanes.find((l) => l.id === target.laneId)?.kind === 'main';

  if (isMain && project.magnetic && mode === 'lift') {
    // 穴を空けたい = もう「詰める」では説明できない。位置を書き出して自由配置に移す
    const placed = layout(project);
    const clips = project.clips
      .filter((c) => c.id !== clipId)
      .map((c) => {
        const p = placed.find((x) => x.id === c.id);
        return p ? { ...c, at: p.start } : c;
      });
    return { ...project, clips, magnetic: false };
  }

  return { ...project, clips: project.clips.filter((c) => c.id !== clipId) };
}

/* ------------------------------------------------------------------ 伸縮 */

/**
 * クリップの端を伸ばす / 縮める。
 *
 * 🔴 素材より外へは伸ばせない。
 *    伸ばせたことにすると、書き出しで**黒画面と無音**が入る。
 *    伸ばせる限界で止めて、それ以上は動かさない。
 *
 * 🔴 長さを0にしないこと。掴めないクリップが残る。
 */
export function trimClip(
  project: Project,
  clipId: string,
  edge: 'start' | 'end',
  deltaSec: number,
): Project {
  const i = project.clips.findIndex((c) => c.id === clipId);
  if (i < 0) return project;
  const c = project.clips[i];
  const asset = project.assets.find((a) => a.id === c.assetId);
  if (!asset) return project;

  const MIN = 0.04;
  let srcStart = c.srcStart;
  let srcEnd = c.srcEnd;
  let at = c.at;

  if (edge === 'start') {
    const want = srcStart + deltaSec;
    const next = Math.min(Math.max(0, want), srcEnd - MIN);
    // 自由配置では、頭を縮めた分だけ置き場所も動く（絵が横に飛ばないように）
    if (at !== undefined) at = round(Math.max(0, at + (next - srcStart)));
    srcStart = round(next);
  } else {
    const want = srcEnd + deltaSec;
    srcEnd = round(Math.min(Math.max(srcStart + MIN, want), asset.duration));
  }

  const clips = [...project.clips];
  clips[i] = { ...c, srcStart, srcEnd, at };
  return { ...project, clips };
}

/* ------------------------------------------------------------------ 動かす */

/**
 * クリップを別の場所へ動かす。
 *
 * 🔴 メインでマグネティックが入っているときは、位置ではなく**順番**を変えること。
 *    at を書いても layout() が見ないので、掴んで放しても戻ったように見える。
 */
export function moveClip(
  project: Project,
  clipId: string,
  laneId: string,
  at: number,
): Project {
  const i = project.clips.findIndex((c) => c.id === clipId);
  if (i < 0) return project;
  const lane = project.lanes.find((l) => l.id === laneId);
  if (!lane) return project;

  if (lane.kind === 'main' && project.magnetic) {
    const moving: Clip = { ...project.clips[i], laneId, at: undefined };
    const rest = project.clips.filter((_, k) => k !== i);
    // 落とした場所に一番近い切れ目へ差し込む
    const placed = layout({ ...project, clips: rest }).filter((c) => c.laneId === laneId);
    let insert = rest.length;
    for (const p of placed) {
      if (at < (p.start + p.end) / 2) {
        const k = rest.findIndex((c) => c.id === p.id);
        if (k >= 0) insert = k;
        break;
      }
    }
    const clips = [...rest];
    clips.splice(insert, 0, moving);
    return { ...project, clips };
  }

  const clips = [...project.clips];
  clips[i] = { ...clips[i], laneId, at: Math.max(0, round(at)) };
  return { ...project, clips };
}

/* -------------------------------------------------------- マグネティック切替 */

/**
 * 詰める / 詰めないを切り替える。
 *
 * 🔴 切り替えた瞬間に絵が飛ばないようにすること。
 *    入 → 切: いま見えている位置をそのまま書き込む（動かない）
 *    切 → 入: いまの位置の順に並べ替えてから詰める
 *             （並べ替えないと、後ろにあった絵が突然先頭に来る）
 */
export function setMagnetic(project: Project, on: boolean): Project {
  if (project.magnetic === on) return project;
  const placed = layout(project);
  const mainIds = new Set(project.lanes.filter((l) => l.kind === 'main').map((l) => l.id));

  if (!on) {
    const clips = project.clips.map((c) => {
      const p = placed.find((x) => x.id === c.id);
      return p ? { ...c, at: p.start } : c;
    });
    return { ...project, clips, magnetic: false };
  }

  const order = new Map(placed.map((p) => [p.id, p.start]));
  const main = project.clips
    .filter((c) => mainIds.has(c.laneId))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((c) => ({ ...c, at: undefined }));
  const others = project.clips.filter((c) => !mainIds.has(c.laneId));
  return { ...project, clips: [...main, ...others], magnetic: true };
}
