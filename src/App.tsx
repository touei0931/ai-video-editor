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
import { PreviewScreen, type Shot } from './preview/PreviewScreen';
import { ShortcutHelp } from './ShortcutHelp';
import { ReviewScreen, type ReviewState } from './review/ReviewScreen';
import type { CutCandidate, CutKind, ReviewBand } from './review/mockCandidates';
import { TelopScreen, type ExportOptions, type StyleMap } from './telop/TelopScreen';
import { loadTelopFonts } from './telop/fonts';
import { renderBlank, renderTelopPngs } from './telop/rasterize';
import {
  buildCards,
  makeMeasure,
  rewrapCard,
  type Frame,
  type TelopCard,
  type TelopUnit,
} from './telop/split';
import type { TelopStyleName } from './telop/style';

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
  shots?: Shot[];
}

/** SRT の1エントリ内の改行 */
const NEWLINE = '\n';

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
  /** 通し確認・書き出しで使う、確認画面での最終状態 */
  const [finalState, setFinalState] = useState<{ cards: TelopCard[]; styles: StyleMap; options: ExportOptions } | null>(null);
  /** 前回の続き。解析後に作業フォルダから読み込む */
  const [savedReview, setSavedReview] = useState<ReviewState | null>(null);
  const [resumed, setResumed] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  /** ③ズーム・画角の自動化。人物アップに寄るショット */
  const [shots, setShots] = useState<Shot[]>([]);
  /** 寄らなかった理由。「なぜアップにならないのか」が分からないと不具合に見える */
  const [skippedShots, setSkippedShots] = useState<Record<string, number>>({});
  const [exported, setExported] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  /** 保存済みの下書き。最初の画面から直接開けるようにするために持つ */
  const [drafts, setDrafts] = useState<DraftEntry[]>([]);

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
  const cancelAnalyze = useCallback(async () => {
    await window.app.cancel();
    setPhase('idle');
    setError(null);
  }, []);

  /**
   * 下書きから続きを再開する。
   * 🔴 解析はやり直さない。解析結果ごと保存してあるので読むだけで済む。
   */
  const resumeDraft = useCallback((draft: Draft): boolean => {
    if (!draft?.analysis) return false;
    setAnalysis(draft.analysis);
    setSavedReview(draft.review ?? null);
    setShots(draft.shots ?? []);
    setCards(draft.cards ?? []);
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
    setResumed(true);
    // テロップ以降まで進んでいても、カットの確認からやり直せたほうが安全。
    // 判定は残っているので、そのまま Enter で先へ進める。
    setPhase('review');
    return true;
  }, []);

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

  /** カットのレビューが終わったら、その結果を踏まえてテロップを作る */
  const buildTelops = useCallback(
    async (approved: CutCandidate[]) => {
      if (!analysis || !measure) return;
      setCuts(approved);
      setPhase('telops-building');
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

        setCards(buildCards(result.telops.map(toUnit), measure, frame));
        setPhase('telop');
      } catch (e) {
        setError((e as Error).message);
        setPhase('review');
      }
    },
    [analysis, measure, frame],
  );

  /**
   * 判定を作業フォルダに書く。
   * 押すたびに書くと I/O が多すぎるので、少し待ってからまとめて書く。
   */
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 最後に受け取ったレビューの判定。下書きに含める */
  const reviewStateRef = useRef<ReviewState | null>(null);

  const saveDraft = useCallback(async () => {
    if (!analysis) return;
    const draft: Draft = {
      video_path: analysis.video_path,
      savedAt: new Date().toISOString(),
      phase,
      analysis,
      review: reviewStateRef.current ?? undefined,
      cuts: cuts.map((c) => ({ srcStart: c.srcStart, srcEnd: c.srcEnd })),
      cards: finalState?.cards ?? (cards.length ? cards : undefined),
      styles: finalState?.styles,
      shots,
    };
    await window.app.saveProject({
      workDir: analysis.work_dir,
      data: draft,
      // 一覧に出すぶんだけ別に渡す。本体を読まずに一覧を作れるようにする
      // （20分素材の下書きは数MBあり、一覧のたびに全部読むと重い）
      summary: {
        videoPath: analysis.video_path,
        savedAt: draft.savedAt,
        phase,
        decided: Object.keys(reviewStateRef.current?.decisions ?? {}).length,
        total: analysis.candidates.length,
        duration: analysis.duration,
      },
    });
  }, [analysis, phase, cuts, cards, finalState, shots]);

  const saveReview = useCallback(
    (state: ReviewState) => {
      reviewStateRef.current = state;
      if (!analysis) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void saveDraft(), 800);
    },
    [analysis, saveDraft],
  );

  /**
   * 編集をやめて動画の選択に戻る。
   * 一度入ると書き出すまで抜けられないのは、間違ったファイルを選んだときに詰む。
   */
  const quitEditing = useCallback(async () => {
    const hasWork =
      Object.keys(reviewStateRef.current?.decisions ?? {}).length > 0 ||
      cards.length > 0 ||
      cuts.length > 0;
    const answer = await window.app.confirmQuit({ hasWork });
    if (answer === 'cancel') return;
    if (answer === 'save') await saveDraft();

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
    reviewStateRef.current = null;
    setPhase('idle');
  }, [cards.length, cuts.length, saveDraft]);

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

  const rewrap = useCallback(
    (text: string, style: TelopStyleName) =>
      measure ? rewrapCard(text, style, measure, frame) : { lines: [text], fontScale: 1 },
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
      setFinalState({ cards: finalCards, styles, options });
      setCards(finalCards);
      setPhase('framing');
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
        let telops: { src_start: number; src_end: number; text: string; png: string }[] = [];
        let blankPng = '';

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
          }));
        } else if (finalCards.length > 0) {
          // 焼き込まない場合でも、字幕ファイルを出すために時刻と文言は渡す
          telops = finalCards.map((c) => ({
            src_start: c.srcStart,
            src_end: c.srcEnd,
            text: c.lines.join(NEWLINE),
            png: '',
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
        })) as ExportResult;
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
        <h1>AI動画編集</h1>
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
        <ReviewScreen
          candidates={analysis.candidates.map(toCandidate)}
          band={analysis.review_band}
          fps={analysis.video.fps}
          initialState={savedReview}
          onStateChange={saveReview}
          onNeedClip={requestClip}
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
        <TelopScreen
        cards={cards}
        videoPath={analysis.video_path}
        frame={frame}
        rewrap={rewrap}
        onBack={() => setPhase('review')}
        onExport={goFullPreview}
        exporting={false}
          error={error}
        />
      </>
    );
  }

  if (phase === 'fullpreview' && analysis && finalState) {
    return (
      <>
        {help}
        <PreviewScreen
        videoPath={analysis.video_path}
        frame={frame}
        duration={analysis.duration}
        cuts={cuts}
          cards={finalState.cards}
          styles={finalState.styles}
          shots={shots}
          skipped={skippedShots}
          onShotsChange={setShots}
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
      <h1>AI動画編集</h1>
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
          <dl>
            <dt>動画の長さ</dt>
            <dd>{formatDuration(analysis.video.duration)}</dd>
            <dt>検出できた発話</dt>
            <dd>0 秒</dd>
            <dt>除外した誤認識</dt>
            <dd>
              {analysis.speech.dropped} 件
              <span className="muted">
                {' '}
                （{Object.entries(analysis.speech.reasons).map(([k, v]) => `${k} ${v}`).join(' / ')}）
              </span>
            </dd>
          </dl>
          <p className="muted">
            音声認識エンジンは、声の入っていない素材に対しても
            <strong>それらしい文字列を出力してしまう</strong>ことがあります
            （今回は「mr」の繰り返し）。
            <br />
            そのまま使うと意味のないテロップだらけになるため、ここで止めています。
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
            {progress.message}（{Math.round(progress.value * 100)}%・
            {Math.round((Date.now() - startedAt) / 1000)}秒経過）
          </p>
          <p className="muted">他のアプリを使っていて構いません。</p>
          {phase === 'analyzing' && (
            <div className="actions">
              <button onClick={cancelAnalyze}>解析をやめる</button>
            </div>
          )}
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
            <dt>エンコーダ</dt>
            <dd>
              {exported.encoder}
              {/*
                ハードウェアエンコーダが使えず落ちたことは必ず伝える。
                mpeg4 まで落ちると画質が明らかに悪くなるが、
                エンコーダ名を見て異常だと気づくのは無理。
              */}
              {exported.encoder_fallback && (
                <span className="error">
                  {' '}
                  ← ハードウェアの支援が使えず、ソフトウェアで書き出しました（画質が落ちます）
                </span>
              )}
            </dd>
            <dt>ファイル</dt>
            <dd>
              <code>{exported.out_path}</code>（{exported.size_mb} MB）
            </dd>
          </dl>
          <div className="actions">
            <button className="primary" onClick={() => window.app.revealFile(exported.out_path)}>
              フォルダを開く
            </button>
            <button
              onClick={() => {
                setAnalysis(null);
                setExported(null);
                setCards([]);
                setCuts([]);
                setPhase('idle');
              }}
            >
              別の動画を編集する
            </button>
          </div>
        </section>
      )}

      {analysis && phase !== 'review' && phase !== 'telop' && phase !== 'no-speech' && (
        <section>
          <h2>文字起こし</h2>
          <p className="muted">
            {analysis.transcript.model} / {analysis.transcript.elapsed_seconds}秒（
            {analysis.transcript.realtime_factor}倍速）
          </p>
          <p>{analysis.transcript.text}</p>
        </section>
      )}
    </main>
  );
}
