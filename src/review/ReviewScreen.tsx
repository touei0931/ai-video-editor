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
  DEFAULT_BAND,
  generateMockCandidates,
  KIND_LABEL,
  type CutCandidate,
  type ReviewBand,
} from './mockCandidates';
import './review.css';

type Decision = 'approved' | 'rejected' | 'held';

/** 繋ぎ目の何秒前から再生を始めるか */
const LEAD_IN = 1.2;

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

export interface ReviewScreenProps {
  /** 実データ。省略するとモックで動く（操作感の確認用） */
  candidates?: CutCandidate[];
  /**
   * 確信度の3分割の境目。解析結果に含まれる値を渡すこと。
   * ここが sidecar 側とずれると、プレビューの無い候補がレビューに出てくる。
   */
  band?: ReviewBand;
  /** 素材のフレームレート。境界の微調整を秒に換算するのに使う */
  fps?: number;
  /** 書き出しへ進む。省略すると書き出しボタンを出さない */
  onExport?: (approved: CutCandidate[]) => void;
  exporting?: boolean;
  /** 編集をやめて動画の選択に戻る */
  onQuit?: () => void;
  /** 前回の続きから始める */
  initialState?: ReviewState | null;
  /** 判定が変わるたびに呼ばれる。呼び出し側で保存する */
  onStateChange?: (state: ReviewState) => void;
}

/**
 * 作業状態。保存して再開できるようにするため、判定はここに集める。
 *
 * 🔴 解析結果（文字起こし・候補・クリップ）は作業フォルダに残るので、
 *    保存が必要なのは人間が下した判定だけ。
 */
export interface ReviewState {
  decisions: Record<string, Decision>;
  adjust: Record<string, Trim>;
  excludedFillers: string[];
  index: number;
  resumeIndex: number;
  history: string[];
}

/** 境界の微調整量（フレーム単位）。前側と後側を別々に持つ。 */
interface Trim {
  start: number;
  end: number;
}

/**
 * 微調整を反映したカット区間を返す。
 *
 * 🔴 書き出しは必ずこの関数を通すこと。
 *    以前は調整量を画面表示にしか使っておらず、
 *    「←→ を押しても書き出しに反映されない」という状態だった。
 *    しかも書き出すまで気づけない。
 */
function withTrim(c: CutCandidate, trim: Trim | undefined, fps: number): CutCandidate {
  if (!trim || (trim.start === 0 && trim.end === 0)) return c;
  const start = Math.max(0, c.srcStart + trim.start / fps);
  const end = Math.max(start + 0.02, c.srcEnd + trim.end / fps);
  return { ...c, srcStart: Number(start.toFixed(3)), srcEnd: Number(end.toFixed(3)) };
}

