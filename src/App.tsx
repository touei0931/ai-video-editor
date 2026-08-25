/**
 * アプリ本体の流れ。
 *
 *   動画を選ぶ → 解析（音声抽出→文字起こし→カット候補検出）
 *     → ①カットのレビュー（Y/N で承認・却下）
 *     → ②テロップの確認（文言・スタイルを直す）
 *     → 書き出し（カットを適用し、テロップを焼き込む）
 *
 * 🔴 テロップはカットの**あと**に作る。
 *    先に作ると、切った箇所の言葉がテロップに残る（sidecar/telop.py 参照）。
 *
 * ③ズーム・画角は Phase 3。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DraftEntry } from './global';
import { type Shot } from './preview/PreviewScreen';
import { FinalStage } from './shell/FinalStage';
import { ShortcutHelp } from './ShortcutHelp';
import { type PacePreset, type ReviewState } from './review/ReviewScreen';
import { CutStage } from './shell/CutStage';
import type { CutCandidate, CutKind, ReviewBand } from './review/mockCandidates';
import { type ExportOptions, type StyleMap, type TelopEdits } from './telop/TelopScreen';
import { TelopStage, type MusicTrack } from './shell/TelopStage';

/** 書き出しの既定。TelopScreen の既定と揃えること */
const DEFAULT_EXPORT_OPTIONS: ExportOptions = { burn: true, srt: true, fcpxml: false };
import { loadTelopFonts, macFontOf } from './telop/fonts';
import { fcpLook, type FcpLook } from './telop/render';
import { renderBlank, renderTelopPngs } from './telop/rasterize';
import {
  buildCards,
  makeMeasure,
  resolveOverlaps,
  rewrapCard,
  type Frame,
  type TelopCard,
  type TelopUnit,
} from './telop/split';
import {
  DEFAULT_STYLES,
  resolveStyle,
  sanitizeLibrary,
  sanitizeStyles,
  type StyleLibrary,
  type TelopStyleName,
} from './telop/style';

type Phase =
  | 'idle'
  | 'analyzing'
  | 'no-speech'
  | 'review'
  | 'telops-building'
  | 'telop'
  | 'framing'
  | 'fullpreview'
  | 'exporting'
  | 'done';

interface AnalyzeResult {
  video_path: string;
  duration: number;
  candidate_count: number;
  kinds: Record<string, number>;
  transcript_path: string;
  wav_path: string;
  work_dir: string;
  video: { width: number; height: number; fps: number; duration: number };
  speech: {
    kept: number;
    dropped: number;
    reasons: Record<string, number>;
    speech_seconds: number;
    speech_ratio: number;
  };
  transcript: { text: string; realtime_factor: number; elapsed_seconds: number; model: string };
  candidates: {
    id: string;
    kind: CutKind;
    src_start: number;
    src_end: number;
    confidence: number;
    before?: string;
    after?: string;
    word?: string;
    clip_path?: string | null;
    clip_join_at?: number;
    clip_duration?: number;
  }[];
  review_band?: ReviewBand;
}

interface TelopResult {
  telops: {
    id: string;
    src_start: number;
    src_end: number;
    text: string;
    style: TelopStyleName;
    reason: string;
    highlight: string | null;
    needs_check: boolean;
    confidence: number;
    low_words: number;
    words: { text: string; src_start: number; src_end: number }[];
  }[];
}

interface ExportResult {
  out_path: string;
  encoder: string;
  kept_seconds: number;
  original_seconds: number;
  cut_count: number;
  telop_count: number;
  srt_path: string | null;
  fcpxml_path: string | null;
  /** Final Cut 用のタイムラインの隣に置いた書体のフォルダ */
  font_dir?: string | null;
  encoder_fallback: boolean;
  segments: number;
  size_mb: number;
}

function toCandidate(c: AnalyzeResult['candidates'][number]): CutCandidate {
  return {
    id: c.id,
    kind: c.kind,
    srcStart: c.src_start,
    srcEnd: c.src_end,
    confidence: c.confidence,
    before: c.before ?? '',
    after: c.after ?? '',
    word: c.word,
    clipPath: c.clip_path ?? null,
    clipJoinAt: c.clip_join_at,
    clipDuration: c.clip_duration,
  };
}

function toUnit(t: TelopResult['telops'][number]): TelopUnit {
  return {
    id: t.id,
    srcStart: t.src_start,
    srcEnd: t.src_end,
    text: t.text,
    style: t.style,
    reason: t.reason,
    highlight: t.highlight,
    needsCheck: t.needs_check,
    confidence: t.confidence,
    lowWords: t.low_words ?? 0,
    words: t.words.map((w) => ({ text: w.text, srcStart: w.src_start, srcEnd: w.src_end })),
  };
}

/**
 * 下書き。作業フォルダの project.json に入る。
 *
 * 🔴 解析結果ごと保存する。
 *    判定だけ保存しても、開き直したときに解析からやり直しになる。
 *    20分素材の解析は数十秒〜数分かかるので、それでは「続きから」にならない。
 */
interface Draft {
  video_path: string;
  savedAt: string;
  phase: Phase;
  analysis: AnalyzeResult;
  review?: ReviewState;
  cuts?: { srcStart: number; srcEnd: number }[];
  cards?: TelopCard[];
  styles?: StyleMap;
  options?: ExportOptions;
  /** テロップ画面で消したもの。作り直したときに復活させないために持つ */
  removed?: TelopCard[];
  /** 間の詰め具合 */
  pace?: PacePreset;
  shots?: Shot[];
}

/** SRT の1エントリ内の改行 */
const NEWLINE = '\n';

/** 同じテロップとみなす時刻のずれ */
const SAME_TELOP_SECONDS = 0.4;

/** カットの集合を1つの文字列にする。作り直しが要るかの判定に使う。 */
function cutsKey(list: { srcStart: number; srcEnd: number }[]): string {
  return list
    .map((c) => `${c.srcStart.toFixed(3)}-${c.srcEnd.toFixed(3)}`)
    .sort()
    .join(',');
}

/**
 * 作り直したテロップに、前回手で直した内容を引き継ぐ。
 *
 * カットを変えるとテロップは作り直さざるを得ない（切った箇所の言葉が消えるため）。
 * だからといって直した内容を全部捨てると、カットを1箇所直すたびに
 * テロップの校正がやり直しになる。
 *
 * 🔴 引き継ぐのは**中身が変わっていないもの**だけ。
 *    文言が変わったテロップに古い直しを載せると、
 *    切ったはずの言葉がテロップにだけ残る。それは直したことにならない。
 *
 * 対応付けは開始時刻。テロップの時刻は元素材の時刻なので、
 * カットを変えても、その箇所に掛かっていない限り動かない。
 */
