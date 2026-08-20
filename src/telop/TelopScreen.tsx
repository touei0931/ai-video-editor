/**
 * テロップ確認画面（②）。
 *
 * ここでの目標は「全部読む」ではなく「**直すべきものだけ見つける**」。
 * 20分素材ならテロップは200〜400枚になるので、1枚ずつ承認させたら
 * カットの時短がそのまま消える。
 *
 * そこで:
 *   - 一覧で流し読みできるようにし、承認操作そのものを無くす（既定は「そのまま使う」）
 *   - 認識が怪しい箇所（needs_check）だけ赤く出し、そこへ直接飛べるようにする
 *   - プレビューは**実際の映像の上に**出す。文字だけ見ても顔にかぶるか分からない。
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { shouldIgnoreKey } from '../keys';
import { hasRealBold, TELOP_FAMILIES } from './fonts';
import { buildLines, drawTelop } from './render';
import { phraseBoundaries } from './wrap';
import {
  DEFAULT_STYLES,
  resolveStyle,
  SAFE_AREA_RATIO,
  type StyleMap,
  type TelopStyle,
  type TelopPosition,
  type TelopStyleName,
} from './style';
import { resolveOverlaps, type Frame, type TelopCard } from './split';
import './telop.css';

export type { StyleMap };

/** 書き出し方の選択。 */
export interface ExportOptions {
  /** 映像にテロップを焼き込むか */
  burn: boolean;
  /** 字幕ファイル(SRT)も出すか */
  srt: boolean;
  /**
   * Final Cut などに読み込めるタイムライン(FCPXML)も出すか。
   * 「カットの判断はこのアプリ、仕上げは編集ソフト」という使い分けのため。
   */
  fcpxml: boolean;
}

const STYLE_LABEL: Record<TelopStyleName, string> = {
  normal: '通常',
  note: '補足',
  emphasis: '強調',
};

const STYLE_ORDER: TelopStyleName[] = ['normal', 'note', 'emphasis'];

/**
 * 再生する範囲。テロップの表示区間の前後にこれだけ足す。
 *
 * テロップだけを見せても「その文言で合っているか」は判断できない。
 * 前の会話が聞こえて初めて、聞き取りが正しいか・区切りが自然かが分かる。
 */
const LEAD_IN = 2.5;
const TAIL = 1.0;
const POSITION_ORDER: TelopPosition[] = ['bottom', 'middle', 'top'];
const POSITION_LABEL: Record<TelopPosition, string> = {
  top: '上',
  middle: '中央',
  bottom: '下',
};

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/**
 * 文言を直したあとも生きている改行位置だけを残す。
 *
 * 改行位置は文字数で持っているので、文言が変わると指している場所がずれる。
 * 直したあとの本文でも文節の切れ目になっている位置だけを残せば、
 * 「直した箇所より前の指定はそのまま」「おかしな位置には残らない」の両方になる。
 */
function keepBreaks(breaks: number[] | undefined, text: string): number[] | undefined {
  if (!breaks || breaks.length === 0) return undefined;
  const usable = new Set(phraseBoundaries(text));
  const kept = breaks.filter((b) => usable.has(b));
  return kept.length > 0 ? kept : undefined;
}

/**
 * 画面を離れるときに持ち出す状態。
 *
 * 🔴 カットに戻ってまた来たときに、直した内容が消えてはいけない。
 *    文言・スタイル・位置を数十枚ぶん直したあとに一度戻っただけで
 *    全部やり直しになるなら、実質「戻れない」のと同じ。
 */
export interface TelopEdits {
  cards: TelopCard[];
  styles: StyleMap;
  options: ExportOptions;
  /** 消したテロップ。作り直したときに復活させないために覚えておく */
  removed: TelopCard[];
}

export interface TelopScreenProps {
  cards: TelopCard[];
  /** 前回この画面で使っていた雛形。省略すると既定の雛形から始める */
  initialStyles?: StyleMap;
  initialOptions?: ExportOptions;
  /** 前回この画面で消したテロップ */
  initialRemoved?: TelopCard[];
  /**
   * 実際に読み込めた書体。ここに無いものは選ばせない。
   * 読み込めなかった書体を選べると、フォールバックの見た目で書き出される。
   */
  fontFamilies?: string[];
  /**
   * 今の見た目を「次からの既定」として保存する。
   * 保存できたら true。
   */
  onSaveDefaults?: (styles: StyleMap) => Promise<boolean>;
  /** 元素材のパス。プレビューの背景に使う */
  videoPath: string;
  frame: Frame;
  /** 実測幅で折り返す関数（編集したテキストを折り返し直すのに使う） */
  rewrap: (
    text: string,
    style: TelopStyleName,
    styles?: StyleMap,
    card?: { sizeScale?: number; breaks?: number[] },
  ) => { lines: string[]; fontScale: number };
  onBack?: (edits: TelopEdits) => void;
  /**
   * 直すたびに呼ばれる。呼び出し側で保存する。
   *
   * 🔴 「戻る」「進む」のときだけ渡すのでは足りない。
   *    それだと自動保存が走らず、メニューの「作業内容を保存」も
   *    **この画面に入る前の状態**を書いてしまう。
   *    100枚校正したあとに窓を閉じれば、押した記憶だけ残して全部消える。
   */
  onEditsChange?: (edits: TelopEdits) => void;
  /** 編集をやめて動画の選択に戻る */
  onQuit?: () => void;
  onExport: (cards: TelopCard[], styles: StyleMap, options: ExportOptions) => void;
  exporting?: boolean;
  /**
   * 書き出しに失敗したときの内容。
   * ここに出さないと、失敗して画面が戻っただけに見えて原因が分からない。
   */
  error?: string | null;
}

