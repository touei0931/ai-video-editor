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

import { DEFAULT_STYLES, type StyleMap, type TelopStyleName } from '../telop/style';

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
  /**
   * 素材そのものの画の大きさ。
   * プロジェクトの大きさを決めるときの手掛かりにする。
   * 🔴 音だけの素材や、読み取れなかった素材では無い。
   */
  width?: number;
  height?: number;
}

/**
 * プロジェクトの決めごと（Final Cut の「プロジェクトのプロパティ」）。
 *
 * 🔴 素材ではなくプロジェクトが持つこと。
 *    素材から都度決めると、縦の素材を1本足しただけで書き出しの大きさが変わる。
 *    どの大きさで仕上げるかは人が決めることで、素材が決めることではない。
 */
export interface ProjectSettings {
  width: number;
  height: number;
  /**
   * コマ数。
   * 🔴 <video> からは読めない。人が決めるか、既定のままにする。
   *    ブラウザには動画のコマ数を教える手立てが無く、
   *    「1コマ進める」を実装する段でここが効いてくる。
   */
  fps: number;
  /**
   * テロップを映像に焼き込むか。
   *
   * 🔴 選べるようにしておくこと。
   *    既定のまま隠すと、字幕ファイルだけ欲しい人に手立てが無くなる。
   *    以前、書き出しの選択を隠していたせいで
   *    Final Cut への受け渡しが一度もできない状態で配りかけた。
   */
  burnTelops: boolean;
  /** 字幕ファイル（.srt）も作るか */
  writeSrt: boolean;
  /**
   * 全体の音量を配信の基準（-14 LUFS）へそろえるか。
   *
   * 🔴 切れるようにしておくこと。
   *    編集ソフトとしては「勝手に音量が変わる」ほうが驚く。
   *    喋り主体では入れたほうが楽なので、既定は入。
   */
  loudnorm: boolean;
}

/** 何も無いところから始めるときの大きさ。いちばん多い形 */
export const DEFAULT_SETTINGS: ProjectSettings = {
  width: 1920,
  height: 1080,
  fps: 30,
  burnTelops: true,
  writeSrt: true,
  loudnorm: true,
};

export interface Lane {
  id: string;
  kind: LaneKind;
  name: string;
}

/**
 * 空き（何も映らない区間）を表す素材の名前。
 *
 * 🔴 「詰める」を切って穴を空ける、という作りにしないこと。
 *    以前はそうしていたが、Shift+Delete を一度押しただけで
 *    **タイムライン全体が詰まらなくなった**。
 *    Final Cut と同じく、空きも1つのクリップとして置く。
 *    こうすれば詰める設定はそのままで、空きだけを消したり伸ばしたりできる。
 */
export const GAP = '';

/** その クリップが空きか */
export function isGap(c: Clip): boolean {
  return c.assetId === GAP;
}

/** タイムラインに置かれたひとかたまり */
export interface Clip {
  id: string;
  /**
   * 画面に出す名前。
   *
   * 🔴 素材の名前をそのまま出さないこと。
   *    自動カットの結果は同じ素材から何十本もできる。全部が同じ名前だと、
   *    「どれをどこへ動かしたのか」が一覧でも履歴でも追えない。
   */
  name: string;
  /** 素材の名前。GAP（空文字）なら「空き」 */
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
  /**
   * このクリップだけの音量（デシベル）。0 が素材のまま。
   *
   * 🔴 倍率ではなくデシベルで持つこと。
   *    人が「小さくしたい」と思う量は倍率では等間隔にならない
   *    （0.5 倍と 0.25 倍の差は、耳には同じ「半分」に聞こえる）。
   *    編集ソフトが揃ってデシベルなのはそのため。
   */
  gainDb?: number;
  /**
   * 画角（位置と大きさ）。
   *
   * 🔴 プロジェクトの枠に収めた**あと**に効く。
   *    先に効かせると、縦の素材と横の素材で同じ数字が別の意味になる。
   */
  transform?: Transform;
}

