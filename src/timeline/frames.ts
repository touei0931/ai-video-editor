/**
 * 素材のコマを取り出して覚えておく。**素材ごとに1つだけ**。
 *
 * 🔴 クリップごとに <video> を作らないこと。
 *    自動カットの結果は同じ素材から数十本のクリップになる。
 *    クリップごとに隠し <video> を持つと、同じファイルを何本ものデコーダが
 *    同時に開いて奪い合い、**一部のクリップだけコマが出なくなる**。
 *    実機（2分20秒の .MOV を5本に切った状態）で実際にそうなった。
 *    エラーは出ず、絵が出ないだけなので原因に辿り着けない。
 *
 * 🔴 取り出しは1枚ずつ順番に。
 *    <video> は同時に複数の位置へは飛べない。並行にやると
 *    seek が互いに潰し合って、同じコマばかりになる。
 *
 * 🔴 覚えたものを捨てるときは「入れた順」ではなく「いま見ている場所から遠い順」に。
 *    入れた順で捨てると、拡大して作業しているあいだに
 *    画面に見えているコマが捨てられ、すぐ取り直される（点滅の正体）。
 *
 * 🔴 toDataURL は使わない。同期で走るうえ Base64 の文字列を作るので main を止める。
 *    toBlob（非同期）＋ createObjectURL にする。
 */

import { assetUrl } from './assetUrl';

/** 素材ごとに覚えておくコマの上限。増やしすぎると画像でメモリを食う */
const CACHE_MAX = 300;

/** 1枚あたりの取り出しを諦めるまで */
const GRAB_TIMEOUT_MS = 6000;

/**
 * その拡大率で、何秒ごとにコマを置くか。
 *
 * 半端な刻みだと拡大のたびに全部作り直しになるので、決まった段階に丸める。
 * 🔴 段階は細かめに持つこと。粗いと、選ばれた刻みが必要な幅よりだいぶ大きくなる。
 */
const STEPS = [
  1 / 30, 0.05, 0.0667, 0.1, 0.133, 0.2, 0.25, 0.333, 0.5, 0.75,
  1, 1.5, 2, 3, 5, 7.5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300,
];

/**
 * 🔴 「必要な幅**以下**」でいちばん大きい刻みを選ぶこと。
 *
 *    以前は「以上」で選んでいた。すると1枚あたりの枠が絵より広くなり、
 *    絵を**引き伸ばして**埋めることになる。拡大するほど伸びるので、
 *    寄れば寄るほど何のコマなのか分からなくなっていた（実機で指摘された）。
 *
 *    以下で選べば枠は絵より狭くなり、はみ出す分を切って表示する（object-fit: cover）。
 *    切るぶんには画質が落ちない。
 *
 *    枚数が増えすぎる心配は要らない。枠の幅は必ず絵1枚ぶん以下なので、
 *    見えている枚数は「見えている幅 ÷ 絵の幅」で頭打ちになる（拡大しても増えない）。
 */
export function stepFor(scale: number, thumbW: number): number {
  const sec = thumbW / scale;
  for (let i = STEPS.length - 1; i >= 0; i--) {
    if (STEPS[i] <= sec) return STEPS[i];
  }
  return STEPS[0];
}

/**
 * 取り出すときの倍率。
 *
 * 🔴 見た目の大きさちょうどで取り出さないこと。
 *    画素の細かい画面では、CSS の 1px が実際には 2px なので、
 *    等倍で取ると**そのぶんだけぼやける**。
 *
 * 🔴 コマを出す画面が増えたら、必ずここを使うこと。
 *    同じ決まりを画面ごとに書き写すと、片方だけ直して片方が古いまま残る。
 *    実際、並べる画面だけ直して子画面（下ごしらえ）が
 *    **ぼやけたまま取り残された**。決まりは1か所に置く。
 */
export function captureScale(): number {
  return Math.min(2, Math.max(1, window.devicePixelRatio || 1));
}

/**
 * これより粗い刻みで並べているときは、キーフレーム送り（fastSeek）を使う。
 *
 * 🔴 細かい刻みでは使わないこと。
 *    fastSeek はいちばん近いキーフレームへ飛ぶので、
 *    2秒ほど離れたコマが返ることがある。刻みが 0.5 秒なのに
 *    2秒先の絵を出したら、**そこに無いものを見せている**ことになる。
 *    刻みが十分粗ければ、ずれはこのレーンが元から持っている粗さに収まる。
 */
const FAST_SEEK_STEP = 2;

/**
 * 何倍まで大きくなったら取り直すか。
 *
 * 🔴 少しの違いで取り直さないこと。パネルの幅を掴んで動かすだけで
 *    毎回全部取り直しになり、そのあいだコマが消える。
 */