export function ReviewScreen({
  candidates,
  band = DEFAULT_BAND,
  fps = 30,
  onExport,
  exporting,
  onQuit,
  initialState,
  onStateChange,
}: ReviewScreenProps = {}) {
  const all = useMemo(() => candidates ?? generateMockCandidates(118), [candidates]);
  const { low: LOW, high: HIGH } = band;

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
  }, [all, LOW, HIGH]);

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

  const [index, setIndex] = useState(initialState?.index ?? 0);
  const [decisions, setDecisions] = useState<Record<string, Decision>>(
    () => initialState?.decisions ?? {},
  );
  const [adjust, setAdjust] = useState<Record<string, Trim>>(() => initialState?.adjust ?? {});
  /** 一括処理から外したフィラー（誤爆を人間が救う手段） */
  const [excludedFillers, setExcludedFillers] = useState<Set<string>>(
    () => new Set(initialState?.excludedFillers ?? []),
  );
  const [history, setHistory] = useState<string[]>(() => initialState?.history ?? []);
  const [startedAt] = useState(() => Date.now());
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  /** クリップ内の再生位置。繋ぎ目まであと何秒かを示すのに使う */
  const [clipTime, setClipTime] = useState(0);

  /**
   * 「どこまで進んだか」を覚えておく。
   * 前のほうに戻って直したあと、また最後尾から続けられるようにするため。
   * これが無いと、戻るたびに以降を全部見直すことになる。
   */
  const [resumeIndex, setResumeIndex] = useState(initialState?.resumeIndex ?? 0);
  const revisiting = index < resumeIndex;

  /** 直前の判定を取り消したときに、どれを取り消したかを知らせる */
  const [undoNotice, setUndoNotice] = useState<number | null>(null);
  /** Enter でまとめて承認した件数（完了画面で明示する） */
  const [bulkApproved, setBulkApproved] = useState(0);
  /** フィラー一覧で開いている語 */
  const [expandedWord, setExpandedWord] = useState<string | null>(null);

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

  // 判定が変わるたびに呼び出し側へ渡す。保存はそちらの責任。
  useEffect(() => {
    onStateChange?.({
      decisions,
      adjust,
      excludedFillers: [...excludedFillers],
      index,
      resumeIndex,
      history,
    });
  }, [decisions, adjust, excludedFillers, index, resumeIndex, history, onStateChange]);

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

  /**
   * 残りをまとめて承認して完了画面へ進む。
   *
   * 🔴 「完了画面に飛ぶ」だけにしてはいけない。
   *    以前は画面遷移だけで判定を記録していなかったため、
   *    「残り一括承認」と書いてあるのに**残りが全部カットされない**状態だった。
   *    後半が丸ごと未カットの動画が出てきても、数字を見ても気づけない。
   */
  const approveRest = useCallback(() => {
    const rest = toReview.slice(index).filter((c) => !decisions[c.id]);
    if (rest.length > 0) {
      setDecisions((prev) => {
        const next = { ...prev };
        for (const c of rest) next[c.id] = 'approved';
        return next;
      });
      setHistory((prev) => [...prev, ...rest.map((c) => c.id)]);
      setBulkApproved(rest.length);
    }
    setIndex(toReview.length);
  }, [toReview, index, decisions]);

  /**
   * カットの境界を1フレーム単位で動かす。
   * 前側（カットの始まり）と後側（カットの終わり）を別々に動かせないと、
   * 「語尾が切れている」「次の語の頭が切れている」のどちらも直せない。
   */
  const nudge = useCallback(
    (side: 'start' | 'end', frames: number) => {
      if (!current) return;
      setAdjust((prev) => {
        const t = prev[current.id] ?? { start: 0, end: 0 };
        return { ...prev, [current.id]: { ...t, [side]: t[side] + frames } };
      });
    },
    [current],
  );

  /**
   * 繋ぎ目の少し手前まで巻き戻す。
   * クリップを長くすると前後の会話は分かるようになるが、
   * 「繋ぎが自然か」だけをもう一度確かめたいときにループを待つのは無駄なので、
   * 肝心の部分へ直接飛べるようにする。
   */
  const replayJoin = useCallback(() => {
    const video = videoRef.current;
    if (!video || !current?.clipJoinAt) return;
    video.currentTime = Math.max(0, current.clipJoinAt - LEAD_IN);
    void video.play();
  }, [current]);

  /**
   * 🔴 クリップの先頭からではなく、繋ぎ目の少し手前から再生を始める。
   *    先頭から流すと繋ぎ目に着くまで 2.5 秒待つことになり、
   *    「1件2.2秒で判断する」という目標が物理的に成立しない。
   *    前の会話は 1.2 秒も聞けば文脈は分かる。
   */
  const onClipReady = useCallback(
    (e: React.SyntheticEvent<HTMLVideoElement>) => {
      const at = current?.clipJoinAt ?? 0;
      if (at > 0) e.currentTarget.currentTime = Math.max(0, at - LEAD_IN);
      void e.currentTarget.play().catch(() => undefined);
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
          nudge(e.shiftKey ? 'end' : 'start', -1);
          break;
        case 'arrowright':
          nudge(e.shiftKey ? 'end' : 'start', 1);
          break;
        case ' ':
          // 自動でループしているので、Space は一時停止/再開に使う
          if (videoRef.current) {
            if (videoRef.current.paused) void videoRef.current.play();
            else videoRef.current.pause();
          }
          break;
        case 'r':
          replayJoin();
          break;
        case 'enter':
          approveRest();
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
  }, [decide, undo, nudge, jumpTo, replayJoin, approveRest, index, revisiting, resumeIndex, toReview.length]);

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

  /** フィラーは語ごとにまとめて扱う。1件ずつ見るには件数が多すぎる。 */
  const fillerGroups = useMemo(() => {
    const map = new Map<string, CutCandidate[]>();
    for (const c of fillers) {
      const key = c.word ?? '(不明)';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [fillers]);

  const toggleFiller = useCallback((id: string) => {
    setExcludedFillers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleFillerWord = useCallback(
    (word: string, turnOn: boolean) => {
      setExcludedFillers((prev) => {
        const next = new Set(prev);
        for (const c of fillers) {
          if ((c.word ?? '(不明)') !== word) continue;
          if (turnOn) next.delete(c.id);
          else next.add(c.id);
        }
        return next;
      });
    },
    [fillers],
  );

  const revisitHeld = useCallback(() => {
    const target = toReview.findIndex((c) => decisions[c.id] === 'held');
    if (target >= 0) {
      setResumeIndex(toReview.length);
      setIndex(target);
      setFinishedAt(null);
    }
  }, [toReview, decisions]);

  /**
   * 実際に書き出すカット。
   * 🔴 必ず withTrim を通す。ここを通さないと境界の微調整が消える。
   */
  const approvedCuts = useMemo(
    () =>
      [
        ...autoApproved,
        ...fillers.filter((c) => !excludedFillers.has(c.id)),
        ...toReview.filter((c) => decisions[c.id] === 'approved'),
      ].map((c) => withTrim(c, adjust[c.id], fps)),
    [autoApproved, fillers, excludedFillers, toReview, decisions, adjust, fps],
  );

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

        {bulkApproved > 0 && (
          <p className="note">Enter で残り {bulkApproved} 件をまとめて承認しました。</p>
        )}

        {/*
          フィラーの一括処理は確認できないと危ない。
          「あの」は「**あの**人が言ってた」の「あの」も拾うので、
          全部落とすと文が壊れる。語ごとにまとめて外せるようにする。
        */}
        {fillerGroups.length > 0 && (
          <section className="fillers">
            <h2>フィラーの一括カット</h2>
            <p className="note">
              語ごとにまとめて外せます。「あの」「その」は指示語と紛らわしいので、
              おかしければ外してください。
            </p>
            <ul>
              {fillerGroups.map(([word, items]) => {
                const on = items.filter((c) => !excludedFillers.has(c.id)).length;
                return (
                  <li key={word}>
                    <label className="group">
                      <input
                        type="checkbox"
                        checked={on > 0}
                        onChange={() => toggleFillerWord(word, on === 0)}
                      />
                      <span className="word">{word}</span>
                      <span className="count">
                        {on}/{items.length} 件をカット
                      </span>
                    </label>
                    <button
                      type="button"
                      className="link"
                      onClick={() => setExpandedWord(expandedWord === word ? null : word)}
                    >
                      {expandedWord === word ? '閉じる' : '1件ずつ見る'}
                    </button>
                    {expandedWord === word && (
                      <ul className="instances">
                        {items.map((c) => (
                          <li key={c.id}>
                            <label>
                              <input
                                type="checkbox"
                                checked={!excludedFillers.has(c.id)}
                                onChange={() => toggleFiller(c.id)}
                              />
                              <span className="time">{formatTime(c.srcStart)}</span>
                              <span className="ctx">
                                …{c.before}
                                <em>{word}</em>
                                {c.after}…
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {counts.held > 0 && (
          <p className="warn">
            保留が {counts.held} 件あります。保留はカットされません。
            <button className="link" onClick={revisitHeld}>
              最初の保留を見る
            </button>
          </p>
        )}

        <p className="note">
          ここで押した Y / N が、そのまま「あなたのカットの好み」の学習データになります（§12）。
          使うほど自動承認の範囲が広がり、確認する件数が減っていく設計です。
        </p>

        <div className="actions">
          {onExport && (
            <button
              className="primary"
              disabled={exporting}
              onClick={() => onExport(approvedCuts)}
            >
              {exporting ? '処理中…' : `${approvedCuts.length} 箇所をカットしてテロップへ進む`}
            </button>
          )}
          {onQuit && <button onClick={onQuit}>編集をやめる</button>}
        </div>
      </div>
    );
  }

  const trim = adjust[current.id];
  // 実際に書き出される区間。表示と書き出しで同じ関数を通す。
  const trimmed = withTrim(current, trim, fps);
  const cutLength = trimmed.srcEnd - trimmed.srcStart;
  const trimmedFrames = (trim?.start ?? 0) !== 0 || (trim?.end ?? 0) !== 0;
  const joinAt = current.clipJoinAt ?? 0;
  const clipDuration = current.clipDuration ?? 0;

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
        {onQuit && (
          <button className="quit" onClick={onQuit} title="動画の選択に戻ります">
            編集をやめる
          </button>
        )}
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
          {current.clipPath ? (
            <div className="preview-box">
              <video
                ref={videoRef}
                key={current.id}
                className="preview-video"
                src={`media://local/${encodeURIComponent(current.clipPath.replace(/\\/g, '/'))}`}
                autoPlay
                loop
                playsInline
                onLoadedMetadata={onClipReady}
                onTimeUpdate={(e) => setClipTime(e.currentTarget.currentTime)}
              />

              {/*
                クリップは「切って繋いだ結果」なので、繋ぎ目がどこかを示さないと
                「今の違和感はカットのせいか、元からか」が分からない。
              */}
              {clipDuration > 0 && (
                <div className="clipbar" aria-hidden>
                  <span className="clip-played" style={{ width: `${(clipTime / clipDuration) * 100}%` }} />
                  {joinAt > 0 && (
                    <span className="clip-join" style={{ left: `${(joinAt / clipDuration) * 100}%` }} />
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="preview-placeholder">
              <p>プレビュー</p>
              <small>
                この候補のクリップがありません。
                <br />
                （モックデータで動かしているか、生成に失敗しています）
              </small>
            </div>
          )}
        </div>

        {/* 波形はまだ実データが無い。実クリップがあるときに出すと嘘の情報になる。 */}
        {!current.clipPath && <Waveform candidate={current} />}

        <div className="cutinfo">
          {joinAt > 0 ? (
            <>
              <span className="keep">カット前 {joinAt.toFixed(1)}秒</span>
              <span className="cut">
                ここで {cutLength.toFixed(2)} 秒カット
                {trimmedFrames && (
                  <em>
                    {' '}
                    （始まり {trim!.start > 0 ? '+' : ''}
                    {trim!.start}F / 終わり {trim!.end > 0 ? '+' : ''}
                    {trim!.end}F）
                  </em>
                )}
              </span>
              <span className="keep">カット後 {(clipDuration - joinAt).toFixed(1)}秒</span>
            </>
          ) : (
            <span className="cut">
              カット {cutLength.toFixed(2)} 秒
              {trimmedFrames && (
                <em>
                  {' '}
                  （始まり {trim!.start > 0 ? '+' : ''}
                  {trim!.start}F / 終わり {trim!.end > 0 ? '+' : ''}
                  {trim!.end}F）
                </em>
              )}
            </span>
          )}
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
        <kbd>Y</kbd> 承認 <kbd>N</kbd> 却下 <kbd>Space</kbd> 一時停止 <kbd>R</kbd> 繋ぎ目から再生
        <span className="sep" />
        <kbd>←</kbd>
        <kbd>→</kbd> カット始まり±1F <kbd>Shift</kbd>+←→ 終わり±1F <kbd>S</kbd> 保留
        <span className="sep" />
        <kbd>[</kbd>
        <kbd>]</kbd> 前後へ移動 <kbd>U</kbd> 直前判定を取消 <kbd>Enter</kbd> 残り一括承認
      </footer>

      <div ref={liveRef} aria-live="polite" className="sr-only" />
    </div>
  );
}
