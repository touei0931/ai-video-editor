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
import { PreviewScreen } from './preview/PreviewScreen';
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

/** SRT の1エントリ内の改行 */
const NEWLINE = '\n';

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}分${String(s).padStart(2, '0')}秒`;
}

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
  const [exported, setExported] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);

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

  const pickAndAnalyze = useCallback(async () => {
    setError(null);
    const path = await window.app.pickVideo();
    if (!path) return;

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

      // 前回の続きがあれば拾う。100件レビューした状態でアプリが落ちても、
      // 解析からやり直しにはならない。
      const project = (await window.app.loadProject(result.work_dir)) as
        | { video_path?: string; review?: ReviewState }
        | null;
      const resume =
        project?.video_path === result.video_path && project.review ? project.review : null;
      setSavedReview(resume);
      setResumed(Boolean(resume && Object.keys(resume.decisions).length > 0));

      // 使える発話がひとつも無い素材。ここで止めないと、
      // 素材全体が無音扱いになって「全部カット」という壊れた結果になる。
      setPhase(result.speech.kept === 0 ? 'no-speech' : 'review');
    } catch (e) {
      setError((e as Error).message);
      setPhase('idle');
    }
  }, []);

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
  const saveReview = useCallback(
    (state: ReviewState) => {
      if (!analysis) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void window.app.saveProject({
          workDir: analysis.work_dir,
          data: { video_path: analysis.video_path, savedAt: new Date().toISOString(), review: state },
        });
      }, 800);
    },
    [analysis],
  );

  const rewrap = useCallback(
    (text: string, style: TelopStyleName) =>
      measure ? rewrapCard(text, style, measure, frame) : { lines: [text], fontScale: 1 },
    [measure, frame],
  );

  /** テロップ確認のあとは、いきなり書き出さず通しで見せる */
  const goFullPreview = useCallback(
    (finalCards: TelopCard[], styles: StyleMap, options: ExportOptions) => {
      setFinalState({ cards: finalCards, styles, options });
      setCards(finalCards);
      setPhase('fullpreview');
    },
    [],
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
    [analysis, cuts, frame],
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

  if (phase === 'review' && analysis) {
    return (
      <>
        {resumed && (
          <p className="resumed">前回の続きから再開しました（判定済みの内容を復元しています）</p>
        )}
        <ReviewScreen
          candidates={analysis.candidates.map(toCandidate)}
          band={analysis.review_band}
          fps={analysis.video.fps}
          initialState={savedReview}
          onStateChange={saveReview}
          onExport={buildTelops}
          exporting={false}
        />
      </>
    );
  }

  if (phase === 'telop' && analysis) {
    return (
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
    );
  }

  if (phase === 'fullpreview' && analysis && finalState) {
    return (
      <PreviewScreen
        videoPath={analysis.video_path}
        frame={frame}
        duration={analysis.duration}
        cuts={cuts}
        cards={finalState.cards}
        styles={finalState.styles}
        onBack={() => setPhase('telop')}
        onExport={() => void runExport(finalState.cards, finalState.styles, finalState.options)}
      />
    );
  }

  const busy = phase === 'analyzing' || phase === 'exporting' || phase === 'telops-building';
  const busyTitle =
    phase === 'analyzing' ? '解析中' : phase === 'telops-building' ? 'テロップを作成中' : '書き出し中';

  return (
    <main>
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
        <section>
          <h2>動画を読み込む</h2>
          <p className="muted">
            読み込むと、音声を文字起こししてカット候補を作ります。
            <br />
            カットを決めたあと、その結果に合わせてテロップを作ります。
          </p>
          <button onClick={pickAndAnalyze}>動画を選ぶ</button>
        </section>
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
