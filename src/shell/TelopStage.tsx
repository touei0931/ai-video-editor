/**
 * テロップの段階。カットと同じ骨格に載せる。
 *
 * 🔴 描画は既存の drawTelop をそのまま通すこと。
 *    プレビューと書き出しは**必ず同じ Canvas コード**を通す、という約束は
 *    このアプリの土台。ここを分けた瞬間に「プレビューと書き出しが違う」が起きる。
 *
 * 🔴 折り返し・雛形・重なり解消のロジックには手を入れない。
 *    wrap.ts / style.ts / split.ts は過去の不具合の積み重ねでできている。
 *    ここでやるのは**見せ方の載せ替えだけ**。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorShell } from './EditorShell';
import { Timeline, clock, type TimelineRegion } from './Timeline';
import { Waveform } from './Waveform';
import { Filmstrip } from './Filmstrip';
import { MagnetToggle } from './MagnetToggle';
import { buildLines, drawTelop, telopBounds, type Frame, type TelopBounds } from '../telop/render';
import { type TelopCard } from '../telop/split';
import { activeAt, laneOffsetY, laneStep, telopLanes } from '../telop/lanes';
import { snapToBoxes } from '../telop/align';
import {
  DEFAULT_STYLES,
  resolveStyle,
  type StyleLibrary,
  type StyleMap,
  type TelopStyleName,
} from '../telop/style';
import { mediaUrl } from './media';
import { Transport } from './Transport';
import { useEditedPlayer } from './useEditedPlayer';
import { buildSegments, toOutput, toSource } from './editedTime';
import { isTyping, matchShortcut, nextShuttle } from './shortcuts';

export interface TelopStageProps {
  cards: TelopCard[];
  styles?: StyleMap;
  /** 雛形を書き換える。省略すると雛形の編集欄を出さない */
  onStylesChange?(s: StyleMap): void;
  /** 実際に読み込めた書体。ここに無いものは選ばせない */
  fontFamilies?: string[];
  /**
   * 名前を付けて保存してある見た目の一覧。
   * 🔴 これが無いと、動画を変えるたびに雛形を作り直すことになる。
   */
  library?: StyleLibrary;
  onLibraryChange?(l: StyleLibrary): Promise<boolean> | void;
  videoPath?: string;
  frame: Frame;
  /** 文言や大きさを変えたときに折り返し直す。既存の実装をそのまま渡す */
  rewrap?: (
    text: string,
    style: TelopStyleName,
    styles?: StyleMap,
    card?: { sizeScale?: number; breaks?: number[]; highlight?: string | null },
  ) => { lines: string[]; fontScale: number };
  onChange?(cards: TelopCard[]): void;
  onExport?(cards: TelopCard[]): void;
  onQuit?(): void;
  onBack?(): void;
  exporting?: boolean;
  /** カットの結果。テロップの下に並べて、どこを切ったかが見えるようにする */
  cutRegions?: { id: string; start: number; end: number }[];
  /**
   * カットを直したときに呼ばれる。時刻は**元素材**で渡す。
   *
   * 🔴 直しただけではテロップの文言は変わらない。
   *    テロップはカット後の文字起こしから作っているので、
   *    カットを広げると「切ったはずの言葉」がテロップに残る。
   *    呼び出し側が作り直しの導線を出すこと（onRebuildTelops）。
   */
  onCutsChange?(cuts: { id: string; start: number; end: number }[]): void;
  /** テロップを作られた時点からカットが変わっているか */
  cutsChanged?: boolean;
  /** テロップを作り直す。文言を今のカットに合わせる */
  onRebuildTelops?(): void;
  duration: number;
  fps?: number;
  /** 解析で作った audio.wav。音の波を出すのに使う */
  audioPath?: string;
  /**
   * BGM。無ければ null。
   * 🔴 書き出しにも渡ること。画面で足しただけで出力に乗らないと、
   *    「付けたのに入っていない」という一番たちの悪い壊れ方をする。
   */
  music?: MusicTrack | null;
  onMusicChange?(m: MusicTrack | null): void;
  onPickMusic?(): Promise<string | null>;
}

export interface MusicTrack {
  path: string;
  /** 動画の何秒から鳴らすか */
  start: number;
  /** 0〜1。声より小さくするのが前提なので既定は控えめ */
  volume: number;
  /** 尺に足りないとき繰り返すか */
  loop: boolean;
}

