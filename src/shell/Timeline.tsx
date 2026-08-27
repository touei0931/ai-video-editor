/**
 * タイムライン。編集ソフトで言うところの「下の帯」。
 *
 * 🔴 この部品が存在する理由は「端をドラッグして伸縮できること」。
 *    友達の指摘は「カット余白を伸ばしたりもしづらい」だった。
 *    以前は境界の調整がボタン（←→）でしかできず、
 *    しかも素材全体のどこを触っているのかが画面から分からなかった。
 *
 * 守る約束:
 *   - 秒とピクセルの換算は pxPerSec ただ一つを通す。ここを分けると必ずずれる
 *   - ドラッグ中は確定させない。確定は pointerup の一度だけ（onTrim）
 *   - フレームに吸着させる。素材の fps 未満の精度で切っても意味が無い
 *   - 掴んでいる間、動かした量を数値でその場に出す（何フレーム伸ばしたか分からないと戻せない）
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { assignRows, rowCount as countRows } from './rows';

export type RegionKind = 'cut' | 'keep' | 'hold' | 'telop' | 'music';

export interface TimelineRegion {
  id: string;
  /** 元素材での開始・終了（秒） */
  start: number;
  end: number;
  kind: RegionKind;
  label?: string;
  /** 端をドラッグできないもの（テロップの帯など） */
  fixed?: boolean;
  /**
   * 目印だけで、触れないもの。
   *
   * 🔴 触れる区間の上に重なる印は、必ずこれにすること。
   *    印が押下を受け取ると、その下にある**つまみが掴めなくなる**。
   *    切れ目の印は、まさに掴みたい端の真上に来る。
   */
  decor?: boolean;
}

export interface TimelineTrack {
  id: string;
  label: string;
  regions: TimelineRegion[];
  /** 背景に素材の帯を敷くか（カットのトラックだけ） */
  showSource?: boolean;
  height?: number;
  /**
   * 区間の代わりに自前で描くレーン（音の波・映像のコマ）。
   * 拡大率と、いま見えている範囲を受け取る。
   *
   * 🔴 見えている範囲を渡すのが要点。
   *    素材全体を一度に描こうとすると、20分の素材で固まる。
   *    コマの取り出しは重いので、見えている分だけ作る。
   */
  render?(view: TimelineView): ReactNode;
  /**
   * 重なった区間を下の段へずらして並べるか。
   *
   * 🔴 重なったまま同じ段に描かないこと。
   *    上に載ったほうしか見えず、下の1枚は**存在ごと隠れる**。
   *    消したつもりのテロップが書き出しに出てくる、という形で後から気づく。
   */
  stack?: boolean;
  /**
   * 区間を**コマの上に薄く重ねる**か。
   *
   * 🔴 切る所を別のレーンに分けないこと。
   *    帯とコマが縦に離れていると、「この絵のところを切る」の対応を
   *    目で追わないといけない。同じ場所に重ねれば、切る所の絵が
   *    そのまま暗くなるので、対応を考えなくて済む。
   */
  overlay?: boolean;
  /** 1 / 2 キーで高さを変えられるレーンか（素材のコマ） */
  scalable?: boolean;
}

export interface TimelineView {
  /** 1秒あたりの画素数 */
  scale: number;
  /** 見えている左端（秒） */
  from: number;
  /** 見えている右端（秒） */
  to: number;
  /** レーンの高さ（画素） */
  height: number;
  /** 素材全体の長さ（秒） */
  duration: number;
}

export interface TimelineProps {
  /** 素材の長さ（秒） */
  duration: number;
  fps: number;
  currentTime: number;
  onSeek(time: number): void;
  tracks: TimelineTrack[];
  selectedId?: string | null;
  onSelect(id: string | null): void;
  /** 端をドラッグし終えたときに一度だけ呼ばれる */
  onTrim?(id: string, start: number, end: number): void;
  /**
   * 本体を掴んで別のレーンへ放したときに呼ばれる。
   *
   * 🔴 onTrim とは別にすること。
   *    横に動かしただけなのか、レーンを移したのかは、
   *    始まりと終わりの数字だけでは区別が付かない。
   */
  onMoveToLane?(id: string, start: number, laneId: string): void;
  /** 拡大率の初期値。省略すると尺全体が収まる倍率から始める */
  initialPxPerSec?: number;
  /**
   * ここに指定した区間へ自動で寄る。外側（インスペクタや「次へ」）で
   * 選び直したときに、タイムライン側も同じ場所を映すために使う。
   */
  focusId?: string | null;
  /**
   * 目盛りの右に置く追加の操作（時間軸の切り替えなど）。
   */
  extraControls?: ReactNode;
  /**
   * 吸着させたい時刻（秒）。カットの切れ目など。
   *
   * 🔴 表示している目盛りと同じ時間軸で渡すこと。
   *    元素材の時刻のまま渡すと、見えている場所と吸き付く場所がずれる。
   */
  snapPoints?: readonly number[];
  /**
   * 選んでいる区間（I / O で決める）。
   *
   * 🔴 画面に出すこと。印だけ持って出さないと、
   *    「どこからどこまで消えるのか」が分からないまま Delete を押すことになる。
   */
  range?: { from: number; to: number } | null;
  /** 吸着を効かせるか。N キーで切り替える（Final Cut と同じ） */
  snapEnabled?: boolean;
  /**
   * 1 / 2 キーで拡大 / 縮小できるようにするか（Shift 付きはコマの高さ）。
   * 🔴 テロップ画面では false。あちらは 1〜9 が雛形の切り替えで、
   *    先に決まっている割り当てを奪うと雛形が選べなくなる。
   */
  zoomKeys?: boolean;
}