const REGRAB_RATIO = 1.15;

interface Store {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  /** 素材の中の時刻 → 画像の URL */
  shots: Map<number, string>;
  /** 欲しい時刻。前にあるものほど先に取る */
  wanted: number[];
  /** いま見えている範囲（素材の秒）。捨てる順を決めるのに使う */
  window: { from: number; to: number };
  running: boolean;
  /** 続けて失敗した回数。3回で諦める */
  misses: number;
  failed: boolean;
  size: { w: number; h: number };
  /** いまの刻み（秒）。キーフレーム送りを使ってよいかの判断に使う */
  step: number;
  /**
   * 取り出した大きさの世代。捨てるたびに1つ進む。
   *
   * 🔴 取り出し中に大きさが変わったら、出来上がったものを捨てること。
   *    取り出しは1枚ずつ非同期に進むので、捨てた**あと**に
   *    古い大きさの1枚が届いて、まっさらな棚に紛れ込む。
   *    その1枚だけが引き伸ばされてぼやけ、原因が分からなくなる。
   */
  gen: number;
  listeners: Set<() => void>;
}

const stores = new Map<string, Store>();

/*
  コマが1枚増えるたびに1つ進む。

  🔴 useSyncExternalStore の getSnapshot は、変わっていない限り
     **同じ値**を返さなければならない。毎回新しい値（配列や Map）を返すと、
     React は「変わった」と見なして無限に描き直す。数え上げなら安全。
*/
let version = 0;
export function framesVersion(): number {
  return version;
}

function changed(s: Store): void {
  version += 1;
  for (const cb of s.listeners) cb();
}

function storeFor(path: string): Store {
  const hit = stores.get(path);
  if (hit) return hit;

  const video = document.createElement('video');
  video.src = assetUrl(path);
  video.muted = true;
  video.preload = 'auto';
  /*
    🔴 canvas から読み出すために要る。
       これが無いと canvas が汚染扱いになり、toBlob が例外を投げる。
       例外は握り潰されるので「絵が出ない」としか分からない。
  */
  video.crossOrigin = 'anonymous';
  // 画面には出さないが、DOM に入れないと読み込みが始まらない環境がある
  video.style.display = 'none';
  document.body.appendChild(video);

  const store: Store = {
    video,
    canvas: document.createElement('canvas'),
    shots: new Map(),
    wanted: [],
    window: { from: 0, to: 0 },
    running: false,
    misses: 0,
    gen: 0,
    failed: false,
    size: { w: 160, h: 90 },
    step: 1,
    listeners: new Set(),
  };
  stores.set(path, store);
  return store;
}

/** コマが増えたときに呼ばれる。描き直しのきっかけに使う */
export function subscribeFrames(path: string, cb: () => void): () => void {
  const s = storeFor(path);
  s.listeners.add(cb);
  return () => {
    s.listeners.delete(cb);
  };
}

/** 覚えているコマ。無ければ undefined（同期で引ける） */
export function frameAt(path: string, at: number, tolerance: number): string | undefined {
  const s = stores.get(path);
  if (!s || s.shots.size === 0) return undefined;
  const exact = s.shots.get(round2(at));
  if (exact) return exact;

  /*
    🔴 取れていない所を空白にしないこと。
       空白と絵が入れ替わるのが「点滅」の見え方そのもの。
    🔴 代わりに出してよいのは **1コマ分より近いもの** だけ。
       このレーンはもともと刻みごとにしか絵を持っていないので、
       刻み以内のずれは元から持っている粗さの範囲に収まる。
       ここを広げると、遠くの場面を平気で出すようになり嘘になる。
  */
  let best: number | undefined;
  let bestGap = Infinity;
  for (const t of s.shots.keys()) {
    const gap = Math.abs(t - at);
    if (gap < bestGap) {
      bestGap = gap;
      best = t;
    }
  }
  return best !== undefined && bestGap <= tolerance ? s.shots.get(best) : undefined;
}

/** その素材でコマを出せなかったか */
export function framesFailed(path: string): boolean {
  return stores.get(path)?.failed ?? false;
}

function round2(v: number): number {
  return Number(v.toFixed(2));
}

/**
 * 欲しいコマを伝える。前にあるものほど先に取る。
 *
 * 🔴 呼ぶたびに置き換えること。積み上げると、
 *    もう見ていない場所の取り出しがいつまでも続く。
 */
