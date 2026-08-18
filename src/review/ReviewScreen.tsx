/**
 * カットレビュー画面（設計レポート §3.3）。
 *
 * 🔴 このアプリの価値を決めるのはここ。
 *    「AIの精度を上げる」より「人間が秒速で承認/却下できる」ほうが総作業時間に効く。
 *    目標: 20分素材のカット候補 118件 → 実際に見るのは25件前後、1件2.2秒、全体で約2分。
 *
 * 現状はモックデータでの操作感確認用。解析パイプラインは未接続。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  generateMockCandidates,
  KIND_LABEL,
  type CutCandidate,
} from './mockCandidates';
import './review.css';

type Decision = 'approved' | 'rejected' | 'held';

const HIGH = 0.9;
const LOW = 0.6;

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

/** 目盛り用。秒は切り捨てて mm:ss */
function formatClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 波形は解析結果が来るまでモック。カット区間が視覚的に分かることが目的。 */
function Waveform({ candidate }: { candidate: CutCandidate }) {
  const bars = useMemo(() => {
    const out: number[] = [];
    let seed = Math.floor(candidate.srcStart * 1000);
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < 90; i++) {
      // 中央の約1/3がカット対象＝無音に近い
      const inCut = i > 30 && i < 60;
      out.push(inCut ? 0.02 + rand() * 0.06 : 0.25 + rand() * 0.75);
    }
    return out;
  }, [candidate.id, candidate.srcStart]);

  return (
    <div className="waveform" aria-hidden>
      {bars.map((h, i) => (
        <span
          key={i}
          className={i > 30 && i < 60 ? 'bar cut' : 'bar'}
          style={{ height: `${Math.round(h * 100)}%` }}
        />
      ))}
    </div>
  );
}