/**
 * 掴める最低幅（px）。これを下回るクリップは端を掴めないので自動で寄る。
 *
 * 🔴 つまみは左右で 11px ずつある。全体表示だと 10分の素材で 2.4秒のクリップが
 *    5px にしかならず、つまみ同士が重なって**どちらも掴めない**。
 *    友達の「カット余白を伸ばしづらい」はここ。拡大を人任せにしない。
 */
const GRABBABLE = 64;

/** 0:00.0 形式。タイムラインの目盛りは短いほうが読みやすい */
function tick(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
}

/** 1:23.45 形式。数値の読み上げに使う */
export function clock(sec: number): string {
  const m = Math.floor(Math.abs(sec) / 60);
  const s = Math.abs(sec) % 60;
  const sign = sec < 0 ? '-' : '';
  return `${sign}${m}:${s.toFixed(2).padStart(5, '0')}`;
}

/** 目盛りの間隔。拡大率に応じて、ラベルが重ならない刻みを選ぶ */
const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
function chooseStep(pxPerSec: number): number {
  const wanted = 70 / pxPerSec; // ラベル1つに最低70px
  return STEPS.find((s) => s >= wanted) ?? STEPS[STEPS.length - 1];
}

/** ドラッグ中の状態。確定前の値はここだけに持つ */
interface Dragging {
  id: string;
  edge: 'start' | 'end' | 'move';
  originStart: number;
  originEnd: number;
  originX: number;
  start: number;
  end: number;
}

const MIN_LEN = 0.04; // 区間の下限（秒）。潰れると掴めなくなる

/**
 * 段組みのレーンで、区間の上下に空ける隙間（px）。
 *
 * 🔴 段の高さそのものを詰めても、ここが広いと帯が細くならない。
 *    段の高さと合わせて詰めること。
 */
const ROW_INSET = 3;