/**
 * テロップ。
 *
 * 🔴 タイムライン上の位置ではなく「素材の中の時刻」で持つこと。
 *    テロップは**喋った言葉に付いている**もの。タイムラインの位置で持つと、
 *    クリップを動かす・端を縮める・分ける、のたびに全部ずれる。
 *    素材側に結び付けておけば、同じ素材を2回使ってもどちらにも出る。
 */
export interface Telop {
  id: string;
  assetId: string;
  /** 素材の中での範囲（秒） */
  srcStart: number;
  srcEnd: number;
  text: string;
  /**
   * どの見た目で出すか。雛形の名前。
   *
   * 🔴 'normal' | 'emphasis' に狭めないこと。
   *    子画面では名前を付けた雛形を何組でも作れる。狭めると、
   *    せっかく整えた見た目が**並べた瞬間に既定へ潰れる**。
   *    知らない名前は描くときに通常へ寄る（resolveStyle）ので、ここでは通す。
   */
  style: TelopStyleName;
}

export interface Project {
  assets: Asset[];
  lanes: Lane[];
  clips: Clip[];
  telops: Telop[];
  /** メインレーンで隙間を詰めるか（Final Cut のマグネティックタイムライン） */
  magnetic: boolean;
  /** 書き出しの大きさとコマ数 */
  settings: ProjectSettings;
  /**
   * テロップの見た目の雛形。
   *
   * 🔴 プロジェクトが持つこと。画面ごとに持たない。
   *    プレビューと書き出しで別のものを見ると、画面で整えた見た目と
   *    書き出したものが違うことになる。しかも見比べないと気づけない。
   */
  styles: StyleMap;
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
    /*
      🔴 空きに当たったら、そこで止めること。下のレーンを探しに行かない。
         空きは「ここには何も映さない」という意思表示。
         下を探すと、消したはずの絵が下から出てくる。
    */
    if (hit) return isGap(hit) ? null : hit;
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
    telops: [],
    magnetic: true,
    settings: { ...DEFAULT_SETTINGS },
    styles: DEFAULT_STYLES,
  };
}

/**
 * 最初の映像素材に合わせてプロジェクトの大きさを決める。
 *
 * 🔴 決めるのは**一度だけ**。あとから素材を足したときに変えないこと。
 *    横の素材で組み立てたあとに縦の素材を1本足したら全部縦になった、
 *    では作業が壊れる。変えたいときは人が設定を触る。
 */