export function requestFrames(
  path: string,
  times: readonly number[],
  size: { w: number; h: number },
  step = 1,
): void {
  const s = storeFor(path);
  if (s.failed) return;
  const k = captureScale();
  const want = { w: Math.round(size.w * k), h: Math.round(size.h * k) };

  /*
    🔴 出す大きさが**大きくなったら、覚えているコマを捨てること**。

       捨てないと、小さく取り出したコマをそのまま引き伸ばして出すことになり、
       段を大きくするほどぼやける（大きくした意味が無くなる）。
       エラーは出ないので、見た目でしか気づけない。

    🔴 小さくなったときは捨てないこと。
       縮めるぶんには画質は落ちないし、捨てると取り直しのあいだ
       画面が空になって点滅して見える。
  */
  if (want.w > s.size.w * REGRAB_RATIO) {
    for (const url of s.shots.values()) URL.revokeObjectURL(url);
    s.shots.clear();
    s.misses = 0;
    s.gen += 1;
    changed(s);
  }
  s.size = want;
  s.step = step;

  const seen = new Set<number>();
  const list: number[] = [];
  for (const t of times) {
    const r = round2(Math.max(0, t));
    if (seen.has(r)) continue;
    seen.add(r);
    list.push(r);
  }
  s.wanted = list;
  if (list.length > 0) s.window = { from: list[0], to: list[list.length - 1] };

  void pump(path, s);
}

async function pump(path: string, s: Store): Promise<void> {
  if (s.running || s.failed) return;
  s.running = true;
  try {
    if (s.video.readyState < 1) {
      await new Promise<void>((r) => {
        const ok = () => {
          s.video.removeEventListener('loadedmetadata', ok);
          r();
        };
        s.video.addEventListener('loadedmetadata', ok);
        setTimeout(ok, 8000);
      });
    }

    for (;;) {
      const next = s.wanted.find((t) => !s.shots.has(t));
      if (next === undefined) break;

      const gen = s.gen;
      const url = await grab(s, next, s.step >= FAST_SEEK_STEP);
      if (url) {
        // 🔴 取り出している間に大きさが変わっていたら捨てる（古い大きさなので）
        if (s.gen !== gen) {
          URL.revokeObjectURL(url);
          continue;
        }
        s.misses = 0;
        s.shots.set(next, url);
        evict(s);
        changed(s);
      } else if (++s.misses >= 3) {
        /*
          🔴 諦めたことを画面に出せるようにすること。
             黙って空白のままだと「読み込み中」と区別が付かない。
        */
        s.failed = true;
        changed(s);
        break;
      }
    }
  } finally {
    s.running = false;
  }
  // 走っている間に新しく欲しいものが来ていたら、もう一周する
  if (!s.failed && s.wanted.some((t) => !s.shots.has(t))) void pump(path, s);
}

function evict(s: Store): void {
  if (s.shots.size <= CACHE_MAX) return;
  const { from, to } = s.window;
  const dist = (t: number) => (t < from ? from - t : t > to ? t - to : 0);
  const drop = [...s.shots.keys()]
    .filter((t) => dist(t) > 0)
    .sort((a, b) => dist(b) - dist(a))
    .slice(0, s.shots.size - CACHE_MAX);
  for (const k of drop) {
    URL.revokeObjectURL(s.shots.get(k)!);
    s.shots.delete(k);
  }
}

function grab(s: Store, at: number, fast: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const fin = (r: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.video.removeEventListener('seeked', onSeeked);
      resolve(r);
    };

    const onSeeked = () => {
      try {
        const { w, h } = s.size;
        s.canvas.width = Math.max(2, Math.round(w));
        s.canvas.height = Math.max(2, Math.round(h));
        const ctx = s.canvas.getContext('2d');
        if (!ctx) return fin(null);
        ctx.drawImage(s.video, 0, 0, s.canvas.width, s.canvas.height);
        s.canvas.toBlob(
          (blob) => fin(blob ? URL.createObjectURL(blob) : null),
          'image/jpeg',
          0.6,
        );
      } catch {
        fin(null);
      }
    };

    s.video.addEventListener('seeked', onSeeked);
    const timer = setTimeout(() => fin(null), GRAB_TIMEOUT_MS);

    const dur = Number.isFinite(s.video.duration) ? s.video.duration : at + 1;
    const target = Math.max(0, Math.min(at, dur - 0.05));
    /*
      🔴 キーフレーム送りは速いが、正確ではない。
         長い素材では seek のたびに数百ミリ秒かかることがあり、
         コマが1枚ずつ遅れて出てくる原因になる。
         粗く並べているときだけ使う（上の FAST_SEEK_STEP の注記）。
    */
    const v = s.video as HTMLVideoElement & { fastSeek?: (t: number) => void };
    if (fast && typeof v.fastSeek === 'function') v.fastSeek(target);
    else s.video.currentTime = target;
  });
}