export function ReviewScreen() {
  const all = useMemo(() => generateMockCandidates(118), []);

  // 確信度で3分割（§3.3.1）。人間が1件ずつ見るのは中間層だけ。
  const { autoApproved, toReview, autoRejected, fillers } = useMemo(() => {
    const fillerList = all.filter((c) => c.kind === 'filler' && c.confidence >= LOW);
    const rest = all.filter((c) => !(c.kind === 'filler' && c.confidence >= LOW));
    return {
      autoApproved: rest.filter((c) => c.confidence >= HIGH),
      toReview: rest.filter((c) => c.confidence >= LOW && c.confidence < HIGH),
      autoRejected: rest.filter((c) => c.confidence < LOW),
      fillers: fillerList,
    };
  }, [all]);

  /** 素材の長さ。実装後は動画のメタデータから取る */
  const duration = useMemo(
    () => Math.max(60, Math.ceil(Math.max(...all.map((c) => c.srcEnd)) / 60) * 60),
    [all],
  );

  /** 目盛りは2〜5分刻み */
  const rulerMarks = useMemo(() => {
    const step = duration > 900 ? 300 : duration > 300 ? 120 : 60;
    const marks: number[] = [];
    for (let t = 0; t <= duration; t += step) marks.push(t);
    return marks;
  }, [duration]);

  const [index, setIndex] = useState(0);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [adjust, setAdjust] = useState<Record<string, number>>({});
  const [history, setHistory] = useState<string[]>([]);
  const [startedAt] = useState(() => Date.now());
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const liveRef = useRef<HTMLDivElement>(null);

  /**
   * 「どこまで進んだか」を覚えておく。
   * 前のほうに戻って直したあと、また最後尾から続けられるようにするため。
   * これが無いと、戻るたびに以降を全部見直すことになる。
   */
  const [resumeIndex, setResumeIndex] = useState(0);
  const revisiting = index < resumeIndex;

  /** 直前の判定を取り消したときに、どれを取り消したかを知らせる */
  const [undoNotice, setUndoNotice] = useState<number | null>(null);

  /** タイムライン上のマーカーから「何件目か」を引くための対応表 */
  const reviewIndexById = useMemo(
    () => new Map(toReview.map((c, i) => [c.id, i])),
    [toReview],
  );

  const current = toReview[index];
  const done = index >= toReview.length;

  useEffect(() => {
    if (done && finishedAt === null) setFinishedAt(Date.now());
  }, [done, finishedAt]);

  const decide = useCallback(
    (decision: Decision) => {
      if (!current) return;
      setDecisions((prev) => ({ ...prev, [current.id]: decision }));
      setHistory((prev) => [...prev, current.id]);

      setUndoNotice(null);

      if (revisiting) {
        // 戻って直していたのなら、元いた位置に復帰する
        setIndex(resumeIndex);
      } else {
        setIndex((i) => {
          const next = i + 1;
          setResumeIndex((r) => Math.max(r, next));
          return next;
        });
      }
    },
    [current, revisiting, resumeIndex],
  );

  /** バーのクリックで任意の候補へ飛ぶ */
  const jumpTo = useCallback(
    (target: number) => {
      setResumeIndex((r) => Math.max(r, index));
      setIndex(Math.max(0, Math.min(toReview.length - 1, target)));
      setUndoNotice(null);
    },
    [index, toReview.length],
  );

  /**
   * 直前に下した判定を取り消す（Ctrl+Z 相当。画面上の位置ではなく判定した順に戻る）。
   *
   * 取り消した候補を**画面に表示する**こと。
   * 表示は現在地のままで裏で別の候補の判定だけ消える、という動きは
   * 「何が起きたか分からない」ので必ず飛ぶ。
   */
  const undo = useCallback(() => {
    setHistory((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];

      setDecisions((d) => {
        const next = { ...d };
        delete next[last];
        return next;
      });

      const target = toReview.findIndex((c) => c.id === last);
      if (target >= 0) {
        setResumeIndex((r) => Math.max(r, index));
        setIndex(target);
        setUndoNotice(target);
      }

      return prev.slice(0, -1);
    });
  }, [toReview, index]);

  const nudge = useCallback(
    (frames: number) => {
      if (!current) return;
      setAdjust((prev) => ({ ...prev, [current.id]: (prev[current.id] ?? 0) + frames }));
    },
    [current],
  );

  // キーボードだけで完結させる。マウスに手を伸ばした時点で2秒失う（§3.3.3）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat && !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      switch (e.key.toLowerCase()) {
        case 'y':
          decide('approved');
          break;
        case 'n':
          decide('rejected');
          break;
        case 's':
          decide('held');
          break;
        case 'u':
          undo();
          break;
        case 'arrowleft':
          nudge(e.shiftKey ? -5 : -1);
          break;
        case 'arrowright':
          nudge(e.shiftKey ? 5 : 1);
          break;
        case 'enter':
          setIndex(toReview.length);
          break;
        case '[':
          jumpTo(index - 1);
          break;
        case ']':
          jumpTo(index + 1);
          break;
        case 'escape':
          // 戻って直していたのを取りやめて、元の位置に復帰する
          if (revisiting) setIndex(resumeIndex);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [decide, undo, nudge, jumpTo, index, revisiting, resumeIndex, toReview.length]);

  const counts = useMemo(() => {
    const v = Object.values(decisions);
    return {
      approved: v.filter((d) => d === 'approved').length,
      rejected: v.filter((d) => d === 'rejected').length,
      held: v.filter((d) => d === 'held').length,
    };
  }, [decisions]);

  const elapsed = ((finishedAt ?? Date.now()) - startedAt) / 1000;
  const perItem = history.length > 0 ? elapsed / history.length : 0;

  if (done) {
    return (
      <div className="review done">
        <h1>レビュー完了</h1>
        <p className="lead">
          {toReview.length} 件を <strong>{elapsed.toFixed(1)} 秒</strong>で処理しました
          （1件あたり <strong>{perItem.toFixed(2)} 秒</strong>）
        </p>
        <p className={perItem <= 2.5 ? 'ok' : 'warn'}>
          目標は 1件 2.2〜2.5 秒。{perItem <= 2.5 ? '目標内です。' : 'まだ目標より遅いです。'}
        </p>

        <dl className="summary">
          <dt>自動承認（確信度 0.90 以上）</dt>
          <dd>{autoApproved.length} 件</dd>
          <dt>フィラー一括処理</dt>
          <dd>{fillers.length} 件</dd>
          <dt>自動却下（確信度 0.60 未満）</dt>
          <dd>{autoRejected.length} 件</dd>
          <dt>人間が確認した件数</dt>
          <dd>
            <strong>{toReview.length} 件</strong>（承認 {counts.approved} / 却下 {counts.rejected} / 保留{' '}
            {counts.held}）
          </dd>
          <dt>候補の総数</dt>
          <dd>{all.length} 件</dd>
        </dl>

        <p className="note">
          ここで押した Y / N が、そのまま「あなたのカットの好み」の学習データになります（§12）。
          使うほど自動承認の範囲が広がり、確認する件数が減っていく設計です。
        </p>

        <button onClick={() => window.location.reload()}>もう一度</button>
      </div>
    );
  }

  const offset = adjust[current.id] ?? 0;
  const cutLength = current.srcEnd - current.srcStart + offset / 30;

  return (
    <div className="review">
      <header>
        <span className="counter">
          カット候補 <strong>{index + 1}</strong> / {toReview.length}
        </span>
        <span className="stats">
          ✅ {counts.approved} ❌ {counts.rejected} ⏸ {counts.held}
        </span>
        <div className="pace">{history.length > 0 && <>1件 {perItem.toFixed(2)} 秒</>}</div>
      </header>

      {/*
        動画の時間軸にカット候補を重ねたバー。
        「動画のどのあたりの話か」が分かるので、後から戻るときに探しやすい。
        自動判定済みのものも薄く出して、全体像が見えるようにする。
      */}
      <nav className="timeline" aria-label="動画のタイムラインとカット候補">
        <div className="track">
          {all.map((c) => {
            const reviewIdx = reviewIndexById.get(c.id);
            const left = (c.srcStart / duration) * 100;
            const width = Math.max(0.35, ((c.srcEnd - c.srcStart) / duration) * 100);
            const decision = decisions[c.id];

            if (reviewIdx === undefined) {
              // 自動で判定済み。全体像を示すために出すが、押す対象にはしない
              const auto = c.confidence >= HIGH || c.kind === 'filler' ? 'auto-approved' : 'auto-rejected';
              return (
                <span
                  key={c.id}
                  className={`mark ${auto}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${KIND_LABEL[c.kind]} ${formatTime(c.srcStart)} 確信度${c.confidence.toFixed(2)} / 自動${auto === 'auto-approved' ? '承認' : '却下'}`}
                />
              );
            }

            const state = decision ?? 'pending';
            const label =
              `${reviewIdx + 1}件目 ${KIND_LABEL[c.kind]} ${formatTime(c.srcStart)} ` +
              `確信度${c.confidence.toFixed(2)} / ` +
              (decision
                ? decision === 'approved'
                  ? '承認'
                  : decision === 'rejected'
                    ? '却下'
                    : '保留'
                : '未処理');

            return (
              <button
                key={c.id}
                type="button"
                className={`mark review ${state} ${reviewIdx === index ? 'current' : ''}`}
                style={{ left: `${left}%`, width: `${width}%` }}
                title={label}
                aria-label={label}
                aria-current={reviewIdx === index}
                onClick={() => jumpTo(reviewIdx)}
              />
            );
          })}

          <div className="playhead" style={{ left: `${(current.srcStart / duration) * 100}%` }} />
        </div>

        <div className="ruler">
          {rulerMarks.map((sec) => (
            <span key={sec} style={{ left: `${(sec / duration) * 100}%` }}>
              {formatClock(sec)}
            </span>
          ))}
        </div>
      </nav>

      {undoNotice !== null && (
        <div className="undo-note">
          {undoNotice + 1} 件目の判定を取り消しました。この候補を表示しています
        </div>
      )}

      {undoNotice === null && revisiting && (
        <div className="revisit-note">
          {index + 1} 件目に戻って確認中 — 決定するか <kbd>Esc</kbd> で {resumeIndex + 1} 件目に戻ります
        </div>
      )}

      <section className="stage">
        <div className="preview">
          <div className="preview-placeholder">
            <p>プレビュー</p>
            <small>
              実装後はここで「カットして繋いだ結果」を自動ループ再生します。
              <br />
              判断すべきは「そこが無音か」ではなく「繋ぎが自然か」だからです（§3.3.3）
            </small>
          </div>
        </div>

        <Waveform candidate={current} />

        <div className="cutinfo">
          <span className="keep">残す 0.5s</span>
          <span className="cut">
            カット {cutLength.toFixed(2)} 秒
            {offset !== 0 && <em> （{offset > 0 ? '+' : ''}{offset}F 調整）</em>}
          </span>
          <span className="keep">残す 0.5s</span>
        </div>

        <div className="context">
          <span className="ctx">「…{current.before}」</span>
          <span className="gap">⟨{(current.srcEnd - current.srcStart).toFixed(2)}秒⟩</span>
          <span className="ctx">「{current.after}…」</span>
        </div>

        <div className="meta">
          <span className={`kind ${current.kind}`}>{KIND_LABEL[current.kind]}</span>
          {current.word && <span className="word">「{current.word}」</span>}
          <span className="time">{formatTime(current.srcStart)}</span>
          <span className="conf">
            確信度
            <span className="conf-bar">
              <span style={{ width: `${current.confidence * 100}%` }} />
            </span>
            {current.confidence.toFixed(2)}
          </span>
        </div>
      </section>

      <footer>
        <kbd>Y</kbd> 承認 <kbd>N</kbd> 却下 <kbd>Space</kbd> 再生
        <span className="sep" />
        <kbd>←</kbd>
        <kbd>→</kbd> 境界±1F <kbd>Shift</kbd>+←→ ±5F <kbd>S</kbd> 保留
        <span className="sep" />
        <kbd>[</kbd>
        <kbd>]</kbd> 前後へ移動 <kbd>U</kbd> 直前に下した判定を取消（そこへ飛びます）{' '}
        <kbd>Enter</kbd> 残り一括承認
      </footer>

      <div ref={liveRef} aria-live="polite" className="sr-only" />
    </div>
  );
}
