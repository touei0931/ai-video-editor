/**
 * アプリ本体の流れ（①カット）。
 *
 *   動画を選ぶ → 解析（音声抽出→文字起こし→カット候補検出）
 *     → レビュー（Y/N で承認・却下）→ 書き出し
 *
 * テロップ（②）とズーム（③）は Phase 2 以降。
 */
import { useCallback, useEffect, useState } from 'react';
import { ReviewScreen } from './review/ReviewScreen';
import type { CutCandidate, CutKind } from './review/mockCandidates';

type Phase = 'idle' | 'analyzing' | 'review' | 'exporting' | 'done';

interface AnalyzeResult {
  video_path: string;
  duration: number;
  candidate_count: number;
  kinds: Record<string, number>;
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
  }[];
}

interface ExportResult {
  out_path: string;
  encoder: string;
  kept_seconds: number;
  original_seconds: number;
  cut_count: number;
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
  };
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}分${String(s).padStart(2, '0')}秒`;
}

export function App() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState({ value: 0, message: '' });
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
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

  const pickAndAnalyze = useCallback(async () => {
    setError(null);
    const path = await window.app.pickVideo();
    if (!path) return;

    setPhase('analyzing');
    setProgress({ value: 0, message: '準備しています' });
    setStartedAt(Date.now());

    try {
      const result = (await window.app.analyze({ video_path: path, model: 'base' })) as AnalyzeResult;
      setAnalysis(result);
      setPhase('review');
    } catch (e) {
      setError((e as Error).message);
      setPhase('idle');
    }
  }, []);

  const runExport = useCallback(
    async (approved: CutCandidate[]) => {
      if (!analysis) return;
      const base = analysis.video_path.replace(/\.[^.]+$/, '');
      const target = await window.app.pickOutput(`${base}_cut.mp4`);
      if (!target) return;

      setPhase('exporting');
      setProgress({ value: 0, message: '書き出しています' });

      try {
        const result = (await window.app.exportVideo({
          video_path: analysis.video_path,
          out_path: target,
          duration: analysis.duration,
          cuts: approved.map((c) => ({ src_start: c.srcStart, src_end: c.srcEnd })),
        })) as ExportResult;
        setExported(result);
        setPhase('done');
      } catch (e) {
        setError((e as Error).message);
        setPhase('review');
      }
    },
    [analysis],
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
      <ReviewScreen
        candidates={analysis.candidates.map(toCandidate)}
        onExport={runExport}
        exporting={false}
      />
    );
  }

  return (
    <main>
      <h1>AI動画編集</h1>
      <p className="phase">無音・フィラー・言い直しを自動で見つけてカットします</p>

      {error && <p className="error">エラー: {error}</p>}

      {phase === 'idle' && (
        <section>
          <h2>動画を読み込む</h2>
          <p className="muted">
            読み込むと、音声を文字起こししてカット候補を作ります。
            <br />
            候補は1件ずつ確認して、Y / N で承認・却下できます。
          </p>
          <button onClick={pickAndAnalyze}>動画を選ぶ</button>
        </section>
      )}

      {(phase === 'analyzing' || phase === 'exporting') && (
        <section>
          <h2>{phase === 'analyzing' ? '解析中' : '書き出し中'}</h2>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${progress.value * 100}%` }} />
          </div>
          <p className="muted">
            {progress.message}（{Math.round(progress.value * 100)}%・
            {Math.round((Date.now() - startedAt) / 1000)}秒経過）
          </p>
          <p className="muted">他のアプリを使っていて構いません。</p>
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
            <dt>エンコーダ</dt>
            <dd>{exported.encoder}</dd>
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
                setPhase('idle');
              }}
            >
              別の動画を編集する
            </button>
          </div>
        </section>
      )}

      {analysis && phase !== 'review' && (
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
