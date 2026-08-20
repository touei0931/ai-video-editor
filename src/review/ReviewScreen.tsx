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
import { shouldIgnoreKey } from '../keys';
import { AutoCutPreview, type AutoCutItem } from './AutoCutPreview';
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

/**
 * 確信度を言葉にする。
 *
 * 🔴 「確信度 0.82」は機械学習の言葉で、編集の言葉ではない。
 *    0.82 が高いのか低いのか、画面を見た人には判断できない。
 *    数字はツールチップに残す（開発時の切り分けには要る）。
 */
function confidenceLabel(value: number): string {
  if (value >= 0.9) return 'かなり高い';
  if (value >= 0.8) return '高い';
  if (value >= 0.7) return 'ふつう';
  return '低い';
}

/** 「2分15秒」のように、長さとして読める形 */
function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}分${String(s).padStart(2, '0')}秒` : `${s}秒`;
}

/** 目盛り用。秒は切り捨てて mm:ss */
function formatClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/*
  🔴 偽の波形は置かない。

  ここには以前 Waveform という表示があった。擬似乱数で棒を描き、
  **中央の約1/3を必ず赤く塗る**——つまり「そこは無音です」と主張していた。
  実際の音声とは何の関係も無い。

  さらに悪いのは表示条件で、`!current.clipPath` のときだけ出していた。
  clipPath が無いのは**クリップ生成に失敗した候補**、つまり
  判断材料が何も無い候補。そこにだけ捏造された根拠が出て、人はYを押す。

  実波形を出すなら work_dir/audio.wav からピーク列を作ればよい。
  それまでは、何も出さないほうが安全。
*/

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
  /**
   * 元素材。自動で決めたカットを通しで確認するのに使う。
   * 省略すると（モックで動かしているとき）通し確認は出さない。
   */
  videoPath?: string;
  /** 素材の長さ（秒）。候補から推測した値ではなく実際の長さを渡すこと */
  videoDuration?: number;
  frame?: { width: number; height: number };
  /** 書き出しへ進む。省略すると書き出しボタンを出さない */
  onExport?: (approved: CutCandidate[]) => void;
  exporting?: boolean;
  /** 編集をやめて動画の選択に戻る */
  onQuit?: () => void;
  /** 前回の続きから始める */
  initialState?: ReviewState | null;
  /** 判定が変わるたびに呼ばれる。呼び出し側で保存する */
  onStateChange?: (state: ReviewState) => void;
  /**
   * 自動判定した箇所のプレビューを作る。
   * 解析時にクリップを作るのは人間が1件ずつ見る候補だけなので、
   * 自動分は見たいと言われた時点で作る。
   */
  onNeedClip?: (
    c: CutCandidate,
  ) => Promise<{ path: string; joinAt: number; duration: number } | null>;
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
  /**
   * 自動で判定した箇所を、人間がひっくり返した分。
   *
   * 🔴 decisions とは別に持つ。混ぜると
   *    「人間が1件ずつ確認した件数」「1件あたりの所要時間」が狂う。
   *    あの数字はレビューが速くなっているかを見るためのものなので、
   *    あとから一覧でまとめて直した分を混ぜると意味を失う。
   */
  autoOverride?: Record<string, AutoOverride>;
}

/** 'cut' = 自動では見送ったが切る / 'keep' = 自動では切ったが残す */
type AutoOverride = 'cut' | 'keep';

/** 自動判定分のプレビュー。必要になった時点で作るので、状態を持つ */
type ClipState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; path: string; joinAt: number; duration: number };

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
  videoPath,
  videoDuration,
  frame,
  onExport,
  exporting,
  onQuit,
  initialState,
  onStateChange,
  onNeedClip,
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
  /** 自動判定をひっくり返した分 */
  const [autoOverride, setAutoOverride] = useState<Record<string, AutoOverride>>(
    () => initialState?.autoOverride ?? {},
  );
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
  /** 「残りをまとめてカット」の確認中。件数を持つ */
  const [confirmRest, setConfirmRest] = useState<number | null>(null);
  /**
   * 自動判定を通しで確認している最中か。
   * 🔴 キー操作の効果と関わるので、キーの登録より前で宣言すること。
   */
  const [autoPreview, setAutoPreview] = useState(false);

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
      autoOverride,
    });
  }, [
    decisions,
    adjust,
    excludedFillers,
    index,
    resumeIndex,
    history,
    autoOverride,
    onStateChange,
  ]);

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
  const approveRest = useCallback((confirmed = false) => {
    const rest = toReview.slice(index).filter((c) => !decisions[c.id]);
    /*
      🔴 まとめてカットする前に必ず確認する。
         Enter は文字入力もダイアログも無いこの画面で最も押されやすいキーで、
         300件の3件目で誤爆すると残り297件が全部カットに確定する。
         取り消しは1件ずつしか戻せないので、実質復帰できない。
    */
    if (!confirmed && rest.length > 3) {
      setConfirmRest(rest.length);
      return;
    }
    setConfirmRest(null);
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
      // 通し確認を開いている間は、そちらのキー操作だけが効くようにする。
      // ここに届くと、見えていない候補の判定が裏で書き換わる。
      if (autoPreview) return;
      // 🔴 文字入力・ボタン操作のキーは奪わない（src/keys.ts 参照）。
      //    完了画面のチェックボックスが Space で切り替わらず、
      //    ボタンに focus して Enter を押すと一括承認が走っていた。
      if (shouldIgnoreKey(e)) return;
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
          // 確認が出ているなら、そこで Enter は「はい」
          approveRest(confirmRest !== null);
          break;
        case '[':
          if (done) return;
          jumpTo(index - 1);
          break;
        case ']':
          if (done) return;
          jumpTo(index + 1);
          break;
        case 'escape':
          if (confirmRest !== null) {
            setConfirmRest(null);
            break;
          }
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
  }, [
    decide,
    undo,
    nudge,
    jumpTo,
    replayJoin,
    approveRest,
    index,
    revisiting,
    resumeIndex,
    toReview.length,
    autoPreview,
    confirmRest,
    done,
  ]);

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

  /**
   * 自動でこう決めました、を人間がひっくり返す。
   *
   * 🔴 自動判定を確認できて、かつ戻せること。
   *    確信度が高い＝正しい、ではない。無音が長いだけで
   *    「間を取っているところ」も高い確信度で切る。
   *    確認できないと、書き出した動画を見て初めて気づくことになる。
   */
  const toggleAuto = useCallback((id: string, value: AutoOverride | null) => {
    setAutoOverride((prev) => {
      const next = { ...prev };
      if (value === null) delete next[id];
      else next[id] = value;
      return next;
    });
  }, []);

  /** フィラー一覧のプレビュー。一度作ったら覚えておく */
  const [clips, setClips] = useState<Record<string, ClipState>>({});
  const [playingId, setPlayingId] = useState<string | null>(null);

  const playAuto = useCallback(
    async (c: CutCandidate) => {
      // 開いているものをもう一度押したら閉じる
      if (playingId === c.id) {
        setPlayingId(null);
        return;
      }
      setPlayingId(c.id);

      if (clips[c.id]?.status === 'ready' || clips[c.id]?.status === 'loading') return;
      if (!onNeedClip) {
        setClips((p) => ({ ...p, [c.id]: { status: 'failed' } }));
        return;
      }

      setClips((p) => ({ ...p, [c.id]: { status: 'loading' } }));
      try {
        const clip = await onNeedClip(c);
        setClips((p) => ({
          ...p,
          [c.id]: clip
            ? { status: 'ready', path: clip.path, joinAt: clip.joinAt, duration: clip.duration }
            : { status: 'failed' },
        }));
      } catch {
        setClips((p) => ({ ...p, [c.id]: { status: 'failed' } }));
      }
    },
    [clips, onNeedClip, playingId],
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
   * 🔴 autoOverride を必ず見る。一覧で「残す」に直したのに切られていたら、
   *    確認できるようにした意味がない。
   */
  const approvedCuts = useMemo(
    () =>
      [
        ...autoApproved.filter((c) => autoOverride[c.id] !== 'keep'),
        ...fillers.filter((c) => !excludedFillers.has(c.id)),
        ...toReview.filter((c) => decisions[c.id] === 'approved'),
        ...autoRejected.filter((c) => autoOverride[c.id] === 'cut'),
      ]
        .sort((a, b) => a.srcStart - b.srcStart)
        .map((c) => withTrim(c, adjust[c.id], fps)),
    [
      autoApproved,
      autoRejected,
      autoOverride,
      fillers,
      excludedFillers,
      toReview,
      decisions,
      adjust,
      fps,
    ],
  );

  /** 自動判定を人間が直した件数。直した事実は完了画面に出す */
  const overrideCounts = useMemo(() => {
    const v = Object.values(autoOverride);
    return {
      keep: v.filter((o) => o === 'keep').length,
      cut: v.filter((o) => o === 'cut').length,
    };
  }, [autoOverride]);

  /**
   * 通し確認に渡す、自動で決めた分。
   * 自動でカットした分・フィラー・自動で見送った分をひとつに並べる。
   * 人から見れば「自分が判断していない箇所」であることは同じなので、分ける意味がない。
   */
  const autoItems = useMemo<AutoCutItem[]>(
    () =>
      [
        ...autoApproved.map((c) => ({ ...c, cut: autoOverride[c.id] !== 'keep', auto: true })),
        ...fillers.map((c) => ({ ...c, cut: !excludedFillers.has(c.id), auto: true })),
        ...autoRejected.map((c) => ({ ...c, cut: autoOverride[c.id] === 'cut', auto: false })),
      ].sort((a, b) => a.srcStart - b.srcStart),
    [autoApproved, fillers, autoRejected, autoOverride, excludedFillers],
  );

  /** 通し確認では触らせない分（人が1件ずつ判断したもの）。再生には反映する */
  const fixedCuts = useMemo(
    () =>
      toReview
        .filter((c) => decisions[c.id] === 'approved')
        .map((c) => withTrim(c, adjust[c.id], fps)),
    [toReview, decisions, adjust, fps],
  );

  /**
   * 通し確認から切る/戻すを切り替える。
   * どこに記録するかは候補の出どころで変わるので、ここで振り分ける。
   */
  const autoIndex = useMemo(() => {
    const map = new Map<string, 'approved' | 'filler' | 'rejected'>();
    for (const c of autoApproved) map.set(c.id, 'approved');
    for (const c of fillers) map.set(c.id, 'filler');
    for (const c of autoRejected) map.set(c.id, 'rejected');
    return map;
  }, [autoApproved, fillers, autoRejected]);

  const toggleAutoItem = useCallback(
    (id: string) => {
      const from = autoIndex.get(id);
      if (from === 'filler') {
        toggleFiller(id);
      } else if (from === 'approved') {
        toggleAuto(id, autoOverride[id] === 'keep' ? null : 'keep');
      } else if (from === 'rejected') {
        toggleAuto(id, autoOverride[id] === 'cut' ? null : 'cut');
      }
    },
    [autoIndex, toggleFiller, toggleAuto, autoOverride],
  );

  /** 元素材が無いと通しで流せない（モックで動かしているとき） */
  const canPreviewAuto = Boolean(videoPath && videoDuration && frame);

  if (autoPreview && videoPath && videoDuration && frame) {
    return (
      <AutoCutPreview
        videoPath={videoPath}
        duration={videoDuration}
        frame={frame}
        fixedCuts={fixedCuts}
        items={autoItems}
        onToggle={toggleAutoItem}
        onClose={() => setAutoPreview(false)}
      />
    );
  }

  if (done) {
    return (
      <div className="review done">
        <h1>カットが決まりました</h1>
        {/*
          🔴 開発の目標値を画面に出さない。
             「1件あたり 0.03 秒／目標は 2.2〜2.5 秒」は作者が速度を測るための数字で、
             使う人には意味がない。しかも下書きから再開すると必ず嘘の値になる。
             人が知りたいのは「何箇所切って、どれだけ短くなるか」。
        */}
        <p className="lead">
          <strong>{approvedCuts.length} 箇所</strong>をカットします
          <span className="muted">
            {' '}
            （合わせて {formatDuration(approvedCuts.reduce((a, c) => a + (c.srcEnd - c.srcStart), 0))}
            ぶん短くなります）
          </span>
        </p>

        <dl className="summary">
          <dt>あなたが1件ずつ確認した分</dt>
          <dd>
            <strong>{toReview.length} 件</strong>
            <span className="muted">
              {' '}
              （切る {counts.approved} / 残す {counts.rejected} / あとで見る {counts.held}）
            </span>
          </dd>
          <dt>AIが自信を持って切った分</dt>
          <dd>
            {autoApproved.length} 件
            {overrideCounts.keep > 0 && (
              <span className="muted"> （うち {overrideCounts.keep} 件を残す設定に変更）</span>
            )}
          </dd>
          <dt>「えー」「あの」などのまとめ処理</dt>
          <dd>{fillers.length} 件</dd>
          <dt>AIが迷って切らなかった分</dt>
          <dd>
            {autoRejected.length} 件
            {overrideCounts.cut > 0 && (
              <span className="muted"> （うち {overrideCounts.cut} 件をカットに変更）</span>
            )}
          </dd>
          <dt>見つかった候補の合計</dt>
          <dd>{all.length} 件</dd>
        </dl>

        {bulkApproved > 0 && (
          <p className="note">残り {bulkApproved} 件は、まとめてカットにしました。</p>
        )}

        {/*
          🔴 自動で決めた分を通しで確かめられるようにする。
             「確信度が高いから正しい」ではない。長い無音は確信度が高く出るが、
             そこが「間を取っている箇所」であることは普通にある。

          1件ずつクリップを開く形はやめた。数十件を1本ずつ開いて閉じるのでは、
          「人が見なくて済むようにした」意味が消える。通しで流したほうが速い。
        */}
        {canPreviewAuto && autoItems.length > 0 && (
          <section className="autocheck">
            <div className="head">
              <h2>自動で決めたカット</h2>
              <span className="count">
                {autoItems.filter((i) => i.cut).length}/{autoItems.length} 箇所をカット
              </span>
              {overrideCounts.keep + overrideCounts.cut > 0 && (
                <span className="changed">
                  {overrideCounts.keep + overrideCounts.cut} 件を手で直しました
                </span>
              )}
            </div>
            <p className="note">
              あなたが1件ずつ見ていない箇所です。通しで流しながら、
              おかしいと思ったところだけシークバーの印を押して戻せます。
            </p>
            <button onClick={() => setAutoPreview(true)}>通しで確認する</button>
          </section>
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
                        {items.map((c) => {
                          const clip = clips[c.id];
                          const playing = playingId === c.id;
                          return (
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
                              {onNeedClip && (
                                <button
                                  type="button"
                                  className="link"
                                  onClick={() => void playAuto(c)}
                                >
                                  {playing ? '閉じる' : '見る'}
                                </button>
                              )}
                              {playing && (
                                <div className="rowclip">
                                  {clip?.status === 'loading' && (
                                    <span className="muted">プレビューを作っています…</span>
                                  )}
                                  {clip?.status === 'failed' && (
                                    <span className="error">プレビューを作れませんでした</span>
                                  )}
                                  {clip?.status === 'ready' && (
                                    <video
                                      key={clip.path}
                                      src={`media://local/${encodeURIComponent(clip.path.replace(/\\/g, '/'))}`}
                                      autoPlay
                                      loop
                                      playsInline
                                      controls
                                      onLoadedMetadata={(e) => {
                                        e.currentTarget.currentTime = Math.max(
                                          0,
                                          clip.joinAt - LEAD_IN,
                                        );
                                        void e.currentTarget.play().catch(() => undefined);
                                      }}
                                    />
                                  )}
                                </div>
                              )}
                            </li>
                          );
                        })}
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
            「あとで見る」が {counts.held} 件あります。このままだとカットされません。
            <button className="link" onClick={revisitHeld}>
              最初の1件を見る
            </button>
          </p>
        )}

        {/*
          🔴 まだ作っていない機能を約束しない。
             ここには以前「押した Y / N が学習データになります（§12）。使うほど確認する
             件数が減っていく設計です」と書いてあった。学習は未実装で、
             設計書の章番号までそのまま画面に出ていた。
             実装したときに、実際に効いている数字と一緒に書けばよい。
        */}

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

      {/*
        まとめてカットする前の確認。
        取り消しは1件ずつしか戻せないので、誤爆すると実質復帰できない。
      */}
      {confirmRest !== null && (
        <div className="confirm-rest" role="alertdialog" aria-live="assertive">
          <span>
            残り <strong>{confirmRest}</strong> 箇所を、確認せずにすべてカットします。
            よろしいですか？
          </span>
          <button className="primary" onClick={() => approveRest(true)} autoFocus>
            すべてカットする
          </button>
          <button onClick={() => setConfirmRest(null)}>やめる（Esc）</button>
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
                playsInline
                onLoadedMetadata={onClipReady}
                /*
                  🔴 loop 属性は使わない。必ず 0 秒に戻ってしまう。
                     onLoadedMetadata は初回しか発火しないので、
                     繋ぎ目の手前から始まるのは**最初の1周だけ**だった。
                     2周目以降は先頭から流れ、繋ぎ目まで 2.5 秒待たされる。
                     「1件2.2秒で判断する」という目標は、判断に3.7秒かかった時点で崩れる。
                */
                onEnded={replayJoin}
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
              <p>この箇所は再生できません</p>
              <small>
                プレビューを作れませんでした。
                <br />
                前後の文だけで判断するか、迷ったら「ここは残す」を選んでください。
              </small>
            </div>
          )}
        </div>

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
          <span className="conf" title={`AIの確信度 ${current.confidence.toFixed(2)}`}>
            AIの自信
            <span className="conf-bar">
              <span style={{ width: `${current.confidence * 100}%` }} />
            </span>
            {confidenceLabel(current.confidence)}
          </span>
        </div>
      </section>

      {/*
        🔴 押せるボタンを置くこと。
           以前はキー操作しか無く、この画面に押せるものは「編集をやめる」だけだった。
           マウスしか使わない人の出口はメニューを1件ずつ開閉するか、
           「残りをまとめてカット」＝全部承認しかなかった。
           キーは速いが、キーしか無いのは「操作できる」とは言わない。
      */}
      <div className="decide">
        <button className="cut-it" onClick={() => decide('approved')}>
          ここを切る <kbd>Y</kbd>
        </button>
        <button className="keep-it" onClick={() => decide('rejected')}>
          ここは残す <kbd>N</kbd>
        </button>
        <button className="hold-it" onClick={() => decide('held')}>
          あとで見る <kbd>S</kbd>
        </button>
        <span className="spacer" />
        <button className="minor" onClick={undo} disabled={history.length === 0}>
          ひとつ戻す <kbd>U</kbd>
        </button>
        <button className="minor" onClick={replayJoin}>
          繋ぎ目から <kbd>R</kbd>
        </button>
        <button className="minor" onClick={() => approveRest()}>
          残りを全部切る <kbd>Enter</kbd>
        </button>
      </div>

      <footer>
        <kbd>←</kbd>
        <kbd>→</kbd> カットの始まりを1コマ動かす <kbd>Shift</kbd>+←→ 終わりを1コマ動かす
        <span className="sep" />
        <kbd>Space</kbd> 一時停止 <kbd>[</kbd>
        <kbd>]</kbd> 前後の候補へ
      </footer>

      <div ref={liveRef} aria-live="polite" className="sr-only" />
    </div>
  );
}