function mergeEdits(fresh: TelopCard[], previous: TelopCard[], removed: TelopCard[]): TelopCard[] {
  if (previous.length === 0 && removed.length === 0) return fresh;

  /**
   * 作られ方が同じものを1つ選ぶ。
   * 🔴 照合は baseText / baseStart（作られた時点の値）で行う。
   *    直したあとの文言で照合すると、直したものほど見つからなくなる。
   * 同じ文言が繰り返される素材があるので、一度使ったものは再利用しない。
   */
  const match = (list: TelopCard[], used: Set<number>, card: TelopCard): TelopCard | null => {
    let best = -1;
    let bestDist = Infinity;
    list.forEach((p, i) => {
      if (used.has(i)) return;
      if ((p.baseText ?? p.text) !== card.text) return;
      const dist = Math.abs((p.baseStart ?? p.srcStart) - card.srcStart);
      if (dist <= SAME_TELOP_SECONDS && dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    if (best < 0) return null;
    used.add(best);
    return list[best];
  };

  const usedPrev = new Set<number>();
  const usedRemoved = new Set<number>();

  const carried = fresh
    // 前回消したものは復活させない
    .filter((c) => !match(removed, usedRemoved, c))
    .map((c) => {
      const prev = match(previous, usedPrev, c);
      if (!prev?.edited) return c;
      // 手を入れた内容だけを載せる。確信度や単語の対応は新しいほうが正しい
      return {
        ...c,
        text: prev.text,
        lines: prev.lines,
        style: prev.style,
        fontScale: prev.fontScale,
        positionOverride: prev.positionOverride,
        offsetX: prev.offsetX,
        offsetY: prev.offsetY,
        override: prev.override,
        highlight: prev.highlight,
        // 手で決めた改行位置も引き継ぐ。文言が同じなら位置の意味も変わらない
        breaks: prev.breaks,
        srcStart: prev.srcStart,
        srcEnd: prev.srcEnd,
        needsCheck: false,
        edited: true,
      };
    });

  // 手で足したテロップは作り直しても出てこない。必ず持ち越す。
  const manual = previous.filter((p) => p.manual);
  // 🔴 引き継いだ時刻と新しい時刻が混ざるので、重なりはここで解消しておく。
  //    重なったまま渡すと、書き出しで後ろのテロップが軒並みずれる。
  return resolveOverlaps([...carried, ...manual]);
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}分${String(s).padStart(2, '0')}秒`;
}

/** 「5分前」「昨日 14:32」のように、いつの作業か分かる形にする */
function formatSavedAt(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '不明';
  const minutes = Math.floor((Date.now() - then.getTime()) / 60000);
  if (minutes < 1) return 'さっき';
  if (minutes < 60) return `${minutes}分前`;
  const time = then.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  const days = Math.floor(minutes / 60 / 24);
  if (days === 0) return `今日 ${time}`;
  if (days === 1) return `昨日 ${time}`;
  return `${then.toLocaleDateString('ja-JP')} ${time}`;
}

const PHASE_LABEL: Partial<Record<Phase, string>> = {
  review: 'カットの確認中',
  telop: 'テロップの確認中',
  framing: 'テロップの確認中',
  fullpreview: '通し確認中',
  exporting: '書き出し前',
  done: '書き出し済み',
};

export function App() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState({ value: 0, message: '' });
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
  const [cuts, setCuts] = useState<CutCandidate[]>([]);
  const [cards, setCards] = useState<TelopCard[]>([]);
  /**
   * テロップ画面で直した内容。通し確認・書き出しで使うほか、
   * カット画面へ行って戻ってきたときの復元にも使う。
   */
  const [finalState, setFinalState] = useState<TelopEdits | null>(null);
  /** 前回の続き。解析後に作業フォルダから読み込む */
  const [savedReview, setSavedReview] = useState<ReviewState | null>(null);
  /**
   * 名前を付けて覚えさせたテロップの見た目の一覧。
   * 新しい動画は「今使う組」から始まる。無ければアプリ最初の見た目。
   */
  const [library, setLibrary] = useState<StyleLibrary>({ presets: [], current: null });
  /** 実際に読み込めた書体。選択肢をこれに絞る */
  const [fontFamilies, setFontFamilies] = useState<string[] | undefined>(undefined);
  const [resumed, setResumed] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  /** ③ズーム・画角の自動化。人物アップに寄るショット */
  const [shots, setShots] = useState<Shot[]>([]);
  /** 寄らなかった理由。「なぜアップにならないのか」が分からないと不具合に見える */
  const [skippedShots, setSkippedShots] = useState<Record<string, number>>({});
  const [exported, setExported] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  /** 待ち画面の「経過」「残り」を1秒ごとに動かすための現在時刻 */
  const [now, setNow] = useState(() => Date.now());
  /** 保存済みの下書き。最初の画面から直接開けるようにするために持つ */
  const [drafts, setDrafts] = useState<DraftEntry[]>([]);
  /**
   * 前回テロップを作ったときのカット。
   * これと同じなら作り直す必要がない（作り直すと手で直した内容が消える）。
   */
  const builtForRef = useRef<string | null>(null);

  /**
   * preload が読み込まれていないと window.app が無い。
   * 素のブラウザで開いた場合や、配布時に preload のパスがずれた場合に起きる。
   * 何も出ない白画面が一番デバッグしづらいので、必ず理由を表示する。
   */
  const hasBridge = typeof window !== 'undefined' && typeof window.app !== 'undefined';

  useEffect(() => {
    if (!hasBridge) return;
    return window.app.onProgress(setProgress);
  }, [hasBridge]);

  /** 待っている間だけ時計を動かす。終わったら止める。 */
  useEffect(() => {
    const running =
      phase === 'analyzing' ||
      phase === 'exporting' ||
      phase === 'telops-building' ||
      phase === 'framing';
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F1') {
        setShowShortcuts((v) => !v);
        e.preventDefault();
      } else if (e.key === 'Escape' && showShortcuts) {
        setShowShortcuts(false);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showShortcuts]);

  /** 今の段階をメニューへ伝える。項目の有効/無効がこれで決まる */
  useEffect(() => {
    if (!hasBridge) return;
    window.app.setContext({
      phase,
      workDir: analysis?.work_dir ?? null,
      outPath: exported?.out_path ?? null,
    });
  }, [hasBridge, phase, analysis, exported]);

  /**
   * 本人が「既定にする」で覚えさせたテロップの見た目。
   *
   * 🔴 起動時に一度だけ読む。読めなければアプリ最初の見た目で始める。
   *    設定ファイルが壊れていても編集そのものは続けられるべきなので、
   *    ここで例外を投げないこと（sanitizeStyles が形を保証する）。
   */
  useEffect(() => {
    if (!hasBridge) return;
    let alive = true;
    void (async () => {
      // 読み込めた書体だけを既定として認める。手で書き換えられている可能性もある
      const fonts = await loadTelopFonts().catch(() => ({ families: [], missing: [] }));
      const raw = await window.app.loadTelopStyles().catch(() => null);
      if (!alive) return;
      setFontFamilies(fonts.families);
      if (fonts.missing.length > 0) {
        console.error('読み込めなかったフォント:', fonts.missing);
      }
      if (raw) setLibrary(sanitizeLibrary(raw, fonts.families));
    })();
    return () => {
      alive = false;
    };
  }, [hasBridge]);

  const saveLibrary = useCallback(async (next: StyleLibrary) => {
    const ok = await window.app.saveTelopStyles(next);
    // 覚えた内容は、この場でも次の動画の出発点として持っておく
    if (ok) setLibrary(structuredClone(next));
    return ok;
  }, []);

  /** 新しい動画を始めるときの見た目。保存した組が無ければアプリ最初の見た目 */
  const defaultStyles = useMemo(
    () =>
      library.presets.find((p) => p.name === library.current)?.styles ??
      structuredClone(DEFAULT_STYLES),
    [library],
  );

  /**
   * いま使っている雛形。
   * 下書きに残っていればそれ、無ければ本人が既定として保存した見た目から始める。
   */
  const [telopStyles, setTelopStyles] = useState<StyleMap | null>(null);
  /**
   * BGM。テロップ画面で足し、書き出しに渡す。
   * 🔴 書き出しの引数に必ず載せること。画面で足しただけで出力に乗らないと、
   *    「付けたのに入っていない」という一番たちの悪い壊れ方をする。
   */
  const [music, setMusic] = useState<MusicTrack | null>(null);
  const styles = telopStyles ?? finalState?.styles ?? defaultStyles;

  const measure = useMemo(() => (hasBridge ? makeMeasure() : null), [hasBridge]);
  const frame: Frame = useMemo(
    () => ({
      width: analysis?.video.width || 1920,
      height: analysis?.video.height || 1080,
    }),
    [analysis],
  );

  /**
   * 解析を途中でやめる。
   * 間違ったファイルを選んだときに十数分待たされるのは、実用上ありえない。
   */
  /**
   * 待っている処理をやめる。
   *
   * 🔴 解析だけでなく書き出しにも要る。間違ったファイルで書き出しを始めたら、
   *    十数分待つか強制終了するしかなかった。
   * 🔴 中断したあとの行き先は工程によって違う。解析中なら動画の選択、
   *    それ以降は直前の画面。ここで idle に落とすと編集内容が消える。
   */
  const cancelAnalyze = useCallback(async () => {
    await window.app.cancel();
    setError(null);
    setPhase((p) => {
      if (p === 'analyzing') return 'idle';
      if (p === 'exporting') return finalState ? 'fullpreview' : 'telop';
      if (p === 'telops-building') return 'review';
      if (p === 'framing') return 'telop';
      return p;
    });
  }, [finalState]);

  /**
   * 下書きから続きを再開する。
   * 🔴 解析はやり直さない。解析結果ごと保存してあるので読むだけで済む。
   */
  const resumeDraft = useCallback((draft: Draft): boolean => {
    if (!draft?.analysis) return false;
    setAnalysis(draft.analysis);
    setSavedReview(draft.review ?? null);
    setShots(draft.shots ?? []);
    // 🔴 重なりはここでも直す。この直しより前に保存された下書きには、
    //    重なったままのテロップが入っている（そのまま書き出すと後半がずれる）。
    const saved = resolveOverlaps(draft.cards ?? []);
    setCards(saved);
    setPace(draft.pace ?? 'talk');
    setCuts(
      (draft.cuts ?? []).map((c) => ({
        id: '',
        kind: 'silence' as CutKind,
        srcStart: c.srcStart,
        srcEnd: c.srcEnd,
        confidence: 1,
        before: '',
        after: '',
      })),
    );
    reviewStateRef.current = draft.review ?? null;

    // テロップ画面で直した内容も戻す。
    // 🔴 これが無いと、下書きから再開しただけで文言もスタイルもやり直しになる。
    if (draft.cards?.length) {
      setFinalState({
        cards: saved,
        /*
          🔴 保存してある雛形は、必ず sanitizeStyles を通す。
             書体に「太字かどうか」を足す前の下書きには bold が入っていないので、
             そのまま使うと**開き直しただけで細い書体に変わる**。
             sanitizeStyles は分かる項目だけ受け取り、残りを既定で埋めるので、
             古い下書きも今までどおりの見た目で開く。
        */
        styles: draft.styles ? sanitizeStyles(draft.styles, fontFamilies) : defaultStyles,
        options: draft.options ?? { burn: true, srt: true, fcpxml: false },
        removed: draft.removed ?? [],
      });
      // 同じカットで作ったテロップが残っているので、作り直さない
      builtForRef.current = cutsKey(draft.cuts ?? []);
    } else {
      setFinalState(null);
      builtForRef.current = null;
    }

    setResumed(true);
    // テロップ以降まで進んでいても、カットの確認からやり直せたほうが安全。
    // 判定は残っているので、そのまま Enter で先へ進める。
    setPhase('review');
    return true;
  }, [defaultStyles, fontFamilies]);

  /** 下書きの一覧を読み直す。最初の画面に出す */
  const refreshDrafts = useCallback(async () => {
    if (!hasBridge) return;
    try {
      setDrafts(await window.app.listDrafts());
    } catch (e) {
      console.error('下書きの一覧を読めませんでした:', e);
    }
  }, [hasBridge]);

  useEffect(() => {
    if (phase === 'idle') void refreshDrafts();
  }, [phase, refreshDrafts]);

  /** 一覧から下書きを開く */
  const openDraft = useCallback(
    async (entry: DraftEntry) => {
      setError(null);
      const saved = (await window.app.loadProject(entry.workDir)) as Draft | null;
      if (!saved?.analysis) {
        setError('下書きを読み込めませんでした。ファイルが壊れているようです。');
        void refreshDrafts();
        return;
      }
      if (!resumeDraft(saved)) {
        setError('下書きの中身が古い形式のため開けませんでした。');
      }
    },
    [resumeDraft, refreshDrafts],
  );

  const deleteDraft = useCallback(
    async (entry: DraftEntry) => {
      await window.app.deleteDraft(entry.workDir);
      void refreshDrafts();
    },
    [refreshDrafts],
  );

  const pickAndAnalyze = useCallback(async () => {
    setError(null);
    const path = await window.app.pickVideo();
    if (!path) return;

    // 先に下書きを探す。あれば解析せずに続きから始められる。
    // 🔴 作業フォルダの場所は推測しない。素材ごとに違ううえ、
    //    推測がずれると「下書きがあるのに無いことになる」という気づけない壊れ方をする。
    const found = await window.app.findDraft(path);
    if (found) {
      const useIt = await window.app.confirmResume({
        savedAt: found.savedAt,
        decided: found.decided,
      });
      if (useIt === 'cancel') return;
      if (useIt === 'resume') {
        await openDraft(found);
        return;
      }
    } else {
      // 作業フォルダを素材ごとに分ける前に保存した下書き。
      // 索引にも載っていないので、動画を選んだときだけ拾う。
      // 一度開けば以降は索引に載り、一覧から辿れるようになる。
      const legacyDir = path.replace(/[/\\][^/\\]+$/, '') + '/.ai-video-editor';
      const legacy = (await window.app.loadProject(legacyDir)) as Draft | null;
      if (legacy?.analysis && legacy.video_path === path) {
        const useIt = await window.app.confirmResume({
          savedAt: legacy.savedAt,
          decided: Object.keys(legacy.review?.decisions ?? {}).length,
        });
        if (useIt === 'cancel') return;
        if (useIt === 'resume' && resumeDraft(legacy)) return;
      }
    }

    setPhase('analyzing');
    setProgress({ value: 0, message: '準備しています' });
    setStartedAt(Date.now());

    try {
      // モデルは sidecar 側の既定（large-v3-turbo）に任せる。
      // 精度は文字起こし・カット・テロップのすべてに効くので、ここをケチらない。
      const result = (await window.app.analyze({ video_path: path })) as AnalyzeResult;
      // 中断された場合は結果が来ない
      if (!result || (result as unknown as { cancelled?: boolean }).cancelled) {
        setPhase('idle');
        return;
      }
      setAnalysis(result);

      setSavedReview(null);
      setResumed(false);

      // 使える発話がひとつも無い素材。ここで止めないと、
      // 素材全体が無音扱いになって「全部カット」という壊れた結果になる。
      setPhase(result.speech.kept === 0 ? 'no-speech' : 'review');
    } catch (e) {
      setError((e as Error).message);
      setPhase('idle');
    }
  }, [openDraft, resumeDraft]);


  /**
   * 自動で判定した箇所のプレビューを、必要になった時点で作る。
   *
   * 解析時に作るのは人間が1件ずつ見る候補ぶんだけ（sidecar/heavy.py 参照）。
   * 全部作ると候補118件ぶんのクリップを作ることになり、解析が何倍にも延びる。
   * 「自動で切った箇所を見せろ」と言われた時にだけ、その1本を作る（実測 0.24 秒）。
   */
  const requestClip = useCallback(
    async (c: CutCandidate) => {
      if (!analysis) return null;
      const res = await window.app.makeClip({
        video_path: analysis.video_path,
        out_path: `${analysis.work_dir}/clips/${c.id}.mp4`,
        src_start: c.srcStart,
        src_end: c.srcEnd,
      });
      return res ? { path: res.path, joinAt: res.join_at, duration: res.duration } : null;
    },
    [analysis],
  );

  /**
   * 間の詰め具合を変えて、カット候補を作り直す。
   *
   * 🔴 文字起こしはやり直さない。transcript.json があれば候補は数百ミリ秒で組み直せる。
   *    以前は解析ごとやり直すしかなく、20分素材なら12〜18分かかっていた。
   *
   * 🔴 判定はすべて捨てる。候補の id も区間も変わるので、
   *    前の判定を引き継ぐと「別の場所に別の判断が付く」ことになる。
   *    そのことは押す前に伝える。
   */
  const [pace, setPace] = useState<PacePreset>('talk');
  const [repacing, setRepacing] = useState(false);

  const changePace = useCallback(
    async (next: PacePreset) => {
      if (!analysis || next === pace) return;
      const decided = Object.keys(reviewStateRef.current?.decisions ?? {}).length;
      if (decided > 0) {
        const ok = window.confirm(
          `間の詰め具合を変えると、カット候補を作り直します。\n` +
            `これまでの判定 ${decided} 件は失われます。よろしいですか？`,
        );
        if (!ok) return;
      }

      setRepacing(true);
      setError(null);
      try {
        const result = (await window.app.redetect({
          transcript_path: analysis.transcript_path,
          video_path: analysis.video_path,
          work_dir: analysis.work_dir,
          options: { preset: next },
        })) as Pick<AnalyzeResult, 'candidates' | 'candidate_count' | 'kinds' | 'review_band'>;

        setAnalysis((prev) => (prev ? { ...prev, ...result } : prev));
        setPace(next);

        /*
          🔴 手で足したカットは残す。
             AIの候補ではなく、人が「ここは要らない」と決めた時間の範囲なので、
             候補の作り直しとは無関係。消すと、脱線を落とす作業をやり直させることになる。
        */
        const keptManual = reviewStateRef.current?.manualCuts ?? [];
        const fresh: ReviewState = {
          decisions: {},
          adjust: {},
          excludedFillers: [],
          index: 0,
          resumeIndex: 0,
          history: [],
          autoOverride: {},
          manualCuts: keptManual,
        };
        setSavedReview(fresh);
        reviewStateRef.current = fresh;
        builtForRef.current = null;
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setRepacing(false);
      }
    },
    [analysis, pace],
  );

  /** カットのレビューが終わったら、その結果を踏まえてテロップを作る */
  const buildTelops = useCallback(
    async (approved: CutCandidate[]) => {
      if (!analysis || !measure) return;
      setCuts(approved);

      /*
        🔴 カットが変わっていなければ作り直さない。

        以前は戻ってくるたびに作り直していたため、
        テロップを何十枚も直したあとに一度カット画面へ戻るだけで全部消えた。
        直した内容が消えるなら「戻れる」とは言えない。
        作り直さなければ、待ち時間も無くなる。
      */
      const key = cutsKey(approved);
      if (key === builtForRef.current && cards.length > 0) {
        setPhase('telop');
        return;
      }

      setPhase('telops-building');
      setStartedAt(Date.now());
      setProgress({ value: 0, message: 'テロップを作っています' });

      try {
        // フォントが載る前に幅を測ると、フォールバックフォントの幅で折り返してしまう
        await loadTelopFonts();

        const result = (await window.app.buildTelops({
          transcript_path: analysis.transcript_path,
          wav_path: analysis.wav_path,
          out_path: `${analysis.work_dir}/telops.json`,
          cuts: approved.map((c) => ({ src_start: c.srcStart, src_end: c.srcEnd })),
        })) as TelopResult;

        /*
          🔴 今の雛形を渡すこと。
             既定を保存できるようにした以上、書体も大きさも人によって違う。
             渡さないとアプリ最初の書体で幅を測ることになり、
             テロップが**作られた時点で画面からはみ出す**。
        */
        const styles = finalState?.styles ?? defaultStyles;
        const fresh = buildCards(result.telops.map(toUnit), measure, frame, { styles });
        setCards(mergeEdits(fresh, cards, finalState?.removed ?? []));
        builtForRef.current = key;
        setPhase('telop');
      } catch (e) {
        setError((e as Error).message);
        setPhase('review');
      }
    },
    [analysis, measure, frame, cards, finalState, defaultStyles],
  );

  /**
   * 判定を作業フォルダに書く。
   * 押すたびに書くと I/O が多すぎるので、少し待ってからまとめて書く。
   */
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 最後に受け取ったレビューの判定。下書きに含める */
  const reviewStateRef = useRef<ReviewState | null>(null);

  /*
    自動保存が書き出す内容の置き場所。

    🔴 保存する値は ref から読むこと。

    自動保存は「最後の変更から 0.8 秒後」に走る。そのとき参照する値が
    **タイマーを仕掛けた時点の値**だと、下書きは常に1操作ぶん遅れる。
    最後の変更のあとは新しいタイマーが立たないので、
    **その1操作は永久に書かれない**。

    実際にそうなっていた:
      テロップを1枚消して取り消す（画面上は14枚に戻る）→ 0.8秒後に保存が走る
      → 書かれたのは**消したあとの13枚**。開き直すと1枚足りない。
    ここで ref を挟むことで、いつ走っても「今の値」を書くようになる。
  */
  const latest = useRef({ analysis, phase, cuts, cards, finalState, shots, pace });
  latest.current = { analysis, phase, cuts, cards, finalState, shots, pace };

  const saveDraft = useCallback(async () => {
    const now = latest.current;
    if (!now.analysis) return;
    const draft: Draft = {
      video_path: now.analysis.video_path,
      savedAt: new Date().toISOString(),
      phase: now.phase,
      analysis: now.analysis,
      review: reviewStateRef.current ?? undefined,
      cuts: now.cuts.map((c) => ({ srcStart: c.srcStart, srcEnd: c.srcEnd })),
      cards: now.finalState?.cards ?? (now.cards.length ? now.cards : undefined),
      styles: now.finalState?.styles,
      options: now.finalState?.options,
      removed: now.finalState?.removed,
      pace: now.pace,
      shots: now.shots,
    };
    await window.app.saveProject({
      workDir: now.analysis.work_dir,
      data: draft,
      // 一覧に出すぶんだけ別に渡す。本体を読まずに一覧を作れるようにする
      // （20分素材の下書きは数MBあり、一覧のたびに全部読むと重い）
      summary: {
        videoPath: now.analysis.video_path,
        savedAt: draft.savedAt,
        phase: now.phase,
        decided: Object.keys(reviewStateRef.current?.decisions ?? {}).length,
        total: now.analysis.candidates.length,
        duration: now.analysis.duration,
      },
    });
  }, []);

  /**
   * 少し待ってからまとめて書く。押すたびに書くと I/O が多すぎる。
   * 🔴 やめるときは必ず打ち切ること（quitEditing 参照）。
   */
  const scheduleSave = useCallback(() => {
    if (!latest.current.analysis) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveDraft(), 800);
  }, [saveDraft]);

  /** テロップ画面で直した内容を受け取る。カット画面の onStateChange と同じ形 */
  const saveTelopEdits = useCallback(
    (edits: TelopEdits) => {
      setFinalState(edits);
      setCards(edits.cards);
      scheduleSave();
    },
    [scheduleSave],
  );

  const saveReview = useCallback(
    (state: ReviewState) => {
      reviewStateRef.current = state;
      /*
        🔴 画面に渡す初期状態も更新する。

        カット画面はテロップへ進むと閉じられる。戻ってくると作り直しになるので、
        ここを更新しておかないと**開いた時点の状態**で作り直され、
        その間に下した判定・自動判定の直しが全部消える。
        （テロップ画面が同じ理由で消えていたのと同じ話）
      */
      setSavedReview(state);
      scheduleSave();
    },
    [scheduleSave],
  );

  /**
   * 編集中の状態をすべて捨てて、最初の画面に戻す。
   *
   * 🔴 消す対象を呼び出し側で列挙しないこと。
   *    以前は「編集をやめる」と「別の動画を編集する」で別々に列挙しており、
   *    後者が finalState / shots / builtForRef / reviewStateRef を消し忘れていた。
   *    結果、2本目の下書きに**1本目のテロップが書き込まれる**。
   *    状態を足すたびに片方だけ直る形は、必ずまた起きる。
   */
  const resetEditing = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    setAnalysis(null);
    setCards([]);
    setCuts([]);
    setShots([]);
    setSkippedShots({});
    setFinalState(null);
    setSavedReview(null);
    setResumed(false);
    setExported(null);
    setError(null);
    setStartedAt(0);
    reviewStateRef.current = null;
    builtForRef.current = null;
    setPhase('idle');
  }, []);

  /**
   * 編集をやめて動画の選択に戻る。
   * 一度入ると書き出すまで抜けられないのは、間違ったファイルを選んだときに詰む。
   */
  const quitEditing = useCallback(async () => {
    // 🔴 先に自動保存を打ち切る。
    //    ここで止めないと、確認ダイアログを出している 800ms の間にタイマーが発火し、
    //    「保存せずにやめる」を選んだのに下書きが残る——選択と逆のことが起きる。
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }

    const hasWork =
      Object.keys(reviewStateRef.current?.decisions ?? {}).length > 0 ||
      cards.length > 0 ||
      cuts.length > 0;
    const answer = await window.app.confirmQuit({ hasWork });
    if (answer === 'cancel') return;
    if (answer === 'save') await saveDraft();

    resetEditing();
  }, [cards.length, cuts.length, saveDraft, resetEditing]);

  /**
   * メニューからの指示を受ける。
   *
   * 🔴 キー操作に対応する項目は、**そのキーを押したことにする**だけにする。
   *    メニュー用に処理をもう一本書くと、片方だけ直して食い違う。
   */
  useEffect(() => {
    if (!hasBridge) return;
    return window.app.onMenu((action) => {
      if (action.startsWith('key:')) {
        const spec = action.slice(4);
        const shift = spec.startsWith('Shift+');
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: shift ? spec.slice(6) : spec,
            shiftKey: shift,
            bubbles: true,
          }),
        );
        return;
      }
      if (action === 'undo') {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
        return;
      }
      if (action === 'shortcuts') setShowShortcuts(true);
      if (action === 'quit') void quitEditing();
      if (action === 'open') void pickAndAnalyze();
      if (action === 'drafts') void refreshDrafts();
      if (action === 'cancel') void cancelAnalyze();
      if (action === 'addTelop') {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true, bubbles: true }));
      }
      if (action === 'save') void saveDraft();
      if (action === 'fullpreview' || action === 'export') {
        // 画面側のボタンと同じ処理を呼びたいので、専用のイベントで知らせる
        window.dispatchEvent(new CustomEvent('app:menu-action', { detail: action }));
      }
    });
  }, [hasBridge, pickAndAnalyze, cancelAnalyze, quitEditing, refreshDrafts, saveDraft]);

  /**
   * 折り返しを計算し直す。
   * 🔴 今の雛形を渡すこと。渡さないと、雛形の文字サイズを変えたときに
   *    折り返しだけ古い基準のままになり、テロップが画面外へはみ出す。
   */
  const rewrap = useCallback(
    (
      text: string,
      style: TelopStyleName,
      styles?: StyleMap,
      card?: { sizeScale?: number; breaks?: number[]; highlight?: string | null },
    ) =>
      measure
        ? rewrapCard(text, style, measure, frame, {}, styles, card)
        : { lines: [text], fontScale: 1 },
    [measure, frame],
  );

  /**
   * テロップ確認のあとは、いきなり書き出さず通しで見せる。
   * その前に③ズーム・画角の自動化（引きと人物アップの切り替え）を計画する。
   *
   * 🔴 テロップが決まってから計画すること。
   *    どこを強調するかはテロップ側で決まっているので、そのまま寄る理由に使える。
   *    テロップの位置も渡す。渡さないと寄ったときに顔がテロップに突っ込む。
   */
  const goFullPreview = useCallback(
    async (finalCards: TelopCard[], styles: StyleMap, options: ExportOptions) => {
      if (!analysis) return;
      // 消したテロップの記録は持ち越す。ここでは渡されない
      setFinalState((prev) => ({
        cards: finalCards,
        styles,
        options,
        removed: prev?.removed ?? [],
      }));
      setCards(finalCards);
      setPhase('framing');
      setStartedAt(Date.now());
      setProgress({ value: 0, message: '画角を決めています' });

      try {
        const result = (await window.app.planFraming({
          video_path: analysis.video_path,
          duration: analysis.duration,
          telop_position: styles.normal.position,
          telops: finalCards.map((c) => ({
            src_start: c.srcStart,
            src_end: c.srcEnd,
            style: c.style,
            highlight: c.highlight ?? null,
          })),
        })) as { shots: Shot[]; skipped?: Record<string, number> };
        setShots(result.shots ?? []);
        setSkippedShots(result.skipped ?? {});
      } catch (e) {
        // 画角が決まらなくても通し確認と書き出しはできる。止める理由がない。
        console.error('画角の計画に失敗しました:', e);
        setShots([]);
        setSkippedShots({});
      }
      setPhase('fullpreview');
    },
    [analysis],
  );

  const runExport = useCallback(
    async (finalCards: TelopCard[], styles: StyleMap, options: ExportOptions) => {
      if (!analysis) return;
      const base = analysis.video_path.replace(/\.[^.]+$/, '');
      const target = await window.app.pickOutput(`${base}_edited.mp4`);
      if (!target) return;

      setError(null);
      setPhase('exporting');
      setStartedAt(Date.now());
      setProgress({ value: 0, message: 'テロップを描いています' });

      // 有効な寄りだけを区間列にする。隙間は引き。
      const enabled = shots.filter((s) => s.enabled);
      const framingSegments: { src_start: number; src_end: number; rect: Shot['rect'] }[] = [];
      let cursor = 0;
      for (const sh of enabled) {
        if (sh.src_start - cursor > 0.02) {
          framingSegments.push({
            src_start: cursor,
            src_end: sh.src_start,
            rect: { x: 0, y: 0, w: 1, h: 1 },
          });
        }
        framingSegments.push({ src_start: sh.src_start, src_end: sh.src_end, rect: sh.rect });
        cursor = sh.src_end;
      }
      if (analysis.duration - cursor > 0.02) {
        framingSegments.push({
          src_start: cursor,
          src_end: analysis.duration,
          rect: { x: 0, y: 0, w: 1, h: 1 },
        });
      }

      try {
        let telops: {
          src_start: number;
          src_end: number;
          text: string;
          png: string;
          look?: FcpLook;
        }[] = [];
        let blankPng = '';

        /*
          Final Cut Pro へ渡すときの見た目。
          🔴 書体は macOS の書体名で書くこと。ctx.font 用の名前をそのまま書くと、
             Final Cut はその書体を知らないので**警告も出さずに別の書体で開く**。
        */
        const lookOf = (c: TelopCard) => {
          const resolved = resolveStyle(styles, c.style, c.override, c.fontScale);
          return fcpLook(
            resolved,
            c.positionOverride ?? resolved.position,
            frame,
            macFontOf(resolved.fontFamily, resolved.bold),
            c.offsetX,
            c.offsetY,
          );
        };

        if (finalCards.length > 0 && options.burn) {
          const dir = `${analysis.work_dir}/telops`;
          const rendered = await renderTelopPngs(finalCards, frame, styles, (done, total) =>
            setProgress({ value: done / total, message: `テロップを描いています ${done}/${total}` }),
          );

          const saved = await window.app.saveTelopFrames({
            dir,
            frames: [
              ...rendered.map((r) => ({ name: r.name, base64: r.base64 })),
              { name: '_blank.png', base64: renderBlank(frame) },
            ],
          });

          blankPng = saved['_blank.png'];
          telops = finalCards.map((c, i) => ({
            src_start: c.srcStart,
            src_end: c.srcEnd,
            text: c.lines.join(NEWLINE),
            png: saved[rendered[i].name],
            look: lookOf(c),
          }));
        } else if (finalCards.length > 0) {
          // 焼き込まない場合でも、字幕ファイルを出すために時刻と文言は渡す
          telops = finalCards.map((c) => ({
            src_start: c.srcStart,
            src_end: c.srcEnd,
            text: c.lines.join(NEWLINE),
            png: '',
            look: lookOf(c),
          }));
        }

        setProgress({ value: 0, message: '書き出しています' });
        const result = (await window.app.exportVideo({
          video_path: analysis.video_path,
          out_path: target,
          work_dir: analysis.work_dir,
          duration: analysis.duration,
          fps: analysis.video.fps,
          cuts: cuts.map((c) => ({ src_start: c.srcStart, src_end: c.srcEnd })),
          framing: framingSegments,
          telops,
          blank_png: blankPng,
          burn_telops: options.burn,
          write_srt: options.srt,
          write_fcpxml: options.fcpxml,
          music: music
            ? { path: music.path, volume: music.volume, loop: music.loop }
            : null,
        })) as ExportResult;
        /*
          Final Cut 用のタイムラインを出したなら、使った書体も隣に置く。
          🔴 置かないと、その Mac に同梱書体が入っていない限り
             Final Cut は**警告も出さずに別の書体で開く**。
             書き出したあとに本人が気づく手段が無い。
        */
        if (options.fcpxml && result.fcpxml_path && finalCards.length > 0) {
          const used = [
            ...new Set(
              finalCards.map((c) => {
                const resolved = resolveStyle(styles, c.style, c.override, c.fontScale);
                return macFontOf(resolved.fontFamily, resolved.bold).file;
              }),
            ),
          ];
          const dir = await window.app
            .exportFonts({ nextTo: result.fcpxml_path, files: used })
            .catch(() => null);
          if (dir) result.font_dir = dir;
        }
        setExported(result);
        setPhase('done');
      } catch (e) {
        setError((e as Error).message);
        setPhase('telop');
      }
    },
    [analysis, cuts, frame, shots],
  );

  if (!hasBridge) {
    return (
      <main>
        <h1>PAC</h1>
        <section>
          <h2>アプリとして起動してください</h2>
          <p className="error">
            Electron の橋渡し（preload）が読み込まれていません。動画の読み込みや書き出しはできません。
          </p>
          <p className="muted">
            ブラウザで直接開いた場合はこの表示になります。
            <code>アプリを起動.cmd</code> か <code>npm run app</code> で起動してください。
            <br />
            アプリとして起動しているのにこの表示が出る場合は、preload の配置がずれています。
          </p>
          <p className="muted">
            レビューUIの操作感だけ見たいときは <code>?mode=review-demo</code> を付けると
            モックデータで動きます。
          </p>
        </section>
      </main>
    );
  }

  const help = showShortcuts ? <ShortcutHelp onClose={() => setShowShortcuts(false)} /> : null;

  if (phase === 'review' && analysis) {
    return (
      <>
        {help}
        {resumed && (
          <p className="resumed">前回の続きから再開しました（判定済みの内容を復元しています）</p>
        )}
        <CutStage
          candidates={analysis.candidates.map(toCandidate)}
          band={analysis.review_band}
          fps={analysis.video.fps}
          videoPath={analysis.video_path}
          videoDuration={analysis.duration}
          audioPath={analysis.wav_path}
          frame={frame}
          initialState={savedReview}
          onStateChange={saveReview}
          onNeedClip={requestClip}
          onChangePace={(p) => void changePace(p)}
          pace={pace}
          repacing={repacing}
          onQuit={() => void quitEditing()}
          onExport={buildTelops}
          exporting={false}
        />
      </>
    );
  }

  if (phase === 'telop' && analysis) {
    return (
      <>
        {help}
        <TelopStage
          cards={cards}
          // 下書きに残っていればそれ、無ければ本人が既定として保存した見た目
          styles={styles}
          onStylesChange={setTelopStyles}
          fontFamilies={fontFamilies}
          library={library}
          onLibraryChange={saveLibrary}
          videoPath={analysis.video_path}
          frame={frame}
          rewrap={rewrap}
          duration={analysis.duration}
          fps={analysis.video.fps}
          audioPath={analysis.wav_path}
          music={music}
          onMusicChange={setMusic}
          onPickMusic={() => window.app.pickMusic()}
          cutRegions={cuts.map((c) => ({
            id: c.id,
            start: c.srcStart,
            end: c.srcEnd,
          }))}
          onCutsChange={(next) =>
            setCuts((prev) => {
              const byId = new Map(next.map((n) => [n.id, n]));
              return prev
                .filter((c) => byId.has(c.id))
                .map((c) => {
                  const n = byId.get(c.id)!;
                  return { ...c, srcStart: n.start, srcEnd: n.end };
                });
            })
          }
          /*
            🔴 テロップは「作られた時点のカット」を元にしている。
               カットを広げると、切ったはずの言葉がテロップに残る。
               変わったことを画面に出して、作り直せるようにする。
          */
          cutsChanged={cutsKey(cuts) !== builtForRef.current}
          onRebuildTelops={() => void buildTelops(cuts)}
          onChange={(next) => {
            /*
              🔴 直すたびに受け取って保存すること。
                 「戻る」「進む」のときだけでは足りない。100枚校正したあとに
                 窓を閉じれば、押した記憶だけ残して全部消える。
            */
            setCards(next);
            saveTelopEdits({
              cards: next,
              styles,
              options: finalState?.options ?? DEFAULT_EXPORT_OPTIONS,
              removed: finalState?.removed ?? [],
            });
          }}
          onBack={() => setPhase('review')}
          onQuit={() => void quitEditing()}
          onExport={(next) => {
            setCards(next);
            goFullPreview(next, styles, finalState?.options ?? DEFAULT_EXPORT_OPTIONS);
          }}
          exporting={false}
        />
      </>
    );
  }

  if (phase === 'fullpreview' && analysis && finalState) {
    return (
      <>
        {help}
        <FinalStage
          videoPath={analysis.video_path}
          frame={frame}
          duration={analysis.duration}
          fps={analysis.video.fps}
          cuts={cuts.map((c) => ({ srcStart: c.srcStart, srcEnd: c.srcEnd }))}
          cards={finalState.cards}
          styles={finalState.styles}
          audioPath={analysis.wav_path}
          music={music}
          skipped={skippedShots}
          onBack={() => setPhase('telop')}
          onQuit={() => void quitEditing()}
          onExport={() => void runExport(finalState.cards, finalState.styles, finalState.options)}
        />
      </>
    );
  }

  const busy =
    phase === 'analyzing' ||
    phase === 'exporting' ||
    phase === 'telops-building' ||
    phase === 'framing';

  /*
    🔴 経過時間は工程ごとに測ること。
       以前は「動画を選ぶ」経路でしか開始時刻を入れておらず、初期値が 0 のまま。
       下書きから再開すると Date.now() - 0 が秒に化けて
       「1787000000秒経過」と出ていた。書き出し中の画面に
       「解析開始からの経過」が出るのも同じ間違い。
  */
  const elapsedSeconds = startedAt > 0 ? Math.round((now - startedAt) / 1000) : 0;
  const remain =
    progress.value > 0.02 && elapsedSeconds > 3
      ? Math.round((elapsedSeconds / progress.value) * (1 - progress.value))
      : null;
  const busyTitle =
    phase === 'analyzing'
      ? '解析中'
      : phase === 'telops-building'
        ? 'テロップを作成中'
        : phase === 'framing'
          ? '画角を決めています'
          : '書き出し中';

  return (
    <main>
      {help}
      <h1>PAC</h1>
      <p className="phase">
        無音・フィラー・言い直しを自動でカットし、テロップを自動で入れます
      </p>

      {error && <p className="error">エラー: {error}</p>}

      {phase === 'no-speech' && analysis && (
        <section>
          <h2>この動画は編集できません</h2>
          <p className="error">音声（人の声）が検出できませんでした。</p>
          <p className="muted">
            このアプリは「話している内容」を元にカットとテロップを作ります。
            <br />
            声が入っていない素材では、判断の材料がないため何もできません。
          </p>
          {/*
            🔴 理由コード（repeat / short など）をそのまま出さない。
               友達に必要なのは「声が入っていないので編集できない」の一行で、
               内訳は不具合の記録に残っていれば足りる。
          */}
          <dl>
            <dt>動画の長さ</dt>
            <dd>{formatDuration(analysis.video.duration)}</dd>
            <dt>聞き取れた話し声</dt>
            <dd>ありません</dd>
          </dl>
          <p className="muted">
            音を認識する仕組みは、声が入っていない素材に対しても
            <strong>それらしい文字を出してしまう</strong>ことがあります。
            そのまま使うと意味のないテロップだらけになるので、ここで止めています。
            <br />
            声が入っている別の動画を選んでください。
          </p>
          <div className="actions">
            <button className="primary" onClick={pickAndAnalyze}>
              別の動画を選ぶ
            </button>
          </div>
        </section>
      )}

      {phase === 'idle' && (
        <>
          <section>
            <h2>動画を読み込む</h2>
            <p className="muted">
              読み込むと、音声を文字起こししてカット候補を作ります。
              <br />
              カットを決めたあと、その結果に合わせてテロップを作ります。
            </p>
            <button onClick={pickAndAnalyze}>動画を選ぶ</button>
          </section>

          {/*
            🔴 下書きは最初の画面から開けること。
               以前は「同じ動画をもう一度選ぶ」以外に開く道が無く、
               保存したのに辿り着けなかった。
               どこに保存したか覚えているのはアプリ側の仕事で、人間の仕事ではない。
          */}
          {drafts.length > 0 && (
            <section className="drafts">
              <h2>途中の編集を続ける</h2>
              <p className="muted">
                解析はやり直しません。判定した内容もそのまま残っています。
              </p>
              <ul>
                {drafts.map((d) => (
                  <li key={d.workDir} className={d.videoMissing ? 'missing' : undefined}>
                    <div className="who">
                      <strong>{d.videoName}</strong>
                      <span className="muted">
                        {formatSavedAt(d.savedAt)}
                        {d.duration > 0 && <> ・ {formatDuration(d.duration)}</>}
                        {d.total > 0 && (
                          <>
                            {' '}
                            ・ カット候補 {d.total} 件中 {d.decided} 件を判定済み
                          </>
                        )}
                        {PHASE_LABEL[d.phase as Phase] && <> ・ {PHASE_LABEL[d.phase as Phase]}</>}
                      </span>
                      {/*
                        動画そのものが移動・削除されている場合。
                        判定は残っていても再生も書き出しもできないので、押させる前に伝える。
                      */}
                      {d.videoMissing && (
                        <span className="error">
                          元の動画が見つかりません（{d.videoPath}）
                        </span>
                      )}
                    </div>
                    <div className="ops">
                      <button
                        className="primary"
                        disabled={d.videoMissing}
                        onClick={() => void openDraft(d)}
                      >
                        続きから
                      </button>
                      <button onClick={() => void deleteDraft(d)}>削除</button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {busy && (
        <section>
          <h2>{busyTitle}</h2>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${progress.value * 100}%` }} />
          </div>
          <p className="muted">
            {progress.message}（{Math.round(progress.value * 100)}%）
          </p>
          {/*
            🔴 残り時間を出す。
               %と経過秒だけを十数分見せられると、進んでいるのか固まっているのかが
               判断できない。友達は必ず強制終了する。
          */}
          <p className="muted">
            {remain !== null ? (
              <>
                残り約 <strong>{formatDuration(remain)}</strong>
                <span> ・ {formatDuration(elapsedSeconds)}経過</span>
              </>
            ) : (
              <>{formatDuration(elapsedSeconds)}経過（残り時間を計算しています）</>
            )}
          </p>
          <p className="muted">
            電源につないだままにしてください。他のアプリを使っても構いませんが、動作が重くなります。
          </p>
          <div className="actions">
            <button onClick={cancelAnalyze}>
              {phase === 'exporting' ? '書き出しをやめる' : 'やめる'}
            </button>
          </div>
        </section>
      )}

      {phase === 'done' && exported && analysis && (
        <section>
          <h2>書き出しました</h2>
          <dl>
            <dt>元の長さ</dt>
            <dd>{formatDuration(exported.original_seconds)}</dd>
            <dt>カット後</dt>
            <dd>
              {formatDuration(exported.kept_seconds)}
              <span className="muted">
                {' '}
                （{Math.round((1 - exported.kept_seconds / exported.original_seconds) * 100)}% 短縮）
              </span>
            </dd>
            <dt>適用したカット</dt>
            <dd>{exported.cut_count} 箇所</dd>
            <dt>焼き込んだテロップ</dt>
            <dd>{exported.telop_count} 枚</dd>
            {exported.srt_path && (
              <>
                <dt>字幕ファイル</dt>
                <dd>
                  <code>{exported.srt_path}</code>
                </dd>
              </>
            )}
            {exported.fcpxml_path && (
              <>
                <dt>Final Cut 用</dt>
                <dd>
                  <code>{exported.fcpxml_path}</code>
                  <br />
                  <span className="muted">
                    Final Cut Pro のファイル →「読み込む」→「XML…」から開くと、
                    カットした状態のタイムラインになります。テロップの書体・色・
                    大きさ・位置もそのまま入ります。
                  </span>
                  {/*
                    🔴 同梱書体はアプリの中にしか無い。入れてもらわないと、
                       Final Cut は警告も出さずに別の書体で開く。
                       ここで言わないと、書き出したあとに気づく手段が無い。
                  */}
                  {exported.font_dir && (
                    <>
                      <br />
                      <strong className="fontnote">
                        先に、隣の「_フォント」フォルダの中の書体を入れてください。
                      </strong>
                      <br />
                      <span className="muted">
                        入れないとテロップの書体だけ別のものになります（色・大きさ・位置は合います）。
                        入れるのは最初の1回だけです。
                      </span>{' '}
                      <button className="link" onClick={() => window.app.revealFile(exported.font_dir!)}>
                        フォルダを開く
                      </button>
                    </>
                  )}
                </dd>
              </>
            )}
            {/*
              🔴 エンコーダ名（h264_videotoolbox など）は出さない。
                 見ても判断材料にならない。異常なときだけ、その意味を書く。
            */}
            {exported.encoder_fallback && (
              <>
                <dt>画質</dt>
                <dd className="error">
                  この機械では映像処理の支援が使えず、画質が落ちた状態で書き出しました
                  <span className="muted"> （{exported.encoder}）</span>
                </dd>
              </>
            )}
            <dt>ファイル</dt>
            <dd>
              <code>{exported.out_path}</code>（{exported.size_mb} MB）
            </dd>
          </dl>
          <div className="actions">
            <button className="primary" onClick={() => window.app.revealFile(exported.out_path)}>
              フォルダを開く
            </button>
            <button onClick={resetEditing}>別の動画を編集する</button>
          </div>
        </section>
      )}
    </main>
  );
}