export function TelopStage({
  cards: initial,
  styles = DEFAULT_STYLES,
  onStylesChange,
  fontFamilies,
  library,
  onLibraryChange,
  videoPath,
  frame,
  rewrap,
  onChange,
  onExport,
  onQuit,
  onBack,
  exporting,
  cutRegions = [],
  onCutsChange,
  cutsChanged,
  onRebuildTelops,
  duration,
  fps = 30,
  audioPath,
  music,
  onMusicChange,
  onPickMusic,
}: TelopStageProps) {
  const [cards, setCards] = useState<TelopCard[]>(initial);
  const [selected, setSelected] = useState<string | null>(initial[0]?.id ?? null);
  const [onlyCheck, setOnlyCheck] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // 🔴 呼び出し側の関数を依存に入れない。毎描画で作り直されると無限に鳴る
  const notify = useRef(onChange);
  notify.current = onChange;
  useEffect(() => {
    notify.current?.(cards);
  }, [cards]);

  /* ---------- 再生（書き出し後と同じ並びで流す）---------- */

  /**
   * 🔴 テロップ画面の既定は「カット後」。
   *    ここで確かめたいのは**出来上がり**であって、素材そのものではない。
   *    切った場所の声が聞こえると、テロップの位置が合っているのか判断できない。
   */
  const [axis, setAxis] = useState<'source' | 'edited'>('edited');
  const applyCuts = axis === 'edited';

  const segments = useMemo(
    () => buildSegments(duration, cutRegions.map((c) => ({ srcStart: c.start, srcEnd: c.end }))),
    [duration, cutRegions],
  );

  const player = useEditedPlayer({
    duration,
    cuts: cutRegions.map((c) => ({ srcStart: c.start, srcEnd: c.end })),
    skipCuts: true,
    timeBase: axis,
    music: music ?? null,
    musicUrl: music ? mediaUrl(music.path) : null,
    reverseAudioPath: audioPath ? mediaUrl(audioPath) : null,
  });
  const { videoRef, audioRef } = player;
  const time = player.time;

  /** 表示している時間軸の時刻 → 元素材の時刻（テロップの照合に使う） */
  const srcTime = applyCuts && segments.length ? toSource(segments, time) : time;

  const playing = player.playing;

  const cur = useMemo(() => cards.find((c) => c.id === selected) ?? null, [cards, selected]);
  /** カットの帯を選んでいるか */
  const curCut = useMemo(
    () => (selected?.startsWith('cut-') ? (cutRegions.find((c) => `cut-${c.id}` === selected) ?? null) : null),
    [selected, cutRegions],
  );

  /**
   * いま画面に出ているべきテロップ。
   * 🔴 照合は**元素材の時刻**で行うこと。
   *    テロップの時刻は元素材で持っているので、カット後の時刻で比べると
   *    切った分だけずれて、別のテロップが出る。
   */
  const showing = useMemo(() => activeAt(cards, srcTime), [cards, srcTime]);

  /**
   * 段の割り当てと、1段ぶんの高さ。
   * 🔴 書き出し（rasterize）と同じ関数から出すこと。別々に計算した瞬間に
   *    「画面では重なっていないのに書き出すと重なる」が起きる。
   */
  const lanes = useMemo(() => telopLanes(cards), [cards]);
  const step = useMemo(() => laneStep(cards, styles, frame), [cards, styles, frame]);

  /**
   * 1枚を描くときの指定。
   * 🔴 プレビューの描画・枠・位置合わせは**必ずこれを通す**こと。
   *    別々に組み立てると、枠だけずれる／吸着だけずれる、が起きる。
   */
  const specOf = useCallback(
    (card: TelopCard) => {
      const style = resolveStyle(styles, card.style, card.override, card.fontScale);
      return {
        lines: buildLines(card.lines, card.highlight ?? undefined, style),
        style,
        position: card.positionOverride ?? style.position,
        offsetX: card.offsetX,
        offsetY: card.offsetY + laneOffsetY(card, lanes.get(card.id) ?? 0, styles, step),
      };
    },
    [styles, lanes, step],
  );

  /** 位置合わせで出す線（キャンバスの座標）。掴んでいる間だけ入る */
  const guides = useRef<{ x: number[]; y: number[] }>({ x: [], y: [] });

  /* ---------- プレビュー ---------- */

  /**
   * 1コマ描く。映像を敷いてからテロップを重ねる。
   *
   * 🔴 書き出しと同じ関数を、同じ順序で通すこと。
   *    resolveStyle → buildLines → drawTelop。
   *    とくに buildLines を飛ばすと、強調した語が**プレビューにだけ出ない**。
   */
  const paint = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    if (cv.width !== frame.width || cv.height !== frame.height) {
      cv.width = frame.width;
      cv.height = frame.height;
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    const v = videoRef.current;
    if (v && v.readyState >= 2) {
      ctx.drawImage(v, 0, 0, cv.width, cv.height);
    } else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cv.width, cv.height);
    }

    /*
      🔴 その瞬間に出るテロップを**全部**描くこと。
         1枚しか描かないと、2枚重ねたときに画面では1枚しか見えないのに
         書き出しには2枚出る。どちらが正しいのか確かめようがなくなる。
    */
    const list = showing.length > 0 ? showing : cur ? [cur] : [];
    for (const card of list) {
      const spec = specOf(card);
      drawTelop(ctx, spec, frame);

      /*
        選んでいるテロップに枠を出す。
        🔴 どれを掴んでいるのかが分からないと、重ねたときに直しようがない。
           2枚が近くにあると、動かして初めて「違うほうだった」と気づく。
      */
      if (card.id === selected) {
        const b = telopBounds(ctx, spec, frame);
        if (b) {
          const pad = Math.round(frame.height * 0.008);
          ctx.save();
          ctx.strokeStyle = 'rgba(242,193,78,0.95)';
          ctx.lineWidth = Math.max(2, Math.round(frame.height / 360));
          ctx.setLineDash([Math.round(frame.height / 90), Math.round(frame.height / 120)]);
          ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
          ctx.restore();
        }
      }
    }

    /*
      位置合わせの線。掴んでいる間だけ、合った所に出す。
      🔴 出さないと「吸い付いたのか、たまたまそこで止まったのか」が分からない。
    */
    for (const gx of guides.current.x) {
      ctx.save();
      ctx.strokeStyle = 'rgba(120,200,255,0.9)';
      ctx.lineWidth = Math.max(1, Math.round(frame.height / 540));
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, frame.height);
      ctx.stroke();
      ctx.restore();
    }
    for (const gy of guides.current.y) {
      ctx.save();
      ctx.strokeStyle = 'rgba(120,200,255,0.9)';
      ctx.lineWidth = Math.max(1, Math.round(frame.height / 540));
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(frame.width, gy);
      ctx.stroke();
      ctx.restore();
    }
  }, [showing, cur, styles, frame, lanes, step, selected, specOf]);

  // 直したら描き直す
  useEffect(() => {
    paint();
  }, [paint, time]);

  /*
    🔴 映像が読めた瞬間に描き直すこと。
       描画のきっかけを「状態が変わったとき」だけにしていたので、
       動画の読み込みが終わっても Canvas は黒いままだった。
       画面には何も出ず、原因も分からない。
  */
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const redraw = () => paint();
    for (const ev of ['loadeddata', 'seeked', 'canplay']) v.addEventListener(ev, redraw);
    return () => {
      for (const ev of ['loadeddata', 'seeked', 'canplay']) v.removeEventListener(ev, redraw);
    };
  }, [paint]);

  /*
    再生中は毎コマ描く。
    timeupdate は毎秒4回ほどしか鳴らないので、それだけだと紙芝居になる。
  */
  useEffect(() => {
    if (!playing) return;
    let id = 0;
    const loop = () => {
      paint();
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [playing, paint]);

  /**
   * 表示中の時間軸へ直す。
   * 🔴 保存する値は元素材のまま。ここは表示のためだけの変換。
   */
  const toAxis = useCallback(
    (t: number) => (applyCuts && segments.length ? toOutput(segments, t) : t),
    [applyCuts, segments],
  );
  const fromAxis = useCallback(
    (t: number) => (applyCuts && segments.length ? toSource(segments, t) : t),
    [applyCuts, segments],
  );

  /* ---------- 直す ---------- */

  /*
    🔴 ここで重なりを潰さないこと（以前は resolveOverlaps を通していた）。

       テロップは同時に何枚でも出せるようにした。重なりを勝手に直すと、
       2枚目を置いた瞬間に1枚目が短くされ、**置いたつもりのものが消える**。
       重なったものは段を分けて描く（telop/lanes.ts）。
  */
  const patch = useCallback(
    (id: string, next: Partial<TelopCard>) => {
      setCards((cs) => cs.map((c) => (c.id === id ? { ...c, ...next, edited: true } : c)));
    },
    [],
  );

  /** 文言や大きさを変えたら折り返しをやり直す */
  const retext = useCallback(
    (id: string, text: string) => {
      const c = cards.find((x) => x.id === id);
      if (!c) return;
      const r = rewrap?.(text, c.style, styles, {
        breaks: c.breaks,
        highlight: c.highlight ?? null,
      });
      patch(id, r ? { text, lines: r.lines, fontScale: r.fontScale } : { text, lines: [text] });
    },
    [cards, rewrap, styles, patch],
  );

  const restyle = useCallback(
    (id: string, style: TelopStyleName) => {
      const c = cards.find((x) => x.id === id);
      if (!c) return;
      // 🔴 書体が変わると字の幅が変わる。折り返しを必ず計算し直す
      const r = rewrap?.(c.text, style, styles, {
        breaks: c.breaks,
        highlight: c.highlight ?? null,
      });
      patch(id, r ? { style, lines: r.lines, fontScale: r.fontScale } : { style });
    },
    [cards, rewrap, styles, patch],
  );

  /** タイムラインで端を引いたとき */
  const onTrim = useCallback(
    (id: string, start: number, end: number) => {
      if (id.startsWith('cut-')) {
        // 🔴 保存は元素材の時刻に戻してから
        const raw = id.slice(4);
        onCutsChange?.(
          cutRegions.map((c) =>
            c.id === raw
              ? { ...c, start: Number(fromAxis(start).toFixed(3)), end: Number(fromAxis(end).toFixed(3)) }
              : c,
          ),
        );
        return;
      }
      if (id === 'music') {
        // BGM は開始位置だけ動かす。終わりは動画の終わりに合わせる
        if (music) onMusicChange?.({ ...music, start: Math.max(0, Number(start.toFixed(3))) });
        return;
      }
      // 🔴 保存は必ず元素材の時刻に戻してから
      patch(id, {
        srcStart: Number(fromAxis(start).toFixed(3)),
        srcEnd: Number(fromAxis(end).toFixed(3)),
      });
    },
    [patch, fromAxis, music, onMusicChange, onCutsChange, cutRegions],
  );

  /* ---------- ひとつ戻す ---------- */

  /**
   * 直前の状態。
   * 🔴 消す・貼る・複製は取り返しがつかないので、必ず戻せるようにすること。
   * 🔴 文字入力の取り消しは入力欄自身に任せる。1文字ごとに積むと
   *    「ひとつ戻す」が1文字ずつしか戻らず、使いものにならない。
   */
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const past = useRef<TelopCard[][]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const remember = useCallback(() => {
    past.current = [...past.current.slice(-19), cardsRef.current];
    setCanUndo(true);
  }, []);
  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    setCards(prev);
    setCanUndo(past.current.length > 0);
  }, []);

  const remove = useCallback(
    (id: string) => {
      remember();
      setCards((cs) => cs.filter((c) => c.id !== id));
      setSelected(null);
    },
    [remember],
  );

  /* ---------- コピー・貼り付け・複製（プラグイン版と同じ操作）---------- */

  /**
   * 覚えておいたテロップ。
   * 🔴 状態ではなく ref で持つ。覚えただけで画面が描き直る必要はない。
   */
  const clipboard = useRef<TelopCard | null>(null);
  const [hasCopy, setHasCopy] = useState(false);

  const copy = useCallback(() => {
    if (!cur) return;
    clipboard.current = cur;
    setHasCopy(true);
  }, [cur]);

  /**
   * 見た目と長さを保ったまま、指定した時刻（元素材）へ置く。
   *
   * 🔴 重なってもそのまま置くこと。
   *    貼り付け先に別のテロップがあっても短くしない。重なったぶんは
   *    段を分けて描く（telop/lanes.ts）。
   *
   * 🔴 manual を立てること。作り直し（onRebuildTelops）で消えないようにする。
   */
  const pasteAt = useCallback(
    (src: TelopCard, at: number) => {
      remember();
      const len = Math.max(0.1, src.srcEnd - src.srcStart);
      const start = Math.max(0, Math.min(duration - len, at));
      const copyCard: TelopCard = {
        ...src,
        id: `paste-${Date.now()}-${Math.round(Math.random() * 1e4)}`,
        srcStart: Number(start.toFixed(3)),
        srcEnd: Number((start + len).toFixed(3)),
        needsCheck: false,
        edited: true,
        manual: true,
      };
      setCards((cs) => [...cs, copyCard].sort((a, b) => a.srcStart - b.srcStart));
      setSelected(copyCard.id);
    },
    [duration, remember],
  );

  /** いま再生位置にあるところへ貼る */
  const paste = useCallback(() => {
    if (clipboard.current) pasteAt(clipboard.current, fromAxis(time));
  }, [pasteAt, fromAxis, time]);

  /**
   * 選んでいるものを、その直後に複製する。
   *
   * 🔴 「直後」は**見ている目盛りの上での直後**にすること。
   *    元素材の時刻で 0.2 秒後に置くと、そこが切られた範囲だった場合、
   *    複製したテロップは出来上がりに一度も出ない。作った本人には
   *    「複製したのに出てこない」としか見えない。
   */
  const duplicate = useCallback(() => {
    if (cur) pasteAt(cur, fromAxis(toAxis(cur.srcEnd) + 0.2));
  }, [cur, pasteAt, toAxis, fromAxis]);


  /**
   * 雛形（その枠を使うテロップ全部）の見た目を変える。
   *
   * 🔴 位置・書体・大きさは雛形側に持たせること。
   *    1枚ずつが持つと、300枚を上に移すのに300回操作することになる。
   */
  const patchStyle = useCallback(
    (name: TelopStyleName, next: Partial<StyleMap[TelopStyleName]>) => {
      if (!onStylesChange) return;
      onStylesChange({ ...styles, [name]: { ...styles[name], ...next } });
    },
    [styles, onStylesChange],
  );

  /**
   * 手で決めた改行位置。文と文のあいだを押すとそこで折り返す。
   * 🔴 変えたら必ず折り返しを計算し直す。lines を放置すると画面と書き出しがずれる。
   */
  const toggleBreak = useCallback(
    (at: number) => {
      if (!cur) return;
      const now = cur.breaks ?? [];
      const next = now.includes(at) ? now.filter((x) => x !== at) : [...now, at].sort((a, b) => a - b);
      const r = rewrap?.(cur.text, cur.style, styles, {
        breaks: next,
        highlight: cur.highlight ?? null,
      });
      patch(cur.id, r ? { breaks: next, lines: r.lines, fontScale: r.fontScale } : { breaks: next });
    },
    [cur, rewrap, styles, patch],
  );

  const setHighlight = useCallback(
    (word: string | null) => {
      if (!cur) return;
      const r = rewrap?.(cur.text, cur.style, styles, {
        breaks: cur.breaks,
        highlight: word,
      });
      patch(cur.id, r ? { highlight: word, lines: r.lines, fontScale: r.fontScale } : { highlight: word });
    },
    [cur, rewrap, styles, patch],
  );

  /* ---------- プレビュー上でテロップを掴んで動かす ---------- */

  /**
   * 画面上の1点を、映像の中の座標に直す。
   *
   * 🔴 キャンバスは object-fit: contain なので、要素の箱いっぱいには描かれていない。
   *    箱の大きさで割ると、上下（または左右）の黒帯のぶんだけずれる。
   *    押した所と掴んだ所がずれる／指より速く動く、として出る。
   */
  const stageBox = useCallback(
    (rect: DOMRect) => {
      const boxAspect = rect.width / rect.height;
      const imgAspect = frame.width / frame.height;
      const drawW = boxAspect > imgAspect ? rect.height * imgAspect : rect.width;
      const drawH = boxAspect > imgAspect ? rect.height : rect.width / imgAspect;
      return { drawW, drawH, offX: (rect.width - drawW) / 2, offY: (rect.height - drawH) / 2 };
    },
    [frame.width, frame.height],
  );

  const dragPos = useRef<{ x: number; y: number; ox: number; oy: number; id: string } | null>(null);

  /**
   * プレビューを押したとき。押した場所にテロップがあれば、それを選ぶ。
   *
   * 🔴 タイムラインまで戻らせないこと。
   *    画面に出ているテロップを直したいのに、選ぶには下の帯から探す、では
   *    「どれがどれか」を毎回突き合わせることになる。見えているものを押せば選べる。
   *
   * 🔴 重なっているときは**上に描かれたほう**を選ぶ。
   *    見えているのが上のものなので、押した人が指しているのもそちら。
   */
  const onStagePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const cv = canvasRef.current;
      const ctx = cv?.getContext('2d');
      if (!cv || !ctx) return;
      const rect = cv.getBoundingClientRect();
      const box = stageBox(rect);
      const px = ((e.clientX - rect.left - box.offX) / box.drawW) * frame.width;
      const py = ((e.clientY - rect.top - box.offY) / box.drawH) * frame.height;

      const list = showing.length > 0 ? showing : cur ? [cur] : [];
      const pad = frame.height * 0.01;
      let hit: TelopCard | null = null;
      for (const card of list) {
        const b = telopBounds(ctx, specOf(card), frame);
        if (!b) continue;
        if (px >= b.x - pad && px <= b.x + b.w + pad && py >= b.y - pad && py <= b.y + b.h + pad) {
          hit = card; // 後に描いたものほど上。最後に当たったものを採る
        }
      }

      /*
        🔴 テロップの上を押したときだけ掴むこと。

           選んでいるあいだ画面のどこを押しても動いていたので、
           映像の別の場所を触ったつもりで**テロップがついてくる**。
           選んでいることと、掴んでいることは別。
      */
      if (!hit) return;
      if (hit.id !== selected) setSelected(hit.id);
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      dragPos.current = {
        x: e.clientX,
        y: e.clientY,
        ox: hit.offsetX,
        oy: hit.offsetY,
        id: hit.id,
      };
    },
    [cur, showing, specOf, frame, selected, stageBox],
  );
  /**
   * 掴んで動かす。他のテロップと縦横のラインが合う所で吸い付ける。
   *
   * 🔴 吸着は「同じ時間に出ているテロップ」だけを相手にすること。
   *    画面に出ていないテロップに吸い付いても、並んで見えることはない。
   * 🔴 吸い付いた所には線を出す。出さないと、吸い付いたのか
   *    たまたまそこで止まったのかが分からない。
   */
  const onStagePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const d = dragPos.current;
      if (!d) return;
      // 🔴 掴んだものを動かすこと。押した瞬間に選び直した場合、cur はまだ前のもの
      const cur2 = cards.find((c) => c.id === d.id);
      if (!cur2) return;
      const rect = (e.target as HTMLElement).getBoundingClientRect();
      const box = stageBox(rect);
      let nx = Number((d.ox + (e.clientX - d.x) / box.drawW).toFixed(4));
      let ny = Number((d.oy + (e.clientY - d.y) / box.drawH).toFixed(4));
      const cur = cur2;

      const ctx = canvasRef.current?.getContext('2d');
      const gx: number[] = [];
      const gy: number[] = [];
      if (ctx && !e.shiftKey) {
        // 相手（同時に出ている他のテロップ）の縦横のライン
        const others: TelopBounds[] = [];
        for (const o of showing) {
          if (o.id === cur.id) continue;
          const b = telopBounds(ctx, specOf(o), frame);
          if (b) others.push(b);
        }
        if (others.length > 0) {
          // 掴んでいる最中の自分の位置。段のずらしは足したまま測る
          const laneY = laneOffsetY(cur, lanes.get(cur.id) ?? 0, styles, step);
          const mine = telopBounds(ctx, { ...specOf(cur), offsetX: nx, offsetY: ny + laneY }, frame);
          if (mine) {
            // 画面の 1.2% 以内なら合わせる（計算は telop/align.ts）
            const snap = snapToBoxes(mine, others, frame.width * 0.012, frame.height * 0.012);
            if (snap.dx !== 0 || snap.guideX !== null) {
              nx = Number((nx + snap.dx / frame.width).toFixed(4));
              if (snap.guideX !== null) gx.push(snap.guideX);
            }
            if (snap.dy !== 0 || snap.guideY !== null) {
              ny = Number((ny + snap.dy / frame.height).toFixed(4));
              if (snap.guideY !== null) gy.push(snap.guideY);
            }
          }
        }
      }
      guides.current = { x: gx, y: gy };
      patch(cur.id, { offsetX: nx, offsetY: ny });
    },
    [cards, patch, showing, specOf, frame, lanes, styles, step, stageBox],
  );
  const endStageDrag = useCallback(() => {
    dragPos.current = null;
    guides.current = { x: [], y: [] };
  }, []);

  /* ---------- タイムライン ---------- */

  const shownCards = useMemo(
    () => (onlyCheck ? cards.filter((c) => c.needsCheck) : cards),
    [cards, onlyCheck],
  );

  const telopRegions = useMemo<TimelineRegion[]>(
    () =>
      shownCards.map((c) => ({
        id: c.id,
        start: toAxis(c.srcStart),
        end: toAxis(c.srcEnd),
        kind: 'telop',
        label: c.needsCheck ? `⚠ ${c.text}` : c.text,
      })),
    [shownCards, toAxis],
  );

  const cutTrack = useMemo<TimelineRegion[]>(
    () =>
      /*
        🔴 カットした場所は必ず見えるようにすること。
           以前は「カット後」では帯ごと消していたので、
           テロップがどこの切れ目をまたいでいるのか分からなかった。
           カット後では区間が潰れるので、繋ぎ目の細い印として出す。
      */
      cutRegions.map((r) => {
        const start = toAxis(r.start);
        /*
          🔴 「カット後」の印に**長さを持たせないこと**。
             以前は 6/40 秒（40px/秒 のときの 6px 相当）にしていたが、
             幅を秒で決めると倍率で見た目が変わる。拡大すると
             400px/秒 では 60px にもなり、**切っていない所が暗く塗られている**
             ように見える。非表示にしているのに切る所が見えるのはおかしい。
             線1本でよいので、長さ 0 にして幅は CSS に任せる。
             （カット画面では同じ理由で先に直してある）
        */
        const end = applyCuts ? start : toAxis(r.end);
        return {
          id: `cut-${r.id}`,
          start,
          end,
          kind: 'cut' as const,
          label: '',
          /*
            🔴 「カット後」では触らせない。
               その目盛りでは区間が潰れて印になっているので、
               掴んで伸ばしても何を変えているのか分からない。
               直すのは「元の素材」の目盛りに切り替えてから。
          */
          fixed: applyCuts,
          /*
            🔴 掴みたい端の真上に来るので、押下を受け取らせない。
               受け取ると、その下にあるテロップの端が掴めなくなる。
          */
          decor: applyCuts,
        };
      }),
    [cutRegions, applyCuts, toAxis],
  );

  /**
   * BGM の帯。
   * 🔴 尺は「動画の残り全部」にする。
   *    音楽ファイルの実際の長さは読み込まないと分からないが、
   *    書き出し側で尺に合わせて切る／繰り返すので、ここでは動画側に合わせておく。
   */
  const musicRegions = useMemo<TimelineRegion[]>(
    () =>
      music
        ? [
            {
              id: 'music',
              start: music.start,
              end: player.duration,
              kind: 'music',
              label: `♪ ${music.path.split(/[\/]/).pop() ?? 'BGM'}`,
            },
          ]
        : [],
    [music, player.duration],
  );

  const addMusic = useCallback(async () => {
    const path = await onPickMusic?.();
    if (path) onMusicChange?.({ path, start: 0, volume: 0.18, loop: true });
  }, [onPickMusic, onMusicChange]);

  /**
   * 吸着させる時刻（カットの切れ目）。
   *
   * 🔴 テロップが切れ目をまたぐと、書き出したときに
   *    「前半だけ出て消える」「切った直後に唐突に出る」が起きる。
   *    切れ目にぴったり合わせられれば、それを避けられる。
   */
  const snapPoints = useMemo(() => {
    const out = new Set<number>();
    /*
      🔴 テロップ同士の端にも吸い付けること。
         隣のテロップにぴったり繋げたいときに、1フレームずつ詰めなくて済む。
         掴んでいる本人の端は Timeline 側で外す（自分の元の位置に戻されるため）。
    */
    for (const r of telopRegions) {
      out.add(Number(r.start.toFixed(3)));
      out.add(Number(r.end.toFixed(3)));
    }
    /*
      🔴 BGM の帯の端も入れること。
         テロップを BGM の鳴り始めに合わせたい、その逆もある。
         片方だけ吸い付くと、合わせられる組み合わせを覚えることになる。
    */
    for (const r of musicRegions) {
      out.add(Number(r.start.toFixed(3)));
      out.add(Number(r.end.toFixed(3)));
    }
    for (const r of cutRegions) {
      /*
        🔴 カットの**前も後ろも**吸着点にすること。
           以前は「カット後」の目盛りのときに終わり側を入れていなかったので、
           切れ目の後ろにテロップの頭を合わせられなかった。
           潰れて同じ値になる場合は Set が1つにまとめる。
      */
      out.add(Number(toAxis(r.start).toFixed(3)));
      out.add(Number(toAxis(r.end).toFixed(3)));
    }
    return [...out].sort((a, b) => a - b);
  }, [cutRegions, toAxis, telopRegions, musicRegions]);

  /** 吸着の入り切り。Final Cut と同じく N キーで切り替える */
  const [snapEnabled, setSnapEnabled] = useState(true);

  const needCheck = cards.filter((c) => c.needsCheck).length;

  const styleNames = useMemo(
    () => Object.keys(styles) as TelopStyleName[],
    [styles],
  );

  /* ---------- キー操作（Final Cut と同じ割り当て）---------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;

      /*
        コピー・貼り付け・複製。プラグイン版と同じ割り当てにする。
        🔴 matchShortcut より先に見ること。C / V / D は単独では別の意味を持つ。
      */
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'c' && cur) {
          e.preventDefault();
          copy();
          return;
        }
        if (k === 'v' && clipboard.current) {
          e.preventDefault();
          paste();
          return;
        }
        if (k === 'd' && cur) {
          e.preventDefault();
          duplicate();
          return;
        }
      }

      const action = matchShortcut(e);
      if (!action) {
        // 1〜9 で雛形を切り替える（このアプリ固有）
        const n = Number(e.key);
        if (cur && n >= 1 && n <= 9 && styleNames[n - 1]) {
          restyle(cur.id, styleNames[n - 1]);
          e.preventDefault();
        }
        return;
      }
      e.preventDefault();
      switch (action) {
        case 'playPause':
          player.toggle();
          break;
        case 'shuttleForward':
          player.shuttle(nextShuttle(player.rate * (player.playing ? 1 : 0), true));
          break;
        case 'shuttleBack':
          player.shuttle(nextShuttle(player.rate * (player.playing ? 1 : 0), false));
          break;
        case 'stop':
          player.shuttle(0);
          break;
        case 'frameBack':
          player.seek(Math.max(0, player.time - 1 / fps));
          break;
        case 'frameForward':
          player.seek(Math.min(player.duration, player.time + 1 / fps));
          break;
        case 'jumpBack':
          player.seek(Math.max(0, player.time - 10 / fps));
          break;
        case 'jumpForward':
          player.seek(Math.min(player.duration, player.time + 10 / fps));
          break;
        case 'home':
          player.seek(0);
          break;
        case 'end':
          player.seek(player.duration);
          break;
        case 'delete':
          if (cur) remove(cur.id);
          break;
        case 'undo':
          undo();
          break;
        case 'toggleSnap':
          setSnapEnabled((v) => !v);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cur, styleNames, restyle, player, fps, remove, copy, paste, duplicate, undo, srcTime, patch, duration]);

  return (
    <EditorShell
      step="telop"
      done={['source', 'cut']}
      toolbar={
        <>
          {onBack && <button onClick={onBack}>← カットに戻る</button>}
          {onQuit && (
            <button className="danger" onClick={onQuit}>
              編集をやめる
            </button>
          )}
          <button onClick={undo} disabled={!canUndo} title="Ctrl+Z / ⌘Z">
            元に戻す
          </button>
          <button
            className={onlyCheck ? 'on' : ''}
            onClick={() => setOnlyCheck((v) => !v)}
            title="自信の無いものだけ表示"
          >
            ⚠ 要確認だけ（{needCheck}）
          </button>
          <button className="go" onClick={() => onExport?.(cards)} disabled={exporting}>
            {exporting ? '書き出し中…' : '書き出しへ進む →'}
          </button>
        </>
      }
      viewer={
        <>
          {videoPath && (
            <video ref={videoRef} src={mediaUrl(videoPath)} style={{ display: 'none' }} />
          )}
          {/* BGM。映像とは別に鳴らし、出来上がりの時刻に合わせる */}
          <audio ref={audioRef} style={{ display: 'none' }} />
          <canvas
            ref={canvasRef}
            className="fcp-stage-inner"
            style={{ cursor: showing.length > 0 || cur ? 'move' : 'default' }}
            onPointerDown={onStagePointerDown}
            onPointerMove={onStagePointerMove}
            onPointerUp={endStageDrag}
            onPointerCancel={endStageDrag}
            title={cur ? 'ドラッグでテロップの位置を動かせます' : undefined}
          />
        </>
      }
      transport={
        <Transport
          player={player}
          fps={fps}
          info={
            <>
              <span className="fcp-chip">テロップ {cards.length}</span>
              {needCheck > 0 && (
                <span className="fcp-chip" style={{ color: 'var(--sel)' }}>
                  ⚠ 要確認 {needCheck}
                </span>
              )}
              {music && <span className="fcp-chip">♪ BGM</span>}
            </>
          }
        >
          <button
            className="icon"
            onClick={() =>
              cur && player.seek(Math.max(0, (applyCuts ? toOutput(segments, cur.srcStart) : cur.srcStart) - 1.5))
            }
            disabled={!cur}
            title="選んだテロップの少し手前から"
          >
            ⟲
          </button>
          <span style={{ width: 8 }} />
        </Transport>
      }
      inspectorTitle={curCut ? 'カット' : cur ? 'テロップ' : 'テロップ全体'}
      inspector={
        curCut ? (
          <>
            <div className="fcp-field">
              <label>切る範囲（元の素材の時刻）</label>
              <div className="fcp-stepper">
                <button
                  onClick={() =>
                    onCutsChange?.(
                      cutRegions.map((c) =>
                        c.id === curCut.id ? { ...c, start: Math.max(0, c.start - 1 / fps) } : c,
                      ),
                    )
                  }
                >
                  −1f
                </button>
                <output>{clock(curCut.start)}</output>
                <button
                  onClick={() =>
                    onCutsChange?.(
                      cutRegions.map((c) =>
                        c.id === curCut.id
                          ? { ...c, start: Math.min(c.end - 0.05, c.start + 1 / fps) }
                          : c,
                      ),
                    )
                  }
                >
                  +1f
                </button>
              </div>
              <div className="fcp-stepper">
                <button
                  onClick={() =>
                    onCutsChange?.(
                      cutRegions.map((c) =>
                        c.id === curCut.id
                          ? { ...c, end: Math.max(c.start + 0.05, c.end - 1 / fps) }
                          : c,
                      ),
                    )
                  }
                >
                  −1f
                </button>
                <output>{clock(curCut.end)}</output>
                <button
                  onClick={() =>
                    onCutsChange?.(
                      cutRegions.map((c) =>
                        c.id === curCut.id ? { ...c, end: c.end + 1 / fps } : c,
                      ),
                    )
                  }
                >
                  +1f
                </button>
              </div>
              <div className="fcp-dim">
                長さ {(curCut.end - curCut.start).toFixed(2)} 秒
              </div>
            </div>

            {applyCuts ? (
              <p className="fcp-dim">
                「カット後」の目盛りでは区間が潰れて印になっています。
                掴んで伸ばしたいときは <strong>元の素材</strong> に切り替えてください。
              </p>
            ) : (
              <p className="fcp-dim">
                タイムラインの<strong>端をドラッグ</strong>しても伸縮できます。
              </p>
            )}

            <button
              className="danger"
              onClick={() => onCutsChange?.(cutRegions.filter((c) => c.id !== curCut.id))}
            >
              このカットをやめる（残す）
            </button>

            <p className="fcp-dim">
              カットを変えても、テロップの文言はそのままです。
              切った言葉がテロップに残っていないか確かめてください。
            </p>
          </>
        ) : cur ? (
          <>
            <div className="fcp-field">
              <label>文言</label>
              <textarea
                value={cur.text}
                onChange={(e) => retext(cur.id, e.target.value)}
                rows={3}
                style={{
                  font: 'inherit',
                  fontSize: 14,
                  background: 'var(--s0)',
                  color: 'var(--text)',
                  border: '1px solid var(--line)',
                  borderRadius: 5,
                  padding: 8,
                  resize: 'vertical',
                }}
              />
              <div className="fcp-dim">
                実際の改行: {cur.lines.join(' / ')}
                {cur.fontScale < 1 && `（収めるため ${Math.round(cur.fontScale * 100)}% に縮小）`}
              </div>
            </div>

            <div className="fcp-field">
              <label>コピー・貼り付け</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                <button onClick={copy} title="Ctrl+C（Mac は ⌘C）">
                  コピー
                </button>
                <button onClick={paste} disabled={!hasCopy} title="Ctrl+V（Mac は ⌘V）">
                  再生位置に貼り付け
                </button>
                <button onClick={duplicate} title="Ctrl+D（Mac は ⌘D）">
                  複製
                </button>
              </div>
              {/*
                🔴 キーと意味は**1対1**で並べること。
                   「Ctrl+C / Ctrl+V ＝ コピー・貼り付け」のように2つずつ書くと、
                   どちらがどちらか読む側が組み替えることになる。
                   1行に詰め込むと横に長くなり、区切りも見分けられない。
              */}
              <dl className="fcp-keys">
                <div>
                  <dt>Ctrl + C</dt>
                  <dd>コピー</dd>
                </div>
                <div>
                  <dt>Ctrl + V</dt>
                  <dd>いまの再生位置に貼り付け</dd>
                </div>
                <div>
                  <dt>Ctrl + D</dt>
                  <dd>複製</dd>
                </div>
                <div>
                  <dt>Delete</dt>
                  <dd>このテロップを消す</dd>
                </div>
                <div>
                  <dt>Ctrl + Z</dt>
                  <dd>ひとつ戻す</dd>
                </div>
              </dl>
              <p className="fcp-dim">Mac は Ctrl の代わりに ⌘ です。</p>
              <p className="fcp-dim">
                同じ時間に何枚でも置けます。重なったぶんは
                {(cur.positionOverride ?? styles[cur.style]?.position) === 'bottom' ? '上' : '下'}
                へ段をずらして出します（書き出しも同じ並びです）。
              </p>
            </div>

            <div className="fcp-field">
              <label>雛形（数字キーでも切り替えられます）</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {styleNames.map((n, i) => (
                  <button
                    key={n}
                    className={cur.style === n ? 'on' : ''}
                    onClick={() => restyle(cur.id, n)}
                    title={`${i + 1}`}
                  >
                    {styles[n]?.label ?? n}
                  </button>
                ))}
              </div>
            </div>

            <div className="fcp-field">
              <label>出る時間</label>
              <div className="fcp-stepper">
                <button onClick={() => patch(cur.id, { srcStart: Math.max(0, cur.srcStart - 1 / fps) })}>
                  −1f
                </button>
                <output>{clock(cur.srcStart)}</output>
                <button onClick={() => patch(cur.id, { srcStart: cur.srcStart + 1 / fps })}>
                  +1f
                </button>
              </div>
              <div className="fcp-stepper">
                <button onClick={() => patch(cur.id, { srcEnd: Math.max(cur.srcStart + 0.1, cur.srcEnd - 1 / fps) })}>
                  −1f
                </button>
                <output>{clock(cur.srcEnd)}</output>
                <button onClick={() => patch(cur.id, { srcEnd: cur.srcEnd + 1 / fps })}>+1f</button>
              </div>
              <div className="fcp-dim">
                長さ {(cur.srcEnd - cur.srcStart).toFixed(2)} 秒。
                タイムラインの端をドラッグしても変えられます。
              </div>
            </div>

            <div className="fcp-field">
              <label>改行の位置</label>
              <div className="fcp-breaks">
                {[...cur.text].map((ch, i) => (
                  <span key={i}>
                    {ch}
                    {i < cur.text.length - 1 && (
                      <button
                        className={`brk ${cur.breaks?.includes(i + 1) ? 'on' : ''}`}
                        onClick={() => toggleBreak(i + 1)}
                        title={cur.breaks?.includes(i + 1) ? 'ここの改行をやめる' : 'ここで改行する'}
                      >
                        {cur.breaks?.includes(i + 1) ? '↵' : '·'}
                      </button>
                    )}
                  </span>
                ))}
              </div>
              {cur.breaks?.length ? (
                <button onClick={() => patch(cur.id, { breaks: undefined })}>自動に戻す</button>
              ) : null}
            </div>

            <div className="fcp-field">
              <label>目立たせる語</label>
              <input
                value={cur.highlight ?? ''}
                onChange={(e) => setHighlight(e.target.value || null)}
                placeholder="（例）いちばん"
                style={{
                  font: 'inherit',
                  fontSize: 14,
                  background: 'var(--s0)',
                  color: 'var(--text)',
                  border: '1px solid var(--line)',
                  borderRadius: 5,
                  padding: '6px 8px',
                }}
              />
            </div>

            <div className="fcp-field">
              <label>位置</label>
              <div className="fcp-dim">
                プレビューの文字を<strong>ドラッグ</strong>すると動かせます。
              </div>
              {(cur.offsetX !== 0 || cur.offsetY !== 0) && (
                <button onClick={() => patch(cur.id, { offsetX: 0, offsetY: 0 })}>
                  位置をもとに戻す
                </button>
              )}
            </div>

            {cur.needsCheck && (
              <p className="fcp-dim" style={{ color: 'var(--sel)' }}>
                ⚠ 聞き取りに自信がありません。声を聞いて確かめてください。
              </p>
            )}

            <button className="danger" onClick={() => remove(cur.id)}>
              このテロップを消す
            </button>

            {onStylesChange && (
              <details className="fcp-styleedit">
                <summary>雛形「{styles[cur.style]?.label ?? cur.style}」を編集</summary>
                <p className="fcp-dim">この枠を使っているテロップ全部に効きます。</p>

                <div className="fcp-field">
                  <label>書体</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {(fontFamilies ?? [styles[cur.style]?.fontFamily]).filter(Boolean).map((f) => (
                      <button
                        key={f}
                        className={styles[cur.style]?.fontFamily === f ? 'on' : ''}
                        style={{ fontFamily: f }}
                        onClick={() => patchStyle(cur.style, { fontFamily: f })}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      className={styles[cur.style]?.bold ? 'on' : ''}
                      onClick={() => patchStyle(cur.style, { bold: !styles[cur.style]?.bold })}
                    >
                      太字
                    </button>
                    <button
                      className={styles[cur.style]?.italic ? 'on' : ''}
                      onClick={() => patchStyle(cur.style, { italic: !styles[cur.style]?.italic })}
                    >
                      斜体
                    </button>
                  </div>
                </div>

                <div className="fcp-field">
                  <label>色</label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      type="color"
                      value={styles[cur.style]?.color ?? '#ffffff'}
                      onChange={(e) => patchStyle(cur.style, { color: e.target.value })}
                    />
                    <span className="fcp-dim">縁</span>
                    <input
                      type="color"
                      value={styles[cur.style]?.stroke?.color ?? '#000000'}
                      onChange={(e) =>
                        patchStyle(cur.style, {
                          stroke: {
                            color: e.target.value,
                            widthRatio: styles[cur.style]?.stroke?.widthRatio ?? 0.12,
                          },
                        })
                      }
                    />
                  </div>
                </div>

                <div className="fcp-field">
                  <label>大きさ</label>
                  <input
                    type="range"
                    min={0.02}
                    max={0.12}
                    step={0.002}
                    value={styles[cur.style]?.fontSizeRatio ?? 0.055}
                    onChange={(e) =>
                      patchStyle(cur.style, { fontSizeRatio: Number(e.target.value) })
                    }
                  />
                </div>

                <div className="fcp-field">
                  <label>置く場所</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {(['top', 'middle', 'bottom'] as const).map((p) => (
                      <button
                        key={p}
                        className={styles[cur.style]?.position === p ? 'on' : ''}
                        onClick={() => patchStyle(cur.style, { position: p })}
                      >
                        {{ top: '上', middle: '中央', bottom: '下' }[p]}
                      </button>
                    ))}
                  </div>
                </div>
              </details>
            )}
          </>
        ) : (
          <>
            {library && onLibraryChange && (
              <div className="fcp-field">
                <label>保存した見た目</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {library.presets.map((p) => (
                    <button
                      key={p.name}
                      className={p.name === library.current ? 'on' : ''}
                      onClick={() => {
                        onStylesChange?.(structuredClone(p.styles));
                        void onLibraryChange({ ...library, current: p.name });
                      }}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => {
                    const name = window.prompt('この見た目に名前を付けてください', '普段用');
                    if (!name) return;
                    const rest = library.presets.filter((p) => p.name !== name);
                    void onLibraryChange({
                      current: name,
                      presets: [...rest, { name, styles: structuredClone(styles) }],
                    });
                  }}
                >
                  ＋ 今の見た目を保存
                </button>
                {/*
                  🔴 既定へ戻す道を用意すること。
                     保存した組は、その時の既定を写して作られる。
                     あとで既定が変わっても保存した組は古いままなので、
                     「新しく入れ直しても位置が直らない」ように見える。
                     実際、既定を下寄せにしたあとも、それ以前に保存した組では
                     通常が上・強調が中央のままだった。
                */}
                <button
                  onClick={() => {
                    if (!window.confirm('見た目を最初の状態（位置は全部下）に戻します。よろしいですか？')) {
                      return;
                    }
                    onStylesChange?.(structuredClone(DEFAULT_STYLES));
                    void onLibraryChange({ ...library, current: null });
                  }}
                >
                  ↺ 最初の見た目に戻す
                </button>
                <p className="fcp-dim">
                  次に別の動画を編集するとき、最後に使った組で始まります。
                  <br />
                  保存した組は、保存したときの見た目のまま残ります。
                  位置が思ったところに出ないときは「最初の見た目に戻す」を試してください。
                </p>
              </div>
            )}

            {onPickMusic && (
              <div className="fcp-field">
                <label>BGM</label>
                {music ? (
                  <>
                    <div style={{ overflowWrap: 'anywhere', fontSize: 14 }}>
                      ♪ {music.path.split(/[\/]/).pop()}
                    </div>
                    <label className="fcp-dim">音量 {Math.round(music.volume * 100)}%</label>
                    <input
                      type="range"
                      min={0}
                      max={0.6}
                      step={0.01}
                      value={music.volume}
                      onChange={(e) =>
                        onMusicChange?.({ ...music, volume: Number(e.target.value) })
                      }
                    />
                    <label className="fcp-dim">
                      <input
                        type="checkbox"
                        checked={music.loop}
                        onChange={(e) => onMusicChange?.({ ...music, loop: e.target.checked })}
                      />{' '}
                      足りなければ繰り返す
                    </label>
                    <p className="fcp-dim">
                      動画の長さに合わせて切り、終わりは自然に消えます。
                      声の大きさは BGM に影響されません。
                    </p>
                    <button className="danger" onClick={() => onMusicChange?.(null)}>
                      BGM を外す
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={() => void addMusic()}>♪ 音楽を追加</button>
                    <p className="fcp-dim">mp3 / m4a / wav などを選べます。</p>
                  </>
                )}
              </div>
            )}

            {cutsChanged && onRebuildTelops && (
              <div className="fcp-field fcp-warn">
                <label>カットが変わっています</label>
                <p className="fcp-dim">
                  テロップは<strong>作られた時点のカット</strong>を元にしています。
                  切った言葉がテロップに残っている可能性があります。
                </p>
                <button onClick={onRebuildTelops}>テロップを今のカットで作り直す</button>
                <p className="fcp-dim">手で直した内容は引き継がれます。</p>
              </div>
            )}

            <div className="fcp-field">
              <label>枚数</label>
              <div>{cards.length} 枚</div>
            </div>
            <div className="fcp-field">
              <label>要確認</label>
              <div>{needCheck} 枚</div>
            </div>
            <p className="fcp-dim">
              タイムラインのテロップを選ぶと、ここで文言や雛形を直せます。
              下の段はカットした場所です（ここでは動かせません）。
            </p>
          </>
        )
      }
      timeline={
        <Timeline
          key={axis}
          duration={player.duration}
          fps={fps}
          currentTime={player.time}
          onSeek={player.seek}
          selectedId={selected}
          onSelect={setSelected}
          onTrim={onTrim}
          snapPoints={snapPoints}
          snapEnabled={snapEnabled}
          // 🔴 1〜9 は雛形の切り替え。コマの高さに奪わせない
          zoomKeys={false}
          timeControls={
            <MagnetToggle
              on={snapEnabled}
              onToggle={() => setSnapEnabled((v) => !v)}
              title="吸着（カットの切れ目に吸い付ける・N キー）"
              label="吸着"
            />
          }
          extraControls={
            <>
            {/* 🔴 見出しは枠の外に。中に入れるとボタンの1つに見える */}
            <span className="fcp-axis-label">カット箇所</span>
            <div className="fcp-axis" title="切る所を、暗くして見せるか、詰めて見せるか">
              <button
                className={axis === 'source' ? 'on' : ''}
                onClick={() => setAxis('source')}
                title="切る所を暗くして、元の長さのまま見せる"
              >
                表示
              </button>
              <button
                className={axis === 'edited' ? 'on' : ''}
                onClick={() => setAxis('edited')}
                title="切る所を詰めて、出来上がりの長さで見せる"
              >
                非表示
              </button>
            </div>
            </>
          }
          tracks={[
            /*
              🔴 切る所は**コマの上に重ねる**こと（カット画面と同じ）。
                 別のレーンに分けていると、テロップが「どの絵の所で切れるのか」を
                 縦に目で追わないと分からない。重ねれば切る所の絵が暗くなる。
            */
            {
              id: 'film',
              label: '素材',
              regions: cutTrack,
              overlay: true,
              scalable: true,
              height: 56,
              render: (v) => (
                <Filmstrip
                  {...v}
                  videoPath={videoPath}
                  aspect={frame.width / frame.height}
                  segments={applyCuts ? segments : undefined}
                />
              ),
            },
            /*
              🔴 重なったテロップは下の段へ。同じ段だと下の1枚が隠れて見えなくなる。
              🔴 段の高さは詰める。重なると段の数だけ縦に伸びるので、
                 1段が厚いと2〜3枚重ねただけでタイムラインが埋まる。
            */
            { id: 'telop', label: 'テロップ', regions: telopRegions, height: 26, stack: true },
            {
              id: 'wave',
              label: '音',
              regions: [],
              height: 48,
              render: (v) => <Waveform {...v} audioPath={audioPath} />,
            },
            {
              id: 'music',
              label: 'BGM',
              regions: musicRegions,
              height: 34,
            },
          ]}
        />
      }
    />
  );
}