export function TelopScreen({
  cards: initial,
  initialStyles,
  initialOptions,
  initialRemoved,
  fontFamilies,
  onSaveDefaults,
  videoPath,
  frame,
  rewrap,
  onBack,
  onEditsChange,
  onQuit,
  onExport,
  exporting,
  error,
}: TelopScreenProps) {
  const [cards, setCards] = useState(initial);
  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  /**
   * スタイルの雛形。ここを変えると、そのスタイルのテロップが全部変わる。
   * 「通常のテロップの色を変えたい」は1枚ずつ直す作業ではないので、雛形側で持つ。
   */
  const [styles, setStyles] = useState<StyleMap>(
    () => structuredClone(initialStyles ?? DEFAULT_STYLES),
  );
  /** 雛形の編集パネルで今どのスタイルを触っているか */
  const [editingStyle, setEditingStyle] = useState<TelopStyleName>('normal');
  /** 既定として保存しているところ / 保存した結果の知らせ */
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState('');
  const [exportOptions, setExportOptions] = useState<ExportOptions>(
    () => initialOptions ?? { burn: true, srt: true, fcpxml: false },
  );
  /** この画面で消したテロップ。作り直したときに復活させないために持ち出す */
  const [removed, setRemoved] = useState<TelopCard[]>(() => initialRemoved ?? []);
  /**
   * 直前の状態。Del で消したものを戻せないと、誤爆が怖くて Del を押せなくなる。
   * テロップは数百枚あるので、履歴は直近だけで十分。
   */
  const undoStack = useRef<TelopCard[][]>([]);

  const remember = useCallback(() => {
    undoStack.current.push(cards);
    if (undoStack.current.length > 30) undoStack.current.shift();
  }, [cards]);

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    setCards(prev);
    setIndex((i) => Math.min(i, prev.length - 1));
  }, []);

  /**
   * 全テロップの時刻をまとめてずらす。
   * 文字起こしのタイムスタンプは全体的に数十〜百数十ms遅れることがあり、
   * それを1枚ずつ直していたら数百回の操作になる。
   */
  const shiftAll = useCallback((delta: number) => {
    setCards((prev) =>
      // 全部同じだけ動かすので普通は重ならないが、先頭が 0 秒で止まると詰まる
      resolveOverlaps(
        prev.map((c) => ({
          ...c,
          srcStart: Number(Math.max(0, c.srcStart + delta).toFixed(3)),
          srcEnd: Number(Math.max(0.2, c.srcEnd + delta).toFixed(3)),
          edited: true,
        })),
      ),
    );
  }, []);

  const patchStyle = useCallback(
    (name: TelopStyleName, patch: Partial<TelopStyle>) => {
      // 見た目を触ったら「覚えました」の表示は消す。
      // 出したままだと、そのあと直した内容まで覚えたように読める。
      setSavedNote('');
      setStyles((prev) => {
        const next = { ...prev, [name]: { ...prev[name], ...patch } };

        /*
          🔴 文字の大きさ・書体を変えたら、折り返しを計算し直す。

          描画側は編集後の雛形を使うのに、行の分け方は作ったときのまま。
          「大きさ」を 0.085 から 0.16 に上げると、幅は 0.085 基準のまま
          文字だけ大きくなり、**画面外へはみ出したまま書き出される**。
          プレビューと書き出しは一致するので、両方おかしいことに気づけない。
        */
        if (
          patch.fontSizeRatio !== undefined ||
          patch.fontFamily !== undefined ||
          // 太字・斜体でも字の幅は変わる。ここを漏らすと、太字にした瞬間だけ
          // 折り返しが古い幅のままになり、テロップが画面からはみ出す
          patch.bold !== undefined ||
          patch.italic !== undefined
        ) {
          setCards((cs) =>
            cs.map((c) => {
              if (c.style !== name) return c;
              const fit = rewrap(c.text, name, next, {
                sizeScale: c.override?.sizeScale,
                breaks: c.breaks,
              });
              return { ...c, lines: fit.lines, fontScale: fit.fontScale };
            }),
          );
        }
        return next;
      });
    },
    [rewrap],
  );

  /** 選べる書体。読み込めなかったものは出さない（選べても見た目が変わらないため） */
  const families = useMemo(
    () => TELOP_FAMILIES.filter((f) => !fontFamilies || fontFamilies.includes(f.family)),
    [fontFamilies],
  );

  /** 今の見た目を、次の動画からの既定として覚えさせる */
  const saveDefaults = useCallback(async () => {
    if (!onSaveDefaults) return;
    setSaving(true);
    let ok = false;
    try {
      ok = await onSaveDefaults(styles);
    } catch {
      ok = false;
    }
    setSaving(false);
    setSavedNote(
      ok ? '覚えました。次の動画からこの見た目で始まります' : '保存できませんでした',
    );
  }, [onSaveDefaults, styles]);

  /** アプリ最初の見た目に戻す。今の動画にも、次からの既定にも効かせる */
  const restoreFactory = useCallback(() => {
    for (const name of STYLE_ORDER) patchStyle(name, DEFAULT_STYLES[name]);
    if (!onSaveDefaults) return;
    void onSaveDefaults(structuredClone(DEFAULT_STYLES)).then(
      (ok) => setSavedNote(ok ? '最初の見た目に戻しました' : '保存できませんでした'),
      () => setSavedNote('保存できませんでした'),
    );
  }, [patchStyle, onSaveDefaults]);

  /** 画面を離れるときに、直した内容をまとめて渡す */
  const goBack = useCallback(
    (): TelopEdits => ({ cards, styles, options: exportOptions, removed }),
    [cards, styles, exportOptions, removed],
  );

  /*
    直した内容を、変わるたびに呼び出し側へ渡す。保存はそちらの責任。

    🔴 渡す関数そのものを「変わったかどうか」の判定に入れてはいけない。

    呼び出し側は受け取った内容を state に入れる。すると呼び出し側が再描画され、
    渡ってくる関数の中身（識別子）も作り直される。それを判定に入れていると
    **内容が1文字も変わっていないのにまた呼ぶ**ことになり、以後それが延々と続く。

    実際に起きていたこと:
      - テロップ画面にいるだけで CPU を1コア分（実測 107%）食い続ける。
        ファンの無い MacBook Air では熱で本体ごと遅くなる。
      - 自動保存は「最後の変更から 0.8 秒後に書く」ので、
        呼ばれ続けるかぎり**永久に書かれない**。
        100枚校正して閉じても、下書きには1文字も残らない。

    関数は ref に置いて、判定は中身だけで行う。
  */
  const notifyRef = useRef(onEditsChange);
  notifyRef.current = onEditsChange;
  useEffect(() => {
    notifyRef.current?.({ cards, styles, options: exportOptions, removed });
  }, [cards, styles, exportOptions, removed]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);

  const current = cards[index];
  /** 実際に使われる位置。1枚の上書きが無ければ雛形に従う */
  const currentPosition = current
    ? (current.positionOverride ?? styles[current.style].position)
    : 'bottom';
  const checkCount = useMemo(() => cards.filter((c) => c.needsCheck).length, [cards]);
  const styleCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const c of cards) out[c.style] = (out[c.style] ?? 0) + 1;
    return out;
  }, [cards]);

  const update = useCallback(
    (patch: Partial<TelopCard>) => {
      // 🔴 手を入れた印を必ず付ける。カットを直してテロップを作り直したとき、
      //    どれを引き継ぐべきかがこれでしか分からない。
      setCards((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch, edited: true } : c)));
    },
    [index],
  );

  /**
   * 折り返しを計算し直したうえでの変更内容を作る。
   *
   * 🔴 文言・スタイル・**大きさ**・改行位置のどれを変えてもここを通すこと。
   *    描画は resolveStyle で「雛形 × 縮小率 × この1枚の倍率」を掛けるのに、
   *    折り返しの計算だけ倍率を見ていなかった。そのため「この1枚の大きさ」を
   *    小さくしても行の分け方は大きいときのままで、**縮めたのに2行のまま**になる。
   *    逆に大きくすると、行の幅は小さいとき基準のまま文字だけ育って画面から溢れる。
   */
  const refit = useCallback(
    (card: TelopCard, patch: Partial<TelopCard>): Partial<TelopCard> => {
      const text = patch.text ?? card.text;
      const style = patch.style ?? card.style;
      const override = 'override' in patch ? patch.override : card.override;
      const breaks = 'breaks' in patch ? patch.breaks : card.breaks;
      const fit = rewrap(text, style, styles, { sizeScale: override?.sizeScale, breaks });
      return { ...patch, lines: fit.lines, fontScale: fit.fontScale };
    },
    [rewrap, styles],
  );

  const move = useCallback(
    (delta: number) => {
      setIndex((i) => Math.max(0, Math.min(cards.length - 1, i + delta)));
      setEditing(false);
    },
    [cards.length],
  );

  /**
   * 次の「要確認」へ飛ぶ。ここだけ見れば済むようにするのが狙い。
   *
   * 🔴 要確認が1件も無いときに -1 を渡さないこと。
   *    以前は findIndex の -1 をそのまま setIndex しており、current が undefined になって
   *    「テロップがありません」画面に落ちた。そこの主ボタンは「テロップ無しで進む」なので、
   *    **テロップ0枚のまま書き出しまで進めてしまう**。
   *    認識がきれいな素材ほど（要確認が0件になるほど）踏む。
   */
  const nextCheck = useCallback(() => {
    const after = cards.findIndex((c, i) => i > index && c.needsCheck);
    const target = after >= 0 ? after : cards.findIndex((c) => c.needsCheck);
    if (target < 0) return;
    setIndex(target);
    setEditing(false);
  }, [cards, index]);

  const cycleStyle = useCallback(
    (name: TelopStyleName) => {
      if (!current) return;
      // スタイルが変わるとフォントも大きさも変わるので、折り返しを計算し直す
      update(refit(current, { style: name, reason: '手動で変更' }));
      setEditingStyle(name);
    },
    [current, refit, update],
  );

  /**
   * 表示時刻をずらす / 伸縮する。
   *
   * 🔴 動かしたあとは必ず重なりを解消する。
   *    重なったまま書き出すと、テロップの帯は1本なので
   *    「前が消えるまで次が出ない」という形で後ろが軒並みずれる。
   */
  const shiftTime = useCallback(
    (deltaStart: number, deltaEnd: number) => {
      if (!current) return;
      const start = Math.max(0, current.srcStart + deltaStart);
      const end = Math.max(start + 0.2, current.srcEnd + deltaEnd);
      const id = current.id;
      const fixed = resolveOverlaps(
        cards.map((c) =>
          c.id === id
            ? {
                ...c,
                srcStart: Number(start.toFixed(3)),
                srcEnd: Number(end.toFixed(3)),
                edited: true,
              }
            : c,
        ),
      );
      setCards(fixed);
      setIndex(fixed.findIndex((c) => c.id === id));
    },
    [current, cards],
  );

  /**
   * 今の再生位置に空のテロップを足す。
   *
   * 文字起こしが拾えなかった発言や、後から入れたい一言のため。
   * 既存の並びに割り込ませるので、追加後は時刻順に並べ直す。
   */
  const addTelop = useCallback(() => {
    const at = videoRef.current?.currentTime ?? current?.srcStart ?? 0;
    const card: TelopCard = {
      id: `manual-${Date.now()}`,
      unitId: `manual-${Date.now()}`,
      srcStart: Number(at.toFixed(3)),
      srcEnd: Number((at + 2).toFixed(3)),
      text: '新しいテロップ',
      lines: ['新しいテロップ'],
      style: 'normal',
      reason: '手で追加',
      needsCheck: false,
      confidence: 1,
      lowWords: 0,
      fontScale: 1,
      offsetX: 0,
      offsetY: 0,
      manual: true,
    };
    remember();
    // 割り込ませた場所に既にテロップがあることは珍しくない。重なりはここで解消する
    const next = resolveOverlaps([...cards, card]);
    setCards(next);
    setIndex(next.findIndex((c) => c.id === card.id));
    setDraft(card.text);
    setEditing(true);
  }, [cards, current, remember]);

  // ── プレビュー上でテロップを掴んで動かす ──
  //
  // 🔴 ドラッグ中は state を更新しない。
  //    1回動かすたびにテロップ一覧（数百件）ごと再描画されて引っかかる。
  //    動かしている間は Canvas を CSS でずらすだけにして、離したときに確定する。
  const dragRef = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);

  const onDragStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
  }, []);

  const onDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || !canvasRef.current) return;
    drag.dx = e.clientX - drag.x;
    drag.dy = e.clientY - drag.y;
    canvasRef.current.style.transform = `translate(${drag.dx}px, ${drag.dy}px)`;
  }, []);

  const onDragEnd = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag || !current) return;
      if (canvasRef.current) canvasRef.current.style.transform = '';
      if (Math.abs(drag.dx) < 2 && Math.abs(drag.dy) < 2) return;

      // 画面サイズに対する比率で持つので、解像度が変わっても同じ位置になる
      const box = e.currentTarget.getBoundingClientRect();
      update({
        offsetX: Number((current.offsetX + drag.dx / box.width).toFixed(4)),
        offsetY: Number((current.offsetY + drag.dy / box.height).toFixed(4)),
      });
    },
    [current, update],
  );

  const commitEdit = useCallback(() => {
    if (!current) return;
    const text = draft.trim();
    setEditing(false);
    if (!text || text === current.text) return;
    // 文言が変われば文節の切れ目も変わる。指したままにできる改行位置だけ残す
    update(refit(current, { text, breaks: keepBreaks(current.breaks, text), needsCheck: false }));
  }, [current, draft, refit, update]);

  // ── 改行位置を自分で決める ──
  //
  // 🔴 どこでも切れるようにはしない。文節の切れ目だけを選ばせる。
  //    自由に切れると「お前顔映ってもい / いな」のような改行が作れてしまい、
  //    自動改行より悪い結果を手で作れることになる。
  const boundaries = useMemo(() => phraseBoundaries(current?.text ?? ''), [current?.text]);
  const chosenBreaks = useMemo(() => new Set(current?.breaks ?? []), [current?.breaks]);

  const toggleBreak = useCallback(
    (at: number) => {
      if (!current) return;
      const next = new Set(current.breaks ?? []);
      if (next.has(at)) next.delete(at);
      else next.add(at);
      const sorted = [...next].sort((a, b) => a - b);
      update(refit(current, { breaks: sorted.length > 0 ? sorted : undefined }));
    },
    [current, refit, update],
  );

  // ── プレビュー ─────────────────────────────────────────
  // 元素材の該当箇所を、前後の会話込みでループ再生し、その上に Canvas で描く。
  const windowStart = Math.max(0, (current?.srcStart ?? 0) - LEAD_IN);
  const windowEnd = (current?.srcEnd ?? 0) + TAIL;
  const restart = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = windowStart;
    // 自動再生が拒否される環境でも、画面が止まるだけで済むようにする
    void video.play().catch(() => undefined);
  }, [windowStart]);

  useEffect(() => {
    if (current) restart();
  }, [current?.id, restart]);

  /**
   * 再生位置に応じて、テロップの表示/非表示と再生バーを更新する。
   *
   * 🔴 React の state ではなく DOM を直接触る。
   *    timeupdate イベントは 4回/秒 程度しか来ないので、テロップの出方が最大 250ms ずれる。
   *    かといって毎フレーム state を更新すると、テロップ数百件の一覧ごと再描画されて重くなる。
   *    ここで見たいのは「出るタイミングが合っているか」なので、精度が要る。
   */
  useEffect(() => {
    if (!current) return;
    let raf = 0;
    const span = windowEnd - windowStart;

    const tick = () => {
      const video = videoRef.current;
      if (video) {
        let t = video.currentTime;
        // 範囲を区切ったループ再生。前後の会話ごと繰り返す。
        if (t >= windowEnd || t < windowStart - 0.5) {
          video.currentTime = windowStart;
          t = windowStart;
        }
        if (canvasRef.current) {
          canvasRef.current.style.opacity =
            t >= current.srcStart && t <= current.srcEnd ? '1' : '0';
        }
        if (barRef.current) {
          barRef.current.style.width = `${Math.max(0, Math.min(1, (t - windowStart) / span)) * 100}%`;
        }
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [current, windowStart, windowEnd]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !current) return;
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, frame.width, frame.height);
    // 🔴 書き出しと同じ resolveStyle / buildLines を通す（rasterize.ts と対）
    const resolved = resolveStyle(styles, current.style, current.override, current.fontScale);
    drawTelop(
      ctx,
      {
        lines: buildLines(current.lines, current.highlight ?? undefined, resolved),
        style: resolved,
        position: current.positionOverride ?? resolved.position,
        offsetX: current.offsetX,
        offsetY: current.offsetY,
      },
      frame,
    );
  }, [current, styles, frame.width, frame.height]);

  // 選択中の項目が一覧の外に出たら追従させる
  useEffect(() => {
    const list = listRef.current;
    const item = list?.querySelector<HTMLElement>('[aria-current="true"]');
    item?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // メニューからの「通しで確認」「テロップを追加」
  useEffect(() => {
    const onMenu = (e: Event) => {
      const action = (e as CustomEvent<string>).detail;
      if (action === 'fullpreview' || action === 'export') onExport(cards, styles, exportOptions);
    };
    window.addEventListener('app:menu-action', onMenu);
    return () => window.removeEventListener('app:menu-action', onMenu);
  }, [cards, styles, exportOptions, onExport]);

  // Ctrl+T でテロップ追加
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't') {
        addTelop();
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addTelop]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing) {
        if (e.key === 'Enter') {
          commitEdit();
          e.preventDefault();
        } else if (e.key === 'Escape') {
          setEditing(false);
          e.preventDefault();
        }
        return;
      }

      // 🔴 文字を打っている場所のキーは奪わない（src/keys.ts の冒頭参照）。
      //    editing だけを見ていたため、「強調する語」の入力欄で Backspace を押すと
      //    テロップそのものが消えていた。
      if (shouldIgnoreKey(e)) return;

      switch (e.key.toLowerCase()) {
        case 'arrowdown':
        case 'j':
          move(1);
          break;
        case 'arrowup':
        case 'k':
          move(-1);
          break;
        case 'tab':
          nextCheck();
          break;
        case 'e':
          if (!current) return;
          setDraft(current.text);
          setEditing(true);
          break;
        case '1':
          cycleStyle('normal');
          break;
        case '2':
          cycleStyle('note');
          break;
        case '3':
          cycleStyle('emphasis');
          break;
        case 'p': {
          if (!current) return;
          const now = current.positionOverride ?? styles[current.style].position;
          const next = POSITION_ORDER[(POSITION_ORDER.indexOf(now) + 1) % POSITION_ORDER.length];
          update({ positionOverride: next });
          break;
        }
        case ' ': {
          const video = videoRef.current;
          if (!video) return;
          if (video.paused) void video.play().catch(() => undefined);
          else video.pause();
          break;
        }
        case 'r':
          restart();
          break;
        // 🔴 Backspace は割り当てない。
        //    Mac の delete キーは普段「文字を消す」キーで、一覧を眺めている最中に
        //    押しやすい。消すのは Del だけで足りる。
        case 'delete':
          remember();
          setCards((prev) => {
            const gone = prev[index];
            if (gone) setRemoved((r) => [...r, gone]);
            return prev.filter((_, i) => i !== index);
          });
          setIndex((i) => Math.max(0, Math.min(cards.length - 2, i)));
          break;
        case 'z':
          if (e.ctrlKey || e.metaKey) undo();
          else return;
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, commitEdit, move, nextCheck, cycleStyle, update, restart, remember, undo, styles, current, index, cards.length]);

  if (!current) {
    return (
      <div className="telop empty">
        <h1>テロップがありません</h1>
        <p className="muted">文字起こしから作れるテロップがありませんでした。</p>
        <div className="actions">
          {onBack && <button onClick={() => onBack(goBack())}>戻る</button>}
          <button className="primary" onClick={() => onExport([], styles, exportOptions)}>
            テロップ無しで進む
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="telop">
      <header>
        <span className="counter">
          テロップ <strong>{cards.length}</strong> 枚
        </span>
        <span className="stats">
          {STYLE_ORDER.map((s) => (
            <span key={s} className={`chip ${s}`}>
              {STYLE_LABEL[s]} {styleCounts[s] ?? 0}
            </span>
          ))}
        </span>
        {checkCount > 0 && (
          <button className="check-jump" onClick={nextCheck}>
            要確認 {checkCount} 件へ（Tab）
          </button>
        )}
        <div className="grow" />
        <span className="shiftall" title="全テロップの表示時刻をまとめてずらします">
          全体
          <button onClick={() => shiftAll(-0.1)}>−0.1秒</button>
          <button onClick={() => shiftAll(0.1)}>+0.1秒</button>
        </span>
        <button onClick={addTelop} title="今の再生位置にテロップを足す">＋ テロップを追加</button>
        {/*
          焼き込み一択だと後工程が詰む。BGM も B-roll も足せず、
          あとからカットを1箇所足すだけでテロップが単語の途中で切れる。
          SRT を出せば「カットはこのアプリ、テロップは編集ソフト」が選べる。
        */}
        <label className="opt" title="映像そのものに文字を描き込みます">
          <input
            type="checkbox"
            checked={exportOptions.burn}
            onChange={(e) => setExportOptions((o) => ({ ...o, burn: e.target.checked }))}
          />
          動画に文字を入れる
        </label>
        <label className="opt" title="他の編集ソフトに読み込める字幕ファイルを別に作ります">
          <input
            type="checkbox"
            checked={exportOptions.srt}
            onChange={(e) => setExportOptions((o) => ({ ...o, srt: e.target.checked }))}
          />
          字幕ファイルも作る
        </label>
        <label
          className="opt"
          title="Final Cut Pro に読み込めるタイムラインを作ります。カットの位置がそのまま入ります"
        >
          <input
            type="checkbox"
            checked={exportOptions.fcpxml}
            onChange={(e) => setExportOptions((o) => ({ ...o, fcpxml: e.target.checked }))}
          />
          Final Cut 用も作る
        </label>
        {onBack && <button onClick={() => onBack(goBack())}>カットに戻る</button>}
        {onQuit && <button onClick={onQuit}>編集をやめる</button>}
        <button className="primary" disabled={exporting} onClick={() => onExport(cards, styles, exportOptions)}>
          {exporting ? '書き出し中…' : '通しで確認 →'}
        </button>
      </header>

      {/*
        🔴 両方外すとテロップが1枚も出ない。
           数百枚校正したあとにこれをやると、完了画面の「テロップ 0 枚」を見ても
           本人は気づかない。押す前に言う。
      */}
      {!exportOptions.burn && !exportOptions.srt && cards.length > 0 && (
        <p className="export-error">
          「動画に文字を入れる」も「字幕ファイルも作る」も外れています。
          このままだと、直したテロップは<strong>1枚も出力されません</strong>。
        </p>
      )}

      {error && (
        <p className="export-error">
          書き出しに失敗しました: {error}
          <br />
          <small>
            詳細は <code>phase0-artifacts/last-error.json</code> に記録しています。
          </small>
        </p>
      )}

      <div className="body">
        <ul className="list" ref={listRef}>
          {cards.map((c, i) => (
            <li key={c.id}>
              <button
                type="button"
                className={`row ${i === index ? 'current' : ''} ${c.needsCheck ? 'check' : ''}`}
                aria-current={i === index}
                onClick={() => {
                  setIndex(i);
                  setEditing(false);
                }}
              >
                <span className="t">{formatTime(c.srcStart)}</span>
                <span className={`chip ${c.style}`}>{STYLE_LABEL[c.style]}</span>
                <span className="text">{c.text}</span>
                {c.needsCheck && <span className="flag" title="認識が怪しい箇所です">要確認</span>}
              </button>
            </li>
          ))}
        </ul>

        <section className="stage">
          <div
            className="canvas-wrap"
            style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
            title="ドラッグでテロップの位置を動かせます"
          >
            <video
              ref={videoRef}
              className="bg"
              src={`media://local/${encodeURIComponent(videoPath.replace(/\\/g, '/'))}`}
              playsInline
              preload="auto"
              onLoadedMetadata={restart}
            />
            {/*
              テロップは表示区間の間だけ出す。
              ずっと出しっぱなしにすると「出るタイミングが正しいか」を確認できない。
              opacity は上の requestAnimationFrame が直接書き換える。
            */}
            <canvas ref={canvasRef} className="overlay" style={{ opacity: 0 }} />

            {/*
              投稿先のUI（TikTokのキャプション帯、Shortsのタイトル行）が乗る領域。
              ここにテロップを置くと隠れる。
            */}
            <div className="safe-area" aria-hidden>
              <span className="band top" style={{ height: `${SAFE_AREA_RATIO.top * 100}%` }} />
              <span className="band bottom" style={{ height: `${SAFE_AREA_RATIO.bottom * 100}%` }} />
            </div>
          </div>

          {/* 再生位置と、テロップが出ている区間 */}
          <div className="playbar" aria-hidden>
            <span ref={barRef} className="played" />
            <span
              className="band"
              style={{
                left: `${((current.srcStart - windowStart) / (windowEnd - windowStart)) * 100}%`,
                width: `${((current.srcEnd - current.srcStart) / (windowEnd - windowStart)) * 100}%`,
              }}
            />
          </div>

          <div className="editor">
            {editing ? (
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitEdit}
                aria-label="テロップの文言"
              />
            ) : (
              <button type="button" className="text-display" onClick={() => {
                setDraft(current.text);
                setEditing(true);
              }}>
                {current.text}
              </button>
            )}

            <div className="meta">
              {current.fontScale < 1 && (
                <span className="scale">収めるため {Math.round(current.fontScale * 100)}% に縮小</span>
              )}
              {current.reason && <span className="reason">{current.reason}</span>}
              {current.needsCheck && (
                <span className="flag">
                  聞き取りが怪しい（平均確度 {current.confidence.toFixed(2)}
                  {current.lowWords > 0 && ` / 怪しい語 ${current.lowWords}`}）
                </span>
              )}
            </div>

            {/* ── この1枚の調整 ── */}
            <div className="panel">
              <div className="row">
                <label>表示時刻</label>
                <span className="value">
                  {formatTime(current.srcStart)} → {formatTime(current.srcEnd)}
                  （{(current.srcEnd - current.srcStart).toFixed(1)}秒）
                </span>
                <button type="button" onClick={() => shiftTime(-0.1, -0.1)} title="全体を早める">
                  ←
                </button>
                <button type="button" onClick={() => shiftTime(0.1, 0.1)} title="全体を遅らせる">
                  →
                </button>
                <button type="button" onClick={() => shiftTime(0, -0.2)} title="表示時間を短く">
                  短く
                </button>
                <button type="button" onClick={() => shiftTime(0, 0.2)} title="表示時間を長く">
                  長く
                </button>
                {/*
                  次のテロップに接していると「長く」を押しても伸びない。
                  黙って何も起きないと壊れて見えるので、理由を出す。
                */}
                {cards[index + 1] && current.srcEnd >= cards[index + 1].srcStart - 0.001 && (
                  <span className="hint">次のテロップが始まるまで出ています</span>
                )}
              </div>

              {/*
                ② 改行位置を自分で決める。
                自動でも文節の切れ目で折り返すが、「ここで切りたい」は人によって違う。
              */}
              <div className="row breaks">
                <label>改行位置</label>
                {boundaries.length === 0 ? (
                  <span className="hint">短いので改行しません</span>
                ) : (
                  <span className="breakpicker">
                    {boundaries.map((at, i) => (
                      <Fragment key={at}>
                        <span className="ph">
                          {current.text.slice(i === 0 ? 0 : boundaries[i - 1], at)}
                        </span>
                        <button
                          type="button"
                          className={`br ${chosenBreaks.has(at) ? 'on' : ''}`}
                          title={chosenBreaks.has(at) ? 'ここの改行をやめる' : 'ここで改行する'}
                          aria-label={chosenBreaks.has(at) ? 'ここの改行をやめる' : 'ここで改行する'}
                          onClick={() => toggleBreak(at)}
                        >
                          {chosenBreaks.has(at) ? '↵' : '·'}
                        </button>
                      </Fragment>
                    ))}
                    <span className="ph">
                      {current.text.slice(boundaries[boundaries.length - 1])}
                    </span>
                  </span>
                )}
                {current.breaks && current.breaks.length > 0 && (
                  <button
                    type="button"
                    onClick={() => update(refit(current, { breaks: undefined }))}
                  >
                    自動に戻す
                  </button>
                )}
                <span className="hint">
                  今 {current.lines.length}行（{current.lines.join(' / ')}）
                </span>
              </div>

              <div className="row">
                <label>位置</label>
                {POSITION_ORDER.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={currentPosition === p ? 'on' : ''}
                    onClick={() => update({ positionOverride: p })}
                  >
                    {POSITION_LABEL[p]}
                  </button>
                ))}
                {current.positionOverride && (
                  <button type="button" onClick={() => update({ positionOverride: undefined })}>
                    雛形に戻す
                  </button>
                )}
                {(current.offsetX !== 0 || current.offsetY !== 0) && (
                  <button type="button" onClick={() => update({ offsetX: 0, offsetY: 0 })}>
                    ずらしを戻す
                  </button>
                )}
                <span className="hint">
                  {current.offsetX || current.offsetY
                    ? `ずらし ${(current.offsetX * 100).toFixed(0)}%, ${(current.offsetY * 100).toFixed(0)}%`
                    : 'プレビューをドラッグでも動かせます'}
                </span>
              </div>

              <div className="row">
                <label>強調する語</label>
                <input
                  type="text"
                  className="hl"
                  value={current.highlight ?? ''}
                  placeholder="例: めちゃくちゃ"
                  onChange={(e) => update({ highlight: e.target.value || null })}
                />
                <span className="hint">この語だけ色と大きさが変わります</span>
              </div>

              <div className="row">
                <label>この1枚の色</label>
                <input
                  type="color"
                  value={current.override?.color ?? styles[current.style].color}
                  onChange={(e) =>
                    update({ override: { ...current.override, color: e.target.value } })
                  }
                  title="文字色"
                />
                <input
                  type="color"
                  value={
                    current.override?.strokeColor ?? styles[current.style].stroke?.color ?? '#000000'
                  }
                  onChange={(e) =>
                    update({ override: { ...current.override, strokeColor: e.target.value } })
                  }
                  title="縁の色"
                />
                <label className="sub">大きさ</label>
                {/*
                  🔴 大きさを変えたら折り返しを計算し直す（refit）。
                     小さくしたのに2行のまま、大きくしたら画面からはみ出す、を防ぐ。
                */}
                <input
                  type="range"
                  min={0.6}
                  max={1.8}
                  step={0.05}
                  value={current.override?.sizeScale ?? 1}
                  onChange={(e) =>
                    update(
                      refit(current, {
                        override: { ...current.override, sizeScale: Number(e.target.value) },
                      }),
                    )
                  }
                />
                {current.override && (
                  <button type="button" onClick={() => update(refit(current, { override: undefined }))}>
                    既定に戻す
                  </button>
                )}
              </div>
            </div>

            {/* ── スタイルの雛形（同じスタイルのテロップすべてに効く）── */}
            <div className="panel">
              <div className="row">
                <label>雛形を編集</label>
                {STYLE_ORDER.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={editingStyle === s ? 'on' : ''}
                    onClick={() => setEditingStyle(s)}
                  >
                    {STYLE_LABEL[s]}
                  </button>
                ))}
                <span className="hint">このスタイルのテロップすべてに効きます</span>
              </div>

              {/*
                ── 書体 ──
                書体は雛形側に持たせる。1枚ずつ持たせると、300枚の書体を変えるのに
                300回操作することになる。「通常のテロップは明朝で」は一度決めるもの。
              */}
              <div className="row">
                <label className="sub">書体</label>
                <span className="fontpicker">
                  {families.map((f) => (
                    <button
                      key={f.family}
                      type="button"
                      className={styles[editingStyle].fontFamily === f.family ? 'on' : ''}
                      style={{ fontFamily: `"${f.family}", sans-serif` }}
                      onClick={() => patchStyle(editingStyle, { fontFamily: f.family })}
                    >
                      {f.label}
                    </button>
                  ))}
                </span>
                <button
                  type="button"
                  className={styles[editingStyle].bold ? 'on' : ''}
                  onClick={() => patchStyle(editingStyle, { bold: !styles[editingStyle].bold })}
                  title={
                    hasRealBold(styles[editingStyle].fontFamily)
                      ? '太いほうの書体に切り替えます'
                      : 'この書体は太さが1種類しかないので、字を太らせて作ります'
                  }
                >
                  <strong>太字</strong>
                </button>
                <button
                  type="button"
                  className={styles[editingStyle].italic ? 'on' : ''}
                  onClick={() => patchStyle(editingStyle, { italic: !styles[editingStyle].italic })}
                  title="字を傾けます（日本語の書体に斜体は無いので、どの書体でも傾けて作ります）"
                >
                  <em>斜体</em>
                </button>
                {styles[editingStyle].bold && !hasRealBold(styles[editingStyle].fontFamily) && (
                  <span className="hint">この書体の太字は、字を太らせて作ります</span>
                )}
              </div>

              <div className="row">
                <label className="sub">文字色</label>
                <input
                  type="color"
                  value={styles[editingStyle].color}
                  onChange={(e) => patchStyle(editingStyle, { color: e.target.value })}
                />
                <label className="sub">縁の色</label>
                <input
                  type="color"
                  value={styles[editingStyle].stroke?.color ?? '#000000'}
                  onChange={(e) =>
                    patchStyle(editingStyle, {
                      stroke: {
                        widthRatio: styles[editingStyle].stroke?.widthRatio ?? 0.16,
                        color: e.target.value,
                      },
                    })
                  }
                />
                <label className="sub">大きさ</label>
                <input
                  type="range"
                  min={0.04}
                  max={0.16}
                  step={0.005}
                  value={styles[editingStyle].fontSizeRatio}
                  onChange={(e) =>
                    patchStyle(editingStyle, { fontSizeRatio: Number(e.target.value) })
                  }
                />
                <button type="button" onClick={() => patchStyle(editingStyle, DEFAULT_STYLES[editingStyle])}>
                  既定に戻す
                </button>
              </div>
              <div className="row">
                <label className="sub">位置</label>
                {POSITION_ORDER.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={styles[editingStyle].position === p ? 'on' : ''}
                    onClick={() => patchStyle(editingStyle, { position: p })}
                  >
                    {POSITION_LABEL[p]}
                  </button>
                ))}
                <label className="sub">強調色</label>
                <input
                  type="color"
                  value={styles[editingStyle].highlightColor ?? '#ffe14d'}
                  onChange={(e) => patchStyle(editingStyle, { highlightColor: e.target.value })}
                />
              </div>

              {/*
                ── 次の動画からもこの見た目で始める ──
                毎回3つの雛形を設定し直すのは、テロップを直す作業そのものより長くなる。
                「自分のテロップはいつもこれ」は素材ではなく人に紐づく設定なので、
                作業フォルダではなくアプリ側に覚えさせる。
              */}
              {onSaveDefaults && (
                <div className="row defaults">
                  <label className="sub">次の動画から</label>
                  <button type="button" className="save" onClick={saveDefaults} disabled={saving}>
                    {saving ? '保存中…' : '今の見た目を既定にする'}
                  </button>
                  <button type="button" onClick={restoreFactory}>
                    最初の見た目に戻す
                  </button>
                  <span className="hint">
                    {savedNote || '3つの雛形をまとめて覚えます。今の動画の見た目は変わりません'}
                  </span>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>

      <footer>
        <kbd>↑</kbd>
        <kbd>↓</kbd> 移動 <kbd>Tab</kbd> 次の要確認 <kbd>E</kbd> 文言を直す
        <span className="sep" />
        <kbd>Space</kbd> 一時停止 <kbd>R</kbd> 頭から再生
        <span className="sep" />
        <kbd>1</kbd> 通常 <kbd>2</kbd> 補足 <kbd>3</kbd> 強調 <kbd>P</kbd> 位置 <kbd>Del</kbd> 削除{' '}
        <kbd>Ctrl</kbd>+<kbd>Z</kbd> 取消
        <span className="sep" />
        プレビューをドラッグで位置調整 / 「改行位置」の <kbd>·</kbd> で改行する場所を決められます
        <span className="sep" />
        直さなかったものはそのまま焼き込まれます
      </footer>
    </div>
  );
}