export function adoptSettings(project: Project, asset: Asset): Project {
  if (project.clips.length > 0) return project;
  if (!asset.hasVideo || !asset.width || !asset.height) return project;
  return { ...project, settings: { ...project.settings, width: asset.width, height: asset.height } };
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
 * クリップに付ける名前を決める。「素材の名前 + 連番」。
 *
 * 🔴 そのレーンにある同じ素材の本数から数えること。
 *    全体の本数で数えると、途中のクリップを消したときに
 *    次に作るものが既にある番号とぶつかる。
 *
 * 🔴 拡張子は落とす。「トーク.mp4 1」より「トーク 1」のほうが読める。
 */
export function clipName(project: Project, assetId: string): string {
  const asset = project.assets.find((a) => a.id === assetId);
  const base = (asset?.name ?? '素材').replace(/\.[^.]+$/, '');
  const used = new Set(project.clips.filter((c) => c.assetId === assetId).map((c) => c.name));
  for (let n = 1; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate)) return candidate;
  }
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
    name: clipName(project, assetId),
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
    name: clipName(project, assetId),
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
  /*
    🔴 分けた両方に別の名前を付けること。
       同じ名前が2つ並ぶと、どちらを消したのか分からない。
       元の名前を残したまま枝番を足す（「トーク 2」→「トーク 2a」「トーク 2b」）。
  */
  const head: Clip = { ...original, name: `${original.name}a`, srcEnd: cutSrc };
  const tail: Clip = {
    ...original,
    id: newId('clip'),
    name: `${original.name}b`,
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

  if (isMain && mode === 'lift') {
    /*
      🔴 同じ長さの「空き」に置き換えること。
         抜いてしまうと後ろが詰まる。詰める設定を切って逃げると、
         押した瞬間にタイムライン全体の振る舞いが変わってしまう。
    */
    const clips = project.clips.map((c) =>
      c.id === clipId ? { ...c, assetId: GAP, id: newId('gap'), name: '空き' } : c,
    );
    return { ...project, clips };
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
  /*
    🔴 空きにも端の伸縮を許すこと。
       空きの長さを変えるのは、間合いを作る普通の操作。
       素材が無いことを理由に弾くと、一度空けた穴の長さを直せなくなる。
  */
  if (!asset && !isGap(c)) return project;
  const limit = asset ? asset.duration : Number.POSITIVE_INFINITY;

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
    srcEnd = round(Math.min(Math.max(srcStart + MIN, want), limit));
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

/* ---------------------------------------------------- 下ごしらえの取り込み */

/** 子画面（自動カット）から返ってくるもの */
export interface CutResult {
  asset: Asset;
  /** 子画面で整えたテロップの見た目。渡さないと既定のまま並ぶ */
  styles?: StyleMap;
  /** 残す区間。素材の中の時刻 */
  keeps: readonly { srcStart: number; srcEnd: number }[];
  /** テロップ。素材の中の時刻 */
  telops?: readonly Omit<Telop, 'id' | 'assetId'>[];
}

/**
 * 自動カットの結果を、メインレーンのクリップとして流し込む。
 *
 * 🔴 残す区間1つを、クリップ1つにすること。
 *    1本の長いクリップにして「切る所」を別に覚えておく形にはしない。
 *    そうすると、取り込んだ後に手で編集した瞬間に、
 *    タイムラインの見た目と切る所の指定が食い違う。
 *    最初からクリップに割っておけば、あとは普通の編集になる。
 *
 * 🔴 テロップは素材に結び付けること。クリップには結び付けない。
 *    クリップは分けたり消したりされる。素材の時刻で持っていれば、
 *    残ったクリップの上に自動で出る。
 *
 * 🔴 末尾に足すこと。いま組んであるものを消さない。
 *    「取り込む＝作り直し」にすると、2本目を取り込んだ時に1本目が消える。
 */
export function importCutResult(project: Project, result: CutResult): Project {
  // 🔴 子画面で整えた見た目を引き継ぐ。引き継がないと、
  //    整えたはずのテロップが並べた瞬間に既定の見た目へ戻る。
  if (result.styles) project = { ...project, styles: result.styles };
  // 🔴 最初の取り込みなら、その素材の大きさをプロジェクトの大きさにする。
  //    ここで決めないと、縦動画を下ごしらえしても書き出しが横の 1920x1080 になり、
  //    左右に黒い帯が付いたまま出てしまう。
  project = adoptSettings(project, result.asset);
  let next = addAsset(project, result.asset);
  const id = result.asset.id;

  /*
    取り込んだものは、まず**本編に詰めて足す**。

    🔴 いきなり上のレーンへ置かないこと。
       「繋ぎたい」のか「重ねたい」のかは人が決めること。
       本編に並んでいれば、重ねたいものだけ上へ運べばよい。
       逆（最初から上に置く）だと、繋ぎたいだけの人が毎回下ろすことになる。
  */
  for (const k of result.keeps) {
    if (k.srcEnd - k.srcStart <= 0) continue;
    next = appendToMain(next, id, k.srcStart, k.srcEnd);
  }

  const telops: Telop[] = (result.telops ?? []).map((t) => ({
    ...t,
    id: newId('telop'),
    assetId: id,
  }));
  return { ...next, telops: [...next.telops, ...telops] };
}

/* -------------------------------------------------------------- テロップ */

/** タイムライン上に出るテロップ1つ */
export interface PlacedTelop extends Telop {
  start: number;
  end: number;
  /** どのクリップの上に出ているか */
  clipId: string;
}

/**
 * テロップを、タイムライン上のどこに出るかまで解いたもの。
 *
 * 🔴 クリップからはみ出す分は切り詰めること。
 *    端を縮めたクリップの外にテロップが残ると、**切ったはずの言葉の字幕**が
 *    次のクリップの上に出る。
 *
 * 🔴 同じ素材を2回使っていれば、2回出るのが正しい。
 *    「1つのテロップは1回しか出ない」と決め打つと、繰り返し使った素材で
 *    片方だけ字幕が出ない。
 */
export function placedTelops(project: Project): PlacedTelop[] {
  const out: PlacedTelop[] = [];
  for (const c of layout(project)) {
    for (const t of project.telops) {
      if (t.assetId !== c.assetId) continue;
      const s = Math.max(t.srcStart, c.srcStart);
      const e = Math.min(t.srcEnd, c.srcEnd);
      if (e - s <= 0.001) continue;
      out.push({
        ...t,
        clipId: c.id,
        start: Number((c.start + (s - c.srcStart)).toFixed(4)),
        end: Number((c.start + (e - c.srcStart)).toFixed(4)),
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * クリップを複製して、すぐ後ろに置く（⌘D）。
 *
 * 🔴 メインレーンでは**配列の並びに割り込ませる**こと。
 *    末尾に足すと、詰める設定が入っているときに一番後ろへ飛ぶ。
 *    「すぐ後ろ」に出ないと、複製したものを毎回探して運ぶことになる。
 *
 * 🔴 名前は付け直すこと。同じ名前が2つあると、
 *    どちらを動かしたのか一覧でも履歴でも追えない。
 */
export function duplicateClip(project: Project, id: string): Project {
  const i = project.clips.findIndex((c) => c.id === id);
  if (i < 0) return project;
  const src = project.clips[i];
  if (isGap(src)) return project;

  const copy: Clip = {
    ...src,
    id: newId('clip'),
    name: clipName(project, src.assetId),
  };

  const lane = project.lanes.find((l) => l.id === src.laneId);
  const magnetic = lane?.kind === 'main' && project.magnetic;
  if (!magnetic) {
    // 位置を持つレーンでは、元の終わりに置く
    const placedSrc = layout(project).find((c) => c.id === id);
    copy.at = round((placedSrc?.end ?? src.at ?? 0));
  }

  const clips = [...project.clips];
  clips.splice(i + 1, 0, copy);
  return { ...project, clips };
}

/**
 * 控えたクリップを、そのレーンの再生位置へ置く（⌘V）。
 *
 * 🔴 素材が無くなっていたら置かないこと。
 *    素材の無いクリップは画面に出せない幽霊になる。
 */
export function pasteClip(
  project: Project,
  source: Pick<Clip, 'assetId' | 'srcStart' | 'srcEnd' | 'gainDb'>,
  laneId: string,
  at: number,
): Project {
  const asset = project.assets.find((a) => a.id === source.assetId);
  const lane = project.lanes.find((l) => l.id === laneId);
  if (!asset || !lane || source.srcEnd - source.srcStart <= 0) return project;

  const clip: Clip = {
    id: newId('clip'),
    name: clipName(project, source.assetId),
    assetId: source.assetId,
    laneId,
    srcStart: round(source.srcStart),
    srcEnd: round(source.srcEnd),
    ...(source.gainDb ? { gainDb: source.gainDb } : {}),
  };

  const magnetic = lane.kind === 'main' && project.magnetic;
  if (magnetic) {
    /*
      🔴 詰めるレーンでは「再生位置がどのクリップの上か」で割り込み先を決める。
         位置（at）は見ないレーンなので、末尾に足すと
         再生位置と関係のない場所に出てしまう。
    */
    const placed = layout(project).filter((c) => c.laneId === laneId);
    const hit = placed.findIndex((c) => at < c.end - 0.0005);
    const order = project.clips.map((c) => c.id);
    const target = hit < 0 ? -1 : order.indexOf(placed[hit].id);
    const clips = [...project.clips];
    if (target < 0) clips.push(clip);
    else clips.splice(target, 0, clip);
    return { ...project, clips };
  }

  clip.at = Math.max(0, round(at));
  return { ...project, clips: [...project.clips, clip] };
}

/**
 * クリップの変形（画角）。
 *
 * 🔴 「素材をプロジェクトの枠に収めたあと」に効かせること。
 *    先に変形して収めると、縦の素材と横の素材で同じ数字が別の意味になる。
 *    収めてから動かせば、倍率1.0・ずらし0 がいつでも「そのまま」になる。
 *
 * 🔴 ずらし量は画面に対する割合で持つこと。画素で持たない。
 *    プロジェクトの大きさを変えた瞬間に、位置が全部ずれる。
 */
export interface Transform {
  /** 倍率。1 が等倍。1 より大きいと寄る（周りは切れる） */
  scale: number;
  /** 横のずらし。画面幅に対する割合。右が正 */
  x: number;
  /** 縦のずらし。画面高さに対する割合。下が正 */
  y: number;
}

/** 何もしない変形 */
export const NO_TRANSFORM: Transform = { scale: 1, x: 0, y: 0 };

/**
 * 変形の範囲。
 *
 * 🔴 縮小の下限を決めること。0 に近づけると絵が消え、
 *    「真っ黒になった」としか分からなくなる。
 * 🔴 拡大の上限も決めること。10倍まで寄ると画素が見えるだけで使い道が無く、
 *    書き出しでは巨大な中間画像を作ることになる。
 */
export const TRANSFORM_RANGE = { minScale: 0.2, maxScale: 4, maxShift: 1 };

export function isPlainTransform(t: Transform | undefined): boolean {
  if (!t) return true;
  return Math.abs(t.scale - 1) < 0.0005 && Math.abs(t.x) < 0.0005 && Math.abs(t.y) < 0.0005;
}

/** 範囲に収める。書類は人が触れる場所にあるので、読むたびに通す */
export function clampTransform(t: Partial<Transform> | undefined): Transform {
  const n = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const { minScale, maxScale, maxShift } = TRANSFORM_RANGE;
  const q = (v: number) => Math.round(v * 1000) / 1000;
  return {
    scale: q(Math.max(minScale, Math.min(maxScale, n(t?.scale, 1)))),
    x: q(Math.max(-maxShift, Math.min(maxShift, n(t?.x, 0)))),
    y: q(Math.max(-maxShift, Math.min(maxShift, n(t?.y, 0)))),
  };
}

/**
 * クリップの画角を変える。
 *
 * 🔴 何もしない変形なら持たないこと。
 *    既定の値を書類に残すと、無駄に太るうえ差分も汚れる。
 */
export function setClipTransform(
  project: Project,
  id: string,
  patch: Partial<Transform>,
): Project {
  const i = project.clips.findIndex((c) => c.id === id);
  if (i < 0) return project;
  const before = project.clips[i].transform ?? NO_TRANSFORM;
  const next = clampTransform({ ...before, ...patch });
  if (
    next.scale === before.scale &&
    next.x === before.x &&
    next.y === before.y
  ) {
    return project;
  }
  const clips = [...project.clips];
  if (isPlainTransform(next)) {
    const { transform: _drop, ...rest } = clips[i];
    clips[i] = rest;
  } else {
    clips[i] = { ...clips[i], transform: next };
  }
  return { ...project, clips };
}

/**
 * 縦横の合わない素材を、枠いっぱいに広げる倍率。
 *
 * 🔴 これが無いと、横の素材を縦のプロジェクトに置いたとき
 *    上下に黒い帯が残ったままになる。ショート動画では毎回やる操作なので、
 *    1回で決まる道を用意する。
 */
export function fillScale(
  asset: { width?: number; height?: number },
  frame: { width: number; height: number },
): number {
  if (!asset.width || !asset.height) return 1;
  const contain = Math.min(frame.width / asset.width, frame.height / asset.height);
  const cover = Math.max(frame.width / asset.width, frame.height / asset.height);
  if (contain <= 0) return 1;
  return clampTransform({ scale: cover / contain }).scale;
}

/* ---------------------------------------------------------------- レーン */

/**
 * レーンを消す。乗っていたクリップも一緒に消える。
 *
 * 🔴 本編（メイン）は消せないこと。
 *    土台が無くなると、置き場所の無いクリップだけが残る。
 *
 * 🔴 テロップは残すこと。
 *    テロップは素材に結び付いているので、レーンとは関係が無い。
 *    ここで消すと、別のレーンに同じ素材を置いたときに戻ってこない。
 */
export function removeLane(project: Project, laneId: string): Project {
  const lane = project.lanes.find((l) => l.id === laneId);
  if (!lane || lane.kind === 'main') return project;
  return {
    ...project,
    lanes: project.lanes.filter((l) => l.id !== laneId),
    clips: project.clips.filter((c) => c.laneId !== laneId),
  };
}

/** そのレーンに乗っているクリップの数（消す前に伝えるため） */
export function clipsOnLane(project: Project, laneId: string): number {
  return project.clips.filter((c) => c.laneId === laneId && !isGap(c)).length;
}

/** レーンの名前を変える */
export function renameLane(project: Project, laneId: string, name: string): Project {
  const trimmed = name.trim();
  const i = project.lanes.findIndex((l) => l.id === laneId);
  if (i < 0 || project.lanes[i].name === trimmed) return project;
  const lanes = [...project.lanes];
  lanes[i] = { ...lanes[i], name: trimmed };
  return { ...project, lanes };
}

/**
 * ある区間を、そのレーンから取り除く。
 *
 * 🔴 まず両端で分けてから、間に入ったクリップを消すこと。
 *    区間に半分だけかかっているクリップを丸ごと消すと、
 *    指定していない所まで消える。
 *
 * 🔴 消す相手は**先に決めておく**こと。
 *    詰めながら（ripple）消すと、後ろのクリップが前へ動いて区間に入り込み、
 *    指定していないものまで巻き込む。
 */
export function removeRange(
  project: Project,
  laneId: string,
  from: number,
  to: number,
  mode: 'ripple' | 'lift' = 'ripple',
): Project {
  if (to - from <= 0.002) return project;
  let next = bladeAt(project, laneId, from);
  next = bladeAt(next, laneId, to);

  const victims = layout(next)
    .filter(
      (c) =>
        c.laneId === laneId &&
        !isGap(c) &&
        c.start >= from - 0.002 &&
        c.end <= to + 0.002,
    )
    .map((c) => c.id);

  for (const id of victims) next = removeClip(next, id, mode);
  return next;
}

/* ------------------------------------------------------------ テロップ */

/**
 * テロップを1枚足す。
 *
 * 🔴 置き先は「クリップ」ではなく「素材の中の時刻」。
 *    クリップは分けたり消したりされる。素材に結び付けておけば、
 *    残ったクリップの上に自動で出る。
 */
export function addTelop(
  project: Project,
  clip: PlacedClip,
  at: number,
  seconds = 2,
  text = '',
  style: TelopStyleName = 'normal',
): Project {
  if (isGap(clip)) return project;
  const srcStart = Math.max(
    clip.srcStart,
    Math.min(toSourceTime(clip, at), clip.srcEnd - 0.2),
  );
  const srcEnd = Math.min(clip.srcEnd, srcStart + seconds);
  if (srcEnd - srcStart <= 0.05) return project;
  return {
    ...project,
    telops: [
      ...project.telops,
      {
        id: newId('telop'),
        assetId: clip.assetId,
        srcStart: round(srcStart),
        srcEnd: round(srcEnd),
        text,
        style,
      },
    ],
  };
}

/**
 * テロップを直す。
 *
 * 🔴 長さが 0 以下になる直しは通さないこと。
 *    通すと画面にもプレビューにも出なくなり、
 *    「消えた」のか「一瞬になった」のか分からないテロップが残る。
 */
export function updateTelop(
  project: Project,
  id: string,
  patch: Partial<Pick<Telop, 'text' | 'style' | 'srcStart' | 'srcEnd'>>,
): Project {
  const i = project.telops.findIndex((t) => t.id === id);
  if (i < 0) return project;
  const before = project.telops[i];
  const next: Telop = {
    ...before,
    ...patch,
    srcStart: round(Math.max(0, patch.srcStart ?? before.srcStart)),
    srcEnd: round(Math.max(0, patch.srcEnd ?? before.srcEnd)),
  };
  if (next.srcEnd - next.srcStart < 0.05) return project;
  if (
    next.text === before.text &&
    next.style === before.style &&
    next.srcStart === before.srcStart &&
    next.srcEnd === before.srcEnd
  ) {
    return project;
  }
  const telops = [...project.telops];
  telops[i] = next;
  return { ...project, telops };
}

/** テロップを消す */
export function removeTelop(project: Project, id: string): Project {
  const telops = project.telops.filter((t) => t.id !== id);
  return telops.length === project.telops.length ? project : { ...project, telops };
}

/**
 * テロップの表示時間を、タイムライン上の時刻で直す。
 *
 * 🔴 素材の時刻へ直してから入れること。
 *    テロップは素材に結び付いている。タイムラインの時刻のまま入れると、
 *    そのクリップを動かした瞬間にテロップだけ元の場所に取り残される。
 */
export function moveTelopEdge(
  project: Project,
  telopId: string,
  clip: PlacedClip,
  edge: 'start' | 'end',
  at: number,
): Project {
  const src = toSourceTime(clip, at);
  return updateTelop(project, telopId, edge === 'start' ? { srcStart: src } : { srcEnd: src });
}

/* ---------------------------------------------------------------- クリップ */

/** クリップの名前を変える */
export function renameClip(project: Project, id: string, name: string): Project {
  const trimmed = name.trim();
  if (!trimmed) return project;
  const i = project.clips.findIndex((c) => c.id === id);
  if (i < 0 || project.clips[i].name === trimmed) return project;
  const clips = [...project.clips];
  clips[i] = { ...clips[i], name: trimmed };
  return { ...project, clips };
}

/**
 * クリップの音量の範囲（デシベル）。
 *
 * 🔴 上限と下限を決めること。
 *    +60dB は 1000 倍で、耳を痛めるうえに書き出しが割れる。
 *    下は -60dB まで。それ以下は実質無音なので、刻んでも意味がない。
 */
export const GAIN_RANGE = { min: -60, max: 12 };

/** クリップの音量を変える（デシベル） */
export function setClipGain(project: Project, id: string, db: number): Project {
  const clamped = Math.max(GAIN_RANGE.min, Math.min(GAIN_RANGE.max, Math.round(db * 10) / 10));
  const i = project.clips.findIndex((c) => c.id === id);
  if (i < 0) return project;
  const before = project.clips[i].gainDb ?? 0;
  if (before === clamped) return project;
  const clips = [...project.clips];
  if (clamped === 0) {
    // 0 は既定なので持たない。書類を無駄に太らせない
    const { gainDb: _drop, ...rest } = clips[i];
    clips[i] = rest;
  } else {
    clips[i] = { ...clips[i], gainDb: clamped };
  }
  return { ...project, clips };
}

/** その時刻に出ているテロップ */
export function telopsAt(project: Project, t: number): PlacedTelop[] {
  return placedTelops(project).filter((x) => t >= x.start - 0.0005 && t < x.end - 0.0005);
}