export function Timeline({
  duration,
  fps,
  currentTime,
  onSeek,
  tracks,
  selectedId,
  onSelect,
  onTrim,
  onMoveToLane,
  initialPxPerSec,
  focusId,
  extraControls,
  range,
  snapPoints,
  snapEnabled = true,
  zoomKeys = true,
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /**
   * 素材（コマ）のレーンの高さ倍率。
   * 🔴 コマは「どこを触っているか」を目で探すためのもの。
   *    小さいと絵が潰れて探せず、大きいと他のレーンが見えない。
   *    その時の作業で要る大きさが違うので、手元で変えられるようにする。
   */
  const [laneScale, setLaneScale] = useState(1);
  const [pxPerSec, setPxPerSec] = useState(initialPxPerSec ?? 0);
  const [drag, setDrag] = useState<Dragging | null>(null);

  /*
    どの区間がどのレーンにいるか。
    🔴 掴んだ時ではなく、いつでも引けるようにしておくこと。
       掴んだ時に覚えると、掴んでいる最中にレーンが増減したときに古い名前が残る。
  */
  const laneOf = useRef(new Map<string, string>());
  laneOf.current = new Map(
    tracks.flatMap((t) => t.regions.map((r) => [r.id, t.id] as [string, string])),
  );
  // ドラッグ中の最新値。確定時に描画の外から読むために持つ（下の up を参照）
  const dragRef = useRef<Dragging | null>(null);
  dragRef.current = drag;

  // 尺全体が収まる倍率を初期値にする。開いた瞬間に全体が見えていないと
  // 「素材のどこを見ているか」が分からない（作り直しの発端になった指摘）
  useEffect(() => {
    if (pxPerSec > 0 || !duration) return;
    const w = scrollRef.current?.clientWidth ?? 900;
    setPxPerSec(Math.max(2, (w - 24) / duration));
  }, [duration, pxPerSec]);

  const scale = pxPerSec || 10;
  const width = Math.max(320, duration * scale);
  const step = useMemo(() => chooseStep(scale), [scale]);

  /**
   * 掴んでいる端を、近い切れ目に吸い付ける距離（画素）。
   *
   * 🔴 秒ではなく画素で決めること。
   *    秒にすると、拡大したときに画面上では遠いのに吸い付いてしまい、
   *    細かく合わせたいときほど邪魔になる。
   */
  const SNAP_PX = 9;

  /**
   * 再生位置。吸着の相手に使う。
   * 🔴 依存に入れないこと。再生中は毎コマ変わるので、snapTo が毎コマ作り直され、
   *    ドラッグ中の listener を毎コマ張り替えることになる。
   */
  const timeRef = useRef(currentTime);
  timeRef.current = currentTime;

  /**
   * 吸い付いた先。掴んでいる間だけ線を出して知らせる。
   *
   * 🔴 吸い付いたことが見えないと、思った位置に置けなかったときに
   *    「ずれた」のか「吸い付いた」のか分からず、原因を探すことになる。
   */
  const [snappedAt, setSnappedAt] = useState<number | null>(null);

  /**
   * 掴んでいる位置を確定させる。吸い付いたかどうかも返す。
   *
   * 🔴 「吸い付いたか」を呼ぶ側へ伝えること。
   *    値だけ返していたときは、移動のときに「始まり」と「終わり」の候補を
   *    “動きが小さいほう”で選んでいたため、**吸着した候補が必ず負けた**
   *    （吸着すると値が動くぶん、吸着しない候補のほうが元の位置に近いため）。
   *    見た目には「吸着が効かない」としか分からない。
   */
  /**
   * その時刻に端を持っている区間の名前。
   *
   * 🔴 吸着から外すのは「掴んでいる本人の端」だけ。
   *    値だけで外すと、**同じ時刻に端がある別の区間まで巻き添え**になる。
   *    テロップを隣の端に合わせて置いた後、少し動かして戻そうとしても
   *    吸い付かなくなるのはこれ（自分の元の位置＝相手の端、なので）。
   */
  const edgeOwners = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const track of tracks) {
      for (const r of track.regions) {
        if (r.decor) continue;
        for (const v of [r.start, r.end]) {
          const k = v.toFixed(3);
          let set = m.get(k);
          if (!set) {
            set = new Set<string>();
            m.set(k, set);
          }
          set.add(r.id);
        }
      }
    }
    return m;
  }, [tracks]);

  const snapTo = useCallback(
    (
      t: number,
      fine: boolean,
      skip?: readonly number[],
      /** 掴んでいる区間の名前。この区間だけが端を持つ時刻は吸着から外す */
      selfId?: string,
    ): { value: number; snapped: number | null } => {
      const clamped = Math.min(duration, Math.max(0, t));
      // Shift を押している間は吸着もフレームの丸めも外す（細かく合わせたいとき）
      if (fine) return { value: Number(clamped.toFixed(3)), snapped: null };

      if (snapEnabled) {
        const within = SNAP_PX / scale;
        let best: number | null = null;
        let bestD = Infinity;
        /*
          🔴 白線（再生位置）にも吸い付けること。
             「ここから出したい」と思って白線を置いたのに、帯の端が
             1フレームずれるのでは、置いた意味が無い。
        */
        for (const p of [...(snapPoints ?? []), timeRef.current]) {
          /*
            🔴 掴んでいる本人の端は外すこと。
               吸着点に自分の端も入っていると、少し動かしただけで
               **元の位置に引き戻され**、動かせなくなる。
          */
          if (skip && skip.some((x) => Math.abs(x - p) < 0.0005)) {
            /*
              🔴 同じ時刻に別の区間の端があるなら、外さないこと。
                 外すと「隣に合わせて置いたものを、一度動かしてから
                 元に戻す」ができなくなる。
            */
            const owners = edgeOwners.get(p.toFixed(3));
            const otherOwns = owners ? [...owners].some((id) => id !== selfId) : false;
            if (!otherOwns) continue;
          }
          const d = Math.abs(p - clamped);
          if (d <= within && d < bestD) {
            bestD = d;
            best = p;
          }
        }
        if (best !== null) return { value: Number(best.toFixed(3)), snapped: best };
      }

      const f = Math.round(clamped * fps);
      return { value: Number((f / fps).toFixed(3)), snapped: null };
    },
    [duration, fps, snapEnabled, snapPoints, scale, edgeOwners],
  );

  /* --- 再生位置を動かす --- */
  const seekFromEvent = useCallback(
    (clientX: number, el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      onSeek(Math.min(duration, Math.max(0, (clientX - rect.left) / scale)));
    },
    [duration, onSeek, scale],
  );

  /**
   * 再生位置のドラッグ（スクラブ）。
   *
   * 🔴 押した瞬間に1回動かすだけにしないこと。
   *    編集ソフトの目盛りは、押したまま左右に動かすと映像が追いてくる。
   *    クリックだけだと、目当ての場所を一発で当てにいく操作になり、
   *    行ったり来たりが必要な確認作業に向かない。
   */
  const [scrubbing, setScrubbing] = useState(false);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  /** いま見えている範囲。重いレーン（波形・コマ）に渡す */
  const [view, setView] = useState({ left: 0, width: 900 });

  /*
    見えている範囲は、開いた直後と大きさが変わったときにも測り直すこと。

    🔴 scroll のときだけ測っていたので、**一度もスクロールしないと初期値のまま**だった。
       初期値は仮の 900px なので、素材のコマが画面の右端まで並ばず
       「途中で途切れている」ように見える。ペインの幅を変えたときも同じ。
  */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setView({ left: el.scrollLeft, width: el.clientWidth });
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const startScrub = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      setScrubbing(true);
      if (canvasRef.current) seekFromEvent(e.clientX, canvasRef.current);
    },
    [seekFromEvent],
  );

  useEffect(() => {
    if (!scrubbing) return;
    const move = (e: PointerEvent) => {
      if (canvasRef.current) seekFromEvent(e.clientX, canvasRef.current);
    };
    const up = () => setScrubbing(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [scrubbing, seekFromEvent]);

  /**
   * 余白を掴んで横に流す。
   *
   * 🔴 スクロールバーを掴ませないこと。
   *    棒は細く、タイムラインの一番下にある。素材を見ながら片手で
   *    行き来する操作なのに、毎回そこへ狙いを付けるのは現実的でない（友達の指摘）。
   *
   * 🔴 ただの押下は「その位置へ再生位置を移す」を残すこと。
   *    掴んだ瞬間に流し始めると、狙った場所を一発で指せなくなる。
   *    少し（4px）動いたときだけ横流しに切り替える。
   */
  const PAN_THRESHOLD = 4;
  const pan = useRef<{ x: number; scrollLeft: number; moved: boolean } | null>(null);

  /** 横に流す。負の値にならないようにここで揃える */
  const scrollTo = useCallback((left: number) => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = Math.max(0, left);
  }, []);

  /**
   * ここを押したら横に流してよいか。
   *
   * 🔴 「トラックの余白そのもの」に限定しないこと。
   *    素材の帯（.fcp-source）やコマ・波形がレーンを覆っているので、
   *    余白に見える場所でも押下は子要素が受け取る。
   *    その結果「最初の数回だけ動く」「レーンによって動いたり動かなかったり」に見える。
   *    掴めないのは**掴むと別の意味になるもの**（クリップ・つまみ・目盛り）だけにする。
   */
  const canPan = useCallback((target: EventTarget | null) => {
    const el = target as HTMLElement | null;
    if (!el || !el.closest) return false;
    if (el.closest('.fcp-clip')) return false; // クリップは選択・移動
    if (el.closest('.fcp-handle')) return false; // つまみは伸縮
    if (el.closest('.fcp-ruler')) return false; // 目盛りは再生位置
    return true;
  }, []);

  const startPan = useCallback(
    (e: React.PointerEvent) => {
      const el = scrollRef.current;
      if (!el) return;
      pan.current = { x: e.clientX, scrollLeft: el.scrollLeft, moved: false };
    },
    [],
  );

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = pan.current;
      const el = scrollRef.current;
      if (!p || !el) return;
      const d = e.clientX - p.x;
      if (!p.moved && Math.abs(d) < PAN_THRESHOLD) return;
      p.moved = true;
      el.scrollLeft = p.scrollLeft - d;
      setView({ left: el.scrollLeft, width: el.clientWidth });
    };
    const up = () => {
      pan.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, []);

  /** 押して離すまでに動いていなければ「移動」とみなさない */
  const panned = () => pan.current?.moved === true;

  /* --- 端のドラッグ --- */
  const startDrag = useCallback(
    (e: React.PointerEvent, r: TimelineRegion, edge: Dragging['edge']) => {
      if (r.fixed) return;
      e.stopPropagation();
      e.preventDefault();
      /*
        🔴 例外を通さないこと。
           setPointerCapture は、そのポインタがもう押されていないと
           NotFoundError を投げる（指を離した直後や、押した所が
           作り直された直後に起きる）。ここで投げると **掴んだことが
           記録されないまま**になり、クリップが動かせなくなる。
      */
      try {
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      } catch {
        /* 掴めなくても、window の pointermove で追えるので続行する */
      }
      onSelect(r.id);
      setDrag({
        id: r.id,
        edge,
        originStart: r.start,
        originEnd: r.end,
        originX: e.clientX,
        start: r.start,
        end: r.end,
      });
    },
    [onSelect],
  );

  useEffect(() => {
    if (!drag) return;

    const move = (e: PointerEvent) => {
      const d = (e.clientX - drag.originX) / scale;
      const fine = e.shiftKey; // Shift で吸着を外す
      setDrag((cur) => {
        if (!cur) return cur;
        if (cur.edge === 'move') {
          const len = cur.originEnd - cur.originStart;
          /*
            移動のときは**始まりと終わりの両方**で吸着を試す。
            始まりだけ見ていると、終わりを切れ目に合わせたいときに合わせられない。
            🔴 吸い付いたほうを優先する。両方吸い付いたら近いほうを選ぶ。
          */
          const mine = [cur.originStart, cur.originEnd];
          const rawStart = cur.originStart + d;
          const a = snapTo(rawStart, fine, mine, cur.id);
          const b = snapTo(rawStart + len, fine, mine, cur.id);
          const startCand = { value: a.value, snapped: a.snapped, at: a.value };
          const endCand = { value: b.value - len, snapped: b.snapped, at: b.value };

          let pick = startCand;
          if (endCand.snapped !== null && startCand.snapped === null) pick = endCand;
          else if (endCand.snapped !== null && startCand.snapped !== null) {
            pick =
              Math.abs(endCand.value - rawStart) < Math.abs(startCand.value - rawStart)
                ? endCand
                : startCand;
          }

          let s = Math.min(Math.max(0, pick.value), Math.max(0, duration - len));
          setSnappedAt(pick.snapped);
          return { ...cur, start: s, end: Number((s + len).toFixed(3)) };
        }
        if (cur.edge === 'start') {
          const r = snapTo(cur.originStart + d, fine, [cur.originStart], cur.id);
          const s = Math.min(r.value, cur.originEnd - MIN_LEN);
          setSnappedAt(s === r.value ? r.snapped : null);
          return { ...cur, start: Math.max(0, s) };
        }
        const r = snapTo(cur.originEnd + d, fine, [cur.originEnd], cur.id);
        const en = Math.max(r.value, cur.originStart + MIN_LEN);
        setSnappedAt(en === r.value ? r.snapped : null);
        return { ...cur, end: Math.min(duration, en) };
      });
    };

    /*
      🔴 確定は setDrag の更新関数の**外**でやること。

      更新関数は React の描画中に走るので、その中で親の state を触ると
      「Cannot update a component while rendering a different component」になる。
      動いてはいるが、描画の途中で親を書き換えているので、
      いつ壊れてもおかしくない状態になる。最新値は ref から読む。
    */
    const up = (e: PointerEvent) => {
      setSnappedAt(null);
      const cur = dragRef.current;
      if (cur) {
        /*
          🔴 レーンが変わったかを先に見ること。
             横の動きだけ見て onTrim を呼ぶと、上のレーンへ放しても
             同じレーンの中で動いただけになり、**掴んで放すと元に戻る**
             ように見える。
        */
        const lane = onMoveToLane
          ? (document
              .elementFromPoint(e.clientX, e.clientY)
              ?.closest('[data-lane]') as HTMLElement | null)
          : null;
        const laneId = lane?.dataset.lane ?? null;
        const fromLane = laneOf.current.get(cur.id) ?? null;

        if (cur.edge === 'move' && onMoveToLane && laneId && laneId !== fromLane) {
          onMoveToLane(cur.id, cur.start, laneId);
        } else if (onTrim && (cur.start !== cur.originStart || cur.end !== cur.originEnd)) {
          onTrim(cur.id, cur.start, cur.end);
        }
      }
      setDrag(null);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [drag, duration, onTrim, onMoveToLane, scale, snapTo]);

  /* --- 拡大縮小 --- */
  const zoom = useCallback(
    (factor: number, anchorSec?: number) => {
      const el = scrollRef.current;
      /*
        🔴 拡大の中心は「いま画面に映っている場所」にすること。
           白線を中心にしていたので、余白で別の場所へ動かしてから ＋ を押すと
           白線のところへ飛ばされ、**押しても効かないように見えていた**。
      */
      const center = el && el.clientWidth ? (el.scrollLeft + el.clientWidth / 2) / scale : currentTime;
      const before = anchorSec ?? center;
      setPxPerSec((p) => {
        const next = Math.min(400, Math.max(1, (p || 10) * factor));
        if (el) {
          // 拡大の中心を保つ。ここを省くと拡大するたびに見ていた場所を見失う
          requestAnimationFrame(() => {
            scrollTo(before * next - el.clientWidth / 2);
          });
        }
        return next;
      });
    },
    [currentTime, scale, scrollTo],
  );

  const fit = useCallback(() => {
    const w = scrollRef.current?.clientWidth ?? 900;
    if (duration > 0) setPxPerSec(Math.max(1, (w - 24) / duration));
  }, [duration]);

  /**
   * 再生位置まで戻る。
   *
   * 🔴 流れている白線を画面の外まで追いかけないことにした以上、
   *    「見失ったときに戻る手段」を必ず置くこと。置かないと、
   *    拡大して作業したあとに白線がどこにあるのか分からなくなる。
   */
  const toPlayhead = useCallback(() => {
    const el = scrollRef.current;
    if (el) scrollTo(currentTime * scale - el.clientWidth / 2);
  }, [currentTime, scale, scrollTo]);

  const all = useMemo(() => tracks.flatMap((t) => t.regions), [tracks]);

  /**
   * その区間が掴める大きさになるまで寄って、画面の中央に置く。
   *
   * 前後の余白も一緒に映す。カットの良し悪しは「その前後がどう繋がるか」で
   * 決まるので、区間だけ大写しにしても判断できない。
   */
  const focus = useCallback(
    (id: string) => {
      const r = all.find((x) => x.id === id);
      const el = scrollRef.current;
      if (!r || !el) return;
      const len = Math.max(0.05, r.end - r.start);
      const view = el.clientWidth || 900;
      /*
        🔴 いまの拡大率で足りているなら、拡大率は変えないこと。

           以前は寄るたびに必ず倍率を計算し直していた。そのため
           Ctrl+Z（元に戻す）のたびにタイムラインが勝手に拡大され、
           **1つ前の操作が戻ったのかどうかが分からなくなっていた**。
           倍率を変えるのは、その区間が小さすぎて掴めないときだけでよい。
      */
      const now = pxPerSec || 10;
      const want =
        len * now >= GRABBABLE ? now : Math.min(300, Math.max(4, (view * 0.35) / len));
      if (want !== now) setPxPerSec(want);
      requestAnimationFrame(() => {
        scrollTo(((r.start + r.end) / 2) * want - view / 2);
      });
    },
    [all, scrollTo, pxPerSec],
  );

  /*
    外から選び直されたら、そこへ寄る（インスペクタや「次へ」からの操作）。

    🔴 focus を依存に入れないこと。

       focus は tracks から作られ、tracks は呼び出し側が毎描画で組み立てる配列なので、
       **描画のたびに中身が同じでも別物**になる。依存に入れると描画のたびに寄り直し、
       拡大率とスクロール位置が固定されてしまう。友達には別々の症状として見えていた:
         - 「全体」を押しても戻せない（押した直後に寄り直しが上書きする）
         - 余白ドラッグで動かせない（動かした先から引き戻される）
         - 一時停止から再開すると勝手に拡大される（再生で描画が続くため）
       寄るのは focusId が変わったときだけ。
  */
  const focusRef = useRef(focus);
  focusRef.current = focus;
  useEffect(() => {
    if (focusId) focusRef.current(focusId);
  }, [focusId]);

  // ctrl + ホイールで拡大縮小（編集ソフトの慣習）
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      const at = (e.clientX - rect.left + (scrollRef.current?.scrollLeft ?? 0)) / scale;
      zoom(e.deltaY < 0 ? 1.25 : 0.8, at);
    },
    [scale, zoom],
  );

  /** 前回ここで見た再生位置。「時間が動いたのか」を見分けるために持つ */
  const lastTime = useRef(currentTime);

  // 再生位置が画面の外に出たら追いかける
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prev = lastTime.current;
    lastTime.current = currentTime;

    /*
      🔴 再生位置が動いていないなら、何もしないこと。

         以前はここの依存に drag と scale が入っていたので、
         **クリップを掴んで離しただけ・拡大しただけ**でもこの処理が走り、
         そのたびに白線の位置へスクロールが戻っていた。
         「余白で動かしてカット箇所を押すと戻る」「拡大が効かない」はこれが原因。
    */
    // 🔴 余白を掴んで動かしている最中は絶対に動かさないこと。
    //    ここが動くと、掴んで動かしている手と引っ張り合いになり、
    //    「余白ドラッグが効かない」「コマが点滅する」に見える。
    if (currentTime === prev || drag || pan.current) return;

    const x = currentTime * scale;
    const prevX = prev * scale;
    const left = el.scrollLeft;
    const right = left + el.clientWidth;

    /*
      端と見なす幅。
      🔴 1回の更新で進む距離より狭くしないこと。
         再生位置は毎コマ来るとは限らず（前面に無いときは毎秒4回ほど）、
         拡大しているほど1回の進みが大きい。40px 固定にしていたら
         **判定の帯をまたいで画面の外へ出てしまい、以後ずっと追わなくなった**。
    */
    const edge = Math.max(40, Math.abs(x - prevX) * 1.5);
    const nearEdge = x < left + edge || x > right - edge;

    // 人が飛ばしたとき（頭出し・目盛りのクリック・次の保留へ）は、その場所を見せる
    if (Math.abs(currentTime - prev) > 0.5) {
      if (nearEdge) scrollTo(x - el.clientWidth / 2);
      return;
    }

    /*
      🔴 再生で流れているときは、**白線が画面に見えている間だけ**追いかけること。

         画面の外にある白線まで追いかけると、余白で動かした先や拡大した先から
         毎回引き戻される。引き戻されるたびに映っている範囲が変わるので、
         コマも取り直しになり、点滅しているように見える。
         見失ったときは「白線へ」か「全体」で戻れる。

      🔴 見えていたかどうかは**進む前の位置**で判断すること。
         進んだ先で判断すると、1回の進みが大きいときに
         「見えていた → 一気に画面の外」となり、追いかけそこねる。
    */
    if (prevX < left || prevX > right) return;
    if (nearEdge) scrollTo(x - el.clientWidth / 2);
  }, [currentTime, drag, scale, scrollTo]);

  /*
    1 / 2 でタイムラインを拡大 / 縮小する。右下の ＋ / − と同じ動き。

    🔴 コマの高さではなくタイムラインの倍率にすること。
       最初はコマの高さに割り当てていたが、欲しかったのは
       「＋ / − をキーで押せること」だった。カットの余白を詰めるときは
       倍率を上げ下げしながら進むので、そのたびにボタンへマウスを
       運ぶのが手間になっていた。

    🔴 コマの高さは Shift + 1 / 2 に退ける。消さないこと。
       絵が小さいと何が映っているか分からず、探すのに使えない。

    🔴 ここで受け取ること。Stage 側に散らすと、画面ごとに効いたり効かなかったりする。
    🔴 文字を打っている最中は奪わない。
  */
  useEffect(() => {
    if (!zoomKeys) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

      /*
        Ctrl / ⌘ + ＋ − も同じ扱いにする。

        🔴 ここで受けること。ヘルプには前から載っていたが、
           操作の名前に直すところまでで止まっていて、**どの画面でも
           受け取る人がいなかった**（押しても何も起きない）。
           倍率は Timeline の内側の状態なので、受け取るのはここしかない。
      */
      if (e.ctrlKey || e.metaKey) {
        if (e.key === '+' || e.key === '=' || e.key === ';') {
          e.preventDefault();
          zoom(1.25);
        } else if (e.key === '-' || e.key === '_') {
          e.preventDefault();
          zoom(0.8);
        }
        return;
      }
      if (e.altKey) return;
      // Shift + Z は全体を表示（Final Cut と同じ）
      if (e.shiftKey && (e.key === 'Z' || e.key === 'z')) {
        e.preventDefault();
        fit();
        return;
      }
      // Shift + 1 / 2 はコマの高さ。数字キーの上段なので ! と " で来ることがある
      if (e.shiftKey) {
        if (e.key === '1' || e.key === '!') {
          e.preventDefault();
          setLaneScale((v) => Math.min(3, Number((v * 1.35).toFixed(3))));
        } else if (e.key === '2' || e.key === '"' || e.key === '@') {
          e.preventDefault();
          setLaneScale((v) => Math.max(0.5, Number((v / 1.35).toFixed(3))));
        }
        return;
      }
      if (e.key === '1') {
        e.preventDefault();
        zoom(1.25);
      } else if (e.key === '2') {
        e.preventDefault();
        zoom(0.8);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomKeys, zoom, fit]);

  const ticks = useMemo(() => {
    const out: { t: number; major: boolean }[] = [];
    for (let t = 0; t <= duration + 0.001; t += step) {
      out.push({ t: Number(t.toFixed(3)), major: true });
    }
    return out;
  }, [duration, step]);

  const shown = useCallback(
    (r: TimelineRegion) => (drag && drag.id === r.id ? { start: drag.start, end: drag.end } : r),
    [drag],
  );

  return (
    <section className="fcp-timeline" aria-label="タイムライン">
      <div className="fcp-tl-bar">
        <span className="fcp-dim">タイムライン</span>
        {extraControls}
        <div className="fcp-spacer" />
        <span className="fcp-dim" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {clock(currentTime)} / {clock(duration)}
        </span>
        <button onClick={toPlayhead} title="再生位置が見える所まで戻ります">
          白線へ
        </button>
        <button className="icon" onClick={() => zoom(0.8)} title="縮小（Ctrl+ホイール）">
          −
        </button>
        <button className="icon" onClick={() => zoom(1.25)} title="拡大（Ctrl+ホイール）">
          ＋
        </button>
        <button onClick={fit} title="全体を表示">
          全体
        </button>
      </div>

      <div
        className="fcp-tl-scroll"
        ref={scrollRef}
        onWheel={onWheel}
        onScroll={(e) =>
          setView({ left: e.currentTarget.scrollLeft, width: e.currentTarget.clientWidth })
        }
      >
        <div
          className="fcp-tl-canvas"
          style={{ width }}
          ref={canvasRef}
          onPointerDown={(e) => {
            if (!canPan(e.target)) return;
            startPan(e);
          }}
          onPointerUp={(e) => {
            if (!canPan(e.target)) return;
            // 掴んで流したのでなければ、その位置へ再生位置を移す
            if (!panned()) {
              onSelect(null);
              if (canvasRef.current) seekFromEvent(e.clientX, canvasRef.current);
            }
          }}
        >
          <div
            className="fcp-ruler"
            onPointerDown={(e) => {
              // 中ボタン（ホイール押し込み）は横流し。編集ソフトの慣習
              if (e.button === 1) {
                startPan(e);
                return;
              }
              startScrub(e);
            }}
            role="slider"
            aria-label="再生位置"
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={currentTime}
            tabIndex={0}
          >
            {ticks.map((t) => (
              <div key={t.t} className="fcp-tick" style={{ left: t.t * scale }}>
                {tick(t.t)}
              </div>
            ))}
          </div>

          {tracks.map((track) => {
            const rowH = Math.round((track.height ?? 56) * (track.scalable ? laneScale : 1));
            // 重なりがあるときだけ段を増やす。重なっていなければ今までと同じ高さ
            const rows = track.stack ? assignRows(track.regions) : null;
            const rowCount = countRows(rows);
            return (
            <div className="fcp-track" key={track.id}>
              <span className="fcp-track-label">{track.label}</span>
              <div
                /*
                  🔴 レーンを名前で指せるようにしておくこと。
                     クリップを上下に動かすとき、放した場所がどのレーンかを
                     知る手立てがこれしかない。座標から段数を数える方法は、
                     レーンごとに高さが違う（コマは高く、音は低い）ので合わない。
                */
                data-lane={track.id}
                className={`fcp-track-body${track.overlay ? ' on-film' : ''}`}
                style={{ ['--track-h' as string]: `${rowH * rowCount}px` }}

              >
                {track.showSource && <div className="fcp-source" />}

                {track.render?.({
                  scale,
                  from: view.left / scale,
                  to: (view.left + view.width) / scale,
                  height: rowH * rowCount,
                  duration,
                })}

                {track.regions.map((r) => {
                  const v = shown(r);
                  const row = rows?.get(r.id) ?? 0;
                  const left = v.start * scale;
                  const w = Math.max(3, (v.end - v.start) * scale);
                  const isDragging = drag?.id === r.id;
                  const moved = isDragging
                    ? Math.round((v.start - drag.originStart) * fps)
                    : 0;
                  const movedEnd = isDragging ? Math.round((v.end - drag.originEnd) * fps) : 0;
                  /*
                    名札を出すか。
                    🔴 幅が足りない区間は、中の文字が切れて読めない。
                       「カット後」では切った箇所が細い印になるので、
                       選んでも赤や紫の四角にしか見えなかった。
                       選んでいるものだけ、区間の外に名札を出して中身を見せる。
                  */
                  const flag = selectedId === r.id && !!r.label && w < 120;
                  return (
                    <Fragment key={r.id}>
                    <div
                      className={[
                        'fcp-clip',
                        `kind-${r.kind}`,
                        selectedId === r.id ? 'selected' : '',
                        isDragging ? 'trimming' : '',
                        w < 26 ? 'narrow' : '',
                        r.decor ? 'decor' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={
                        /*
                          段組みのレーンは、段の高さから直に置く。
                          🔴 1段のときも同じ計算にすること。段が増えたときだけ
                             別の計算にすると、1段目の見た目が段数で変わる。
                        */
                        rows
                          ? { left, width: w, top: row * rowH + ROW_INSET, height: rowH - ROW_INSET * 2 }
                          : { left, width: w }
                      }
                      onPointerDown={(e) => {
                        onSelect(r.id);
                        // 掴める大きさに足りないなら、その場で寄る。
                        // 「拡大してから掴んでください」を人にやらせない。
                        if (!r.fixed && w < GRABBABLE) {
                          focus(r.id);
                          return;
                        }
                        /*
                          🔴 本体を掴んだらそのまま動かせること。
                             以前は Alt を押しながらでないと動かせなかった。
                             編集ソフトのクリップは掴めば動く。修飾キーは要らない。
                             （端のつまみは伸縮。本体は移動、と役割を分ける）
                        */
                        if (!r.fixed) startDrag(e, r, 'move');
                      }}
                      title={`${r.label ? `${r.label}\n` : ''}${clock(v.start)} 〜 ${clock(v.end)}（${(v.end - v.start).toFixed(2)}秒）`}
                    >
                      <span className="cap" />
                      {w > 44 && !flag && <span className="name">{r.label ?? ''}</span>}
                      {!r.fixed && (
                        <>
                          <span
                            className="fcp-handle left"
                            onPointerDown={(e) => startDrag(e, r, 'start')}
                            title="ここをドラッグして始まりを動かす"
                          />
                          <span
                            className="fcp-handle right"
                            onPointerDown={(e) => startDrag(e, r, 'end')}
                            title="ここをドラッグして終わりを動かす"
                          />
                        </>
                      )}
                      {isDragging && (
                        <span
                          className="fcp-trim-readout"
                          style={{ left: drag.edge === 'end' ? undefined : 0, right: drag.edge === 'end' ? 0 : undefined }}
                        >
                          {drag.edge === 'move'
                            ? `${moved >= 0 ? '+' : ''}${moved}f 移動`
                            : drag.edge === 'start'
                              ? `始まり ${moved >= 0 ? '+' : ''}${moved}f`
                              : `終わり ${movedEnd >= 0 ? '+' : ''}${movedEnd}f`}
                          {' / '}
                          {(v.end - v.start).toFixed(2)}秒
                        </span>
                      )}
                    </div>
                    {flag && (
                      <span
                        className="fcp-flag"
                        style={{
                          left: left + w + 6,
                          top: rows ? row * rowH + ROW_INSET : 8,
                        }}
                      >
                        {r.label}
                      </span>
                    )}
                    </Fragment>
                  );
                })}
              </div>
            </div>
            );
          })}

          {/*
            再生位置。線そのものは 1px なので掴めない。
            🔴 見た目の細さと、掴める幅を分けること。
               当たり判定を線と同じ太さにすると、狙って掴むのが苦行になる。
          */}
          {/*
            選んでいる区間（I / O）。
            🔴 見えるようにすること。印だけを持って画面に出さないと、
               「どこからどこまで消えるのか」が分からないまま Delete を押すことになる。
          */}
          {range && range.to > range.from && (
            <div
              className="fcp-range"
              style={{ left: range.from * scale, width: (range.to - range.from) * scale }}
            />
          )}

          {/* 吸い付いた切れ目。掴んでいる間だけ出す */}
          {snappedAt !== null && (
            <div className="fcp-snapline" style={{ left: snappedAt * scale }} />
          )}

          <div
            className={`fcp-playhead ${scrubbing ? 'grabbing' : ''}`}
            style={{ left: currentTime * scale }}
          >
            <span className="grip" onPointerDown={startScrub} title="ドラッグで再生位置を動かせます" />
          </div>
        </div>
      </div>
    </section>
  );
}
