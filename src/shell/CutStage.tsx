/**
 * カットの段階。編集ソフトと同じ配置で、タイムライン上で直接いじる。
 *
 * 🔴 作り直しの理由（友達の指摘）:
 *    - 他の編集ソフトと違い過ぎて違和感がある
 *    - カット余白を伸ばしたりしづらい
 *
 *    以前は「候補を1件ずつ全画面で見せて Y/N を押させる」形だった。
 *    素材全体のどこを触っているのか分からず、境界の調整もボタン（←→）だけだった。
 *    ここではタイムラインを主役にして、**クリップの端をドラッグ**して伸縮する。
 *
 * 🔴 状態の形（ReviewState）は前のまま変えない。
 *    変えると、友達が保存済みの下書きが開けなくなる。
 *
 * 🔴 書き出すカットは必ず withTrim を通す。
 *    ここを通さないと境界の微調整が消え、書き出すまで気づけない。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorShell } from './EditorShell';
import { Timeline, clock, type TimelineRegion } from './Timeline';
import { Waveform } from './Waveform';
import { Filmstrip } from './Filmstrip';
import {
  KIND_LABEL,
  type CutCandidate,
  type CutKind,
  type ReviewBand,
  DEFAULT_BAND,
} from '../review/mockCandidates';
import type { PacePreset, ReviewState } from '../review/ReviewScreen';
import { mediaUrl } from './media';
import { Transport } from './Transport';
import { useEditedPlayer } from './useEditedPlayer';
import { buildSegments } from './editedTime';
import { isTyping, matchShortcut, nextShuttle } from './shortcuts';

const PACE_LABEL: Record<PacePreset, string> = {
  loose: 'ゆったり',
  talk: 'ふつう',
  short: 'テンポよく',
  tight: 'とにかく詰める',
};
const PACE_ORDER: PacePreset[] = ['loose', 'talk', 'short', 'tight'];

/** 確信度を編集の言葉に直す。「0.82」は機械学習の言葉で、編集の言葉ではない */
function certainty(v: number, band: ReviewBand): string {
  if (v >= band.high) return 'ほぼ確実に切ってよい';
  if (v >= band.low) return '判断が要る';
  return '切らない方がよさそう';
}

interface Trim {
  start: number;
  end: number;
}

/** 微調整を反映した区間。書き出しは必ずここを通す */
function withTrim(c: CutCandidate, trim: Trim | undefined, fps: number): CutCandidate {
  if (!trim || (trim.start === 0 && trim.end === 0)) return c;
  const start = Math.max(0, c.srcStart + trim.start / fps);
  const end = Math.max(start + 0.02, c.srcEnd + trim.end / fps);
  return { ...c, srcStart: Number(start.toFixed(3)), srcEnd: Number(end.toFixed(3)) };
}

export interface CutStageProps {
  candidates: CutCandidate[];
  band?: ReviewBand;
  fps?: number;
  videoPath?: string;
  videoDuration?: number;
  /** 解析で作った audio.wav。音の波を出すのに使う */
  audioPath?: string;
  /** 素材の縦横。コマの形を合わせるのに使う */
  frame?: { width: number; height: number };
  initialState?: ReviewState | null;
  onStateChange?(s: ReviewState): void;
  onExport?(approved: CutCandidate[]): void;
  onQuit?(): void;
  onChangePace?(p: PacePreset): void;
  pace?: PacePreset;
  repacing?: boolean;
  exporting?: boolean;
  /**
   * 「切って繋いだ結果」の短いクリップを作る。
   *
   * 🔴 これがこの画面の価値の中心。
   *    元の映像を前後まとめて流しても「繋ぎが自然か」は分からない。
   *    切った状態で繋がった音と絵を聞いて初めて判断できる（§3.3.3）。
   */
  onNeedClip?(c: CutCandidate): Promise<{ path: string; joinAt: number; duration: number } | null>;
}

type ClipState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; path: string; joinAt: number; duration: number };

/** 見た目の状態。切る／残す／保留の3つだけ */
type Effective = 'cut' | 'keep' | 'hold';

export function CutStage({
  candidates,
  band = DEFAULT_BAND,
  fps = 30,
  videoPath,
  videoDuration,
  audioPath,
  frame,
  initialState,
  onStateChange,
  onExport,
  onQuit,
  onChangePace,
  pace = 'talk',
  repacing,
  exporting,
  onNeedClip,
}: CutStageProps) {
  const { low: LOW, high: HIGH } = band;

  // 確信度で3分割（§3.3.1）。人が1件ずつ見るのは中間層だけ、という考え方は変えない。
  const { autoApproved, toReview, autoRejected, fillers } = useMemo(() => {
    const fillerList = candidates.filter((c) => c.kind === 'filler' && c.confidence >= LOW);
    const rest = candidates.filter((c) => !(c.kind === 'filler' && c.confidence >= LOW));
    return {
      autoApproved: rest.filter((c) => c.confidence >= HIGH),
      toReview: rest.filter((c) => c.confidence >= LOW && c.confidence < HIGH),
      autoRejected: rest.filter((c) => c.confidence < LOW),
      fillers: fillerList,
    };
  }, [candidates, LOW, HIGH]);

  const [decisions, setDecisions] = useState<Record<string, 'approved' | 'rejected' | 'held'>>(
    initialState?.decisions ?? {},
  );
  const [adjust, setAdjust] = useState<Record<string, Trim>>(initialState?.adjust ?? {});
  const [excludedFillers, setExcludedFillers] = useState<Set<string>>(
    () => new Set(initialState?.excludedFillers ?? []),
  );
  const [autoOverride, setAutoOverride] = useState<Record<string, 'cut' | 'keep'>>(
    initialState?.autoOverride ?? {},
  );
  const [manualCuts, setManualCuts] = useState(initialState?.manualCuts ?? []);
  const [history, setHistory] = useState<string[]>(initialState?.history ?? []);

  const [selected, setSelected] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [markIn, setMarkIn] = useState<number | null>(null);
  const [markOut, setMarkOut] = useState<number | null>(null);
  const clipRef = useRef<HTMLVideoElement | null>(null);
  const [clips, setClips] = useState<Record<string, ClipState>>({});

  const duration = useMemo(
    () => videoDuration ?? Math.max(60, Math.max(0, ...candidates.map((c) => c.srcEnd)) + 5),
    [videoDuration, candidates],
  );

  const byId = useMemo(() => {
    const m = new Map<string, CutCandidate>();
    for (const c of candidates) m.set(c.id, c);
    return m;
  }, [candidates]);

  /** その候補が結局どうなるか。表示も書き出しもこの判定に従う */
  const effective = useCallback(
    (c: CutCandidate): Effective => {
      if (c.kind === 'filler' && c.confidence >= LOW) {
        return excludedFillers.has(c.id) ? 'keep' : 'cut';
      }
      if (c.confidence >= HIGH) return autoOverride[c.id] === 'keep' ? 'keep' : 'cut';
      if (c.confidence < LOW) return autoOverride[c.id] === 'cut' ? 'cut' : 'keep';
      const d = decisions[c.id];
      if (d === 'approved') return 'cut';
      if (d === 'rejected') return 'keep';
      return 'hold';
    },
    [LOW, HIGH, excludedFillers, autoOverride, decisions],
  );

  /* ---------- 状態の保存 ---------- */

  // 🔴 呼び出し側の関数そのものを依存に入れない。毎描画で作り直されると無限に鳴る
  const notify = useRef(onStateChange);
  notify.current = onStateChange;
  useEffect(() => {
    notify.current?.({
      decisions,
      adjust,
      excludedFillers: [...excludedFillers],
      index: 0,
      resumeIndex: 0,
      history,
      autoOverride,
      manualCuts,
    });
  }, [decisions, adjust, excludedFillers, history, autoOverride, manualCuts]);

  /* ---------- 判定を変える ---------- */

  const decide = useCallback(
    (id: string, next: Effective) => {
      const c = byId.get(id);
      if (!c) {
        // 手で足したカットは「残す」＝削除
        if (next !== 'cut') setManualCuts((m) => m.filter((x) => x.id !== id));
        return;
      }
      setHistory((h) => [...h, id]);
      if (c.kind === 'filler' && c.confidence >= LOW) {
        setExcludedFillers((s) => {
          const n = new Set(s);
          if (next === 'cut') n.delete(id);
          else n.add(id);
          return n;
        });
        return;
      }
      if (c.confidence >= HIGH || c.confidence < LOW) {
        setAutoOverride((o) => ({ ...o, [id]: next === 'cut' ? 'cut' : 'keep' }));
        return;
      }
      setDecisions((d) => ({
        ...d,
        [id]: next === 'cut' ? 'approved' : next === 'keep' ? 'rejected' : 'held',
      }));
    },
    [byId, LOW, HIGH],
  );

  /** 直前の操作を取り消す */
  const undo = useCallback(() => {
    setHistory((h) => {
      const last = h[h.length - 1];
      if (!last) return h;
      setDecisions((d) => {
        const n = { ...d };
        delete n[last];
        return n;
      });
      setAutoOverride((o) => {
        const n = { ...o };
        delete n[last];
        return n;
      });
      setExcludedFillers((s) => {
        const n = new Set(s);
        n.delete(last);
        return n;
      });
      setSelected(last);
      setFocusId(last);
      return h.slice(0, -1);
    });
  }, []);

  /* ---------- タイムラインの区間 ---------- */

  const regions = useMemo<TimelineRegion[]>(() => {
    const out: TimelineRegion[] = candidates.map((c) => {
      const t = adjust[c.id];
      const v = withTrim(c, t, fps);
      const e = effective(c);
      return {
        id: c.id,
        start: v.srcStart,
        end: v.srcEnd,
        kind: e === 'cut' ? 'cut' : e === 'hold' ? 'hold' : 'keep',
        label: c.word ? `${KIND_LABEL[c.kind]}「${c.word}」` : KIND_LABEL[c.kind],
      };
    });
    for (const m of manualCuts) {
      const v = withTrim(
        { id: m.id, kind: 'manual', srcStart: m.srcStart, srcEnd: m.srcEnd, confidence: 1, before: '', after: '' },
        adjust[m.id],
        fps,
      );
      out.push({ id: m.id, start: v.srcStart, end: v.srcEnd, kind: 'cut', label: '手動' });
    }
    return out.sort((a, b) => a.start - b.start);
  }, [candidates, adjust, fps, effective, manualCuts]);

  /**
   * 端をドラッグし終えたとき。
   * 🔴 adjust（フレーム単位のずらし量）に直して持つこと。
   *    ここを秒のまま持つと withTrim と二重にずれる。
   */
  const onTrim = useCallback(
    (id: string, start: number, end: number) => {
      const base =
        byId.get(id) ??
        (manualCuts.find((m) => m.id === id) as { srcStart: number; srcEnd: number } | undefined);
      if (!base) return;
      setAdjust((a) => ({
        ...a,
        [id]: {
          start: Math.round((start - base.srcStart) * fps),
          end: Math.round((end - base.srcEnd) * fps),
        },
      }));
    },
    [byId, fps, manualCuts],
  );

  const nudge = useCallback(
    (edge: 'start' | 'end', frames: number) => {
      if (!selected) return;
      setAdjust((a) => {
        const cur = a[selected] ?? { start: 0, end: 0 };
        return { ...a, [selected]: { ...cur, [edge]: cur[edge] + frames } };
      });
    },
    [selected],
  );

  /* ---------- 書き出すカット ---------- */

  const approvedCuts = useMemo(
    () =>
      [
        ...autoApproved.filter((c) => autoOverride[c.id] !== 'keep'),
        ...fillers.filter((c) => !excludedFillers.has(c.id)),
        ...toReview.filter((c) => decisions[c.id] === 'approved'),
        ...autoRejected.filter((c) => autoOverride[c.id] === 'cut'),
        ...manualCuts.map((m) => ({
          id: m.id,
          kind: 'manual' as CutKind,
          srcStart: m.srcStart,
          srcEnd: m.srcEnd,
          confidence: 1,
          before: '',
          after: '',
        })),
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
      manualCuts,
    ],
  );

  const held = toReview.filter((c) => effective(c) === 'hold');
  const removedSec = approvedCuts.reduce((a, c) => a + (c.srcEnd - c.srcStart), 0);

  /* ---------- 再生 ---------- */

  /**
   * 時間軸。
   * 「元の素材」= 切る前のまま / 「カット後」= 書き出したあとと同じ並び。
   *
   * 🔴 カットを直している最中は「元の素材」が既定。
   *    カット後で見ていると、自分が今いじっている区間が消えて位置を見失う。
   */
  const [axis, setAxis] = useState<'source' | 'edited'>('source');
  const applyCuts = axis === 'edited';

  /**
   * 「カット後」で流すときに取り除く区間。
   *
   * 🔴 赤（切る）だけでなく黄色（判断待ち）も外す。
   *    まだ決めていない箇所は「切ったらこうなる」を見るためのものなので、
   *    出来上がりを確かめる側では外れていたほうが判断しやすい。
   *    ただし**書き出しに乗るのは赤だけ**。黄色は決まっていないので出力には残る。
   */
  const previewCuts = useMemo(
    () =>
      regions
        .filter((r) => r.kind === 'cut' || r.kind === 'hold')
        .map((r) => ({ srcStart: r.start, srcEnd: r.end })),
    [regions],
  );

  const player = useEditedPlayer({
    duration,
    cuts: previewCuts,
    /*
      🔴 「元の素材」で見ているときは飛ばさない。

         元の素材は、切る前がどうだったかを確かめるための目盛り。
         そこで飛ばされると、切った場所の前後がどう繋がっていたのかを
         聞き直せなくなる。飛ばすのは「カット後」を見ているときだけ。
    */
    skipCuts: axis === 'edited',
    timeBase: axis,
    reverseAudioPath: audioPath ? mediaUrl(audioPath) : null,
  });
  const { videoRef, seek } = player;
  const segments = useMemo(
    () =>
      buildSegments(
        duration,
        approvedCuts.map((c) => ({ srcStart: c.srcStart, srcEnd: c.srcEnd })),
      ),
    [duration, approvedCuts],
  );

  /** 選んだ区間の少し手前から流す。繋ぎ目は前後を見ないと判断できない */
  const playAround = useCallback(
    (id: string) => {
      const r = regions.find((x) => x.id === id);
      if (r) seek(Math.max(0, r.start - 1.2));
      player.play();
    },
    [regions, seek, player],
  );

  const select = useCallback((id: string | null) => {
    setSelected(id);
  }, []);

  /*
    選んだ箇所の「切って繋いだ結果」を用意する。
    作るのに時間がかかるので、見たいと言われた時点で作る（解析時に全部は作らない）。
  */
  useEffect(() => {
    if (!selected || !onNeedClip) return;
    const c = byId.get(selected);
    if (!c || clips[selected]) return;
    let alive = true;
    setClips((p) => ({ ...p, [selected]: { status: 'loading' } }));
    void onNeedClip(c)
      .then((r) => {
        if (!alive) return;
        setClips((p) => ({
          ...p,
          [selected]: r
            ? { status: 'ready', path: r.path, joinAt: r.joinAt, duration: r.duration }
            : { status: 'failed' },
        }));
      })
      .catch(() => {
        if (alive) setClips((p) => ({ ...p, [selected]: { status: 'failed' } }));
      });
    return () => {
      alive = false;
    };
  }, [selected, onNeedClip, byId, clips]);

  const clip = selected ? clips[selected] : undefined;

  /*
    🔴 loop 属性は使わない。必ず 0 秒に戻ってしまい、繋ぎ目の手前から流し直せない。
       繋ぎ目の少し手前へ自分で戻す。
  */
  useEffect(() => {
    const v = clipRef.current;
    if (!v || !clip || clip.status !== 'ready') return;
    const from = Math.max(0, clip.joinAt - 1.2);
    const onEnd = () => {
      v.currentTime = from;
      void v.play();
    };
    v.currentTime = from;
    void v.play().catch(() => undefined);
    v.addEventListener('ended', onEnd);
    return () => v.removeEventListener('ended', onEnd);
  }, [clip]);

  /* ---------- 手で範囲を足す ---------- */

  const addManual = useCallback(() => {
    if (markIn === null || markOut === null) return;
    const s = Math.min(markIn, markOut);
    const e = Math.max(markIn, markOut);
    if (e - s < 0.05) return;
    const id = `manual-${Date.now()}`;
    setManualCuts((m) => [
      ...m,
      { id, srcStart: Number(s.toFixed(3)), srcEnd: Number(e.toFixed(3)) },
    ]);
    setMarkIn(null);
    setMarkOut(null);
    setSelected(id);
  }, [markIn, markOut]);

  /**
   * 次（前）の判断待ちへ移る。
   *
   * 🔴 移った先を「選んで・寄って・その少し手前から流す」までやること。
   *    選ぶだけだと、結局そこまで自分でスクロールして再生し直すことになり、
   *    1件あたりの手数が減らない。この画面の目的はレビュー速度なので、
   *    1キーで「次を判断できる状態」まで持っていく。
   */
  const goPending = useCallback(
    (dir: 1 | -1) => {
      const pending = regions
        .filter((r) => r.kind === 'hold')
        .sort((a, b) => a.start - b.start);
      if (pending.length === 0) return;

      /*
        🔴 基準は「いま選んでいる箇所」にすること。再生位置ではない。

        移った先では前後の繋がりを見せるために 1.2 秒手前から流す。
        その位置を基準に次を探すと、**さっき移った箇所がまた次に見える**ので、
        ↓ を何度押しても同じところから動かない（実際にそうなった）。
      */
      const current = regions.find((r) => r.id === selected);
      const ref = current ? current.start : player.time;
      const next =
        dir === 1
          ? (pending.find((r) => r.start > ref + 0.01) ?? pending[0])
          : ([...pending].reverse().find((r) => r.start < ref - 0.01) ?? pending[pending.length - 1]);

      setSelected(next.id);
      setFocusId(next.id);
      // 前後の繋がりを見たいので、少し手前から
      player.seek(Math.max(0, next.start - 1.2));
      player.play();
    },
    [regions, player, selected],
  );

  /* ---------- キー操作（Final Cut と同じ割り当て。shortcuts.ts 参照）---------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const action = matchShortcut(e);
      if (!action) return;
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
        case 'markIn':
          setMarkIn(player.time);
          break;
        case 'markOut':
          setMarkOut(player.time);
          break;
        case 'undo':
          undo();
          break;
        case 'delete':
        case 'markKeep':
          if (selected) decide(selected, 'keep');
          break;
        case 'markCut':
          if (selected) decide(selected, 'cut');
          break;
        case 'markHold':
          if (selected) decide(selected, 'hold');
          break;
        case 'nextPending':
          goPending(1);
          break;
        case 'prevPending':
          goPending(-1);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, decide, undo, player, fps, goPending]);

  /* ---------- 手で範囲を足す（Enter / Esc）---------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (e.key === 'Enter') {
        addManual();
        e.preventDefault();
      } else if (e.key === 'Escape' && (markIn !== null || markOut !== null)) {
        // 🔴 Esc で画面を閉じない。範囲の選択をやめるだけ
        setMarkIn(null);
        setMarkOut(null);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addManual, markIn, markOut]);

  const cur = selected ? (byId.get(selected) ?? null) : null;
  const curRegion = regions.find((r) => r.id === selected) ?? null;
  const curTrim = selected ? (adjust[selected] ?? { start: 0, end: 0 }) : null;

  return (
    <EditorShell
      step="cut"
      done={['source']}
      toolbar={
        <>
          {onQuit && (
            <button className="danger" onClick={onQuit}>
              編集をやめる
            </button>
          )}
          <button onClick={undo} disabled={history.length === 0} title="Ctrl+Z">
            元に戻す
          </button>
          <button className="go" onClick={() => onExport?.(approvedCuts)} disabled={exporting}>
            {exporting ? '書き出し中…' : 'テロップへ進む →'}
          </button>
        </>
      }
      viewer={
        /*
          🔴 ビューアを空にしないこと。

          最初はここを「繋いだ結果」だけにしていたので、カットを選ぶまで
          元の映像を display:none で隠していた。編集ソフトのビューアは
          常に映像が出ているものなので、「動画が表示されない」と受け取られる。

          🔴 「繋いだ結果 / 元の映像」の切り替えは置かない。
             タイムラインの「元の素材 / カット後」と役割が被るうえ、
             承認したカットは常に飛ばすようになったので、本編を流せば
             それがそのまま繋いだ結果になる。
        */
        <>
          <video
            ref={videoRef}
            src={videoPath ? mediaUrl(videoPath) : undefined}
            style={{ width: '100%', height: '100%' }}
          />
          {!videoPath && <div className="fcp-stage-empty">映像はここに出ます</div>}
        </>
      }
      transport={
        <Transport
          player={player}
          fps={fps}
          info={
            <>
              <span className="fcp-chip">
                <span className="dot" style={{ background: 'var(--cut)' }} />
                切る {approvedCuts.length}
              </span>
              <span className="fcp-chip">
                <span className="dot" style={{ background: 'var(--hold)' }} />
                判断待ち {held.length}
              </span>
              <span className="fcp-chip">−{removedSec.toFixed(1)}秒</span>
            </>
          }
        >

        </Transport>
      }
      inspectorTitle={curRegion ? '選んだところ' : 'カット全体'}
      inspector={
        curRegion ? (
          <>
            <div className="fcp-field">
              <label>種類</label>
              <div>{curRegion.label}</div>
            </div>
            {cur && (cur.before || cur.after) && (
              <div className="fcp-field">
                <label>前後のことば</label>
                <div className="fcp-dim">
                  …{cur.before} <strong style={{ color: 'var(--sel)' }}>［ここ］</strong> {cur.after}…
                </div>
              </div>
            )}
            {cur && (
              <div className="fcp-field">
                <label>AIの見立て</label>
                <div className="fcp-dim">{certainty(cur.confidence, band)}</div>
              </div>
            )}

            <div className="fcp-field">
              <label>どうする</label>
              <div className="actions" style={{ display: 'flex', gap: 6 }}>
                <button
                  className={curRegion.kind === 'cut' ? 'on' : ''}
                  onClick={() => decide(curRegion.id, 'cut')}
                  title="D キー"
                >
                  切る
                </button>
                <button
                  className={curRegion.kind === 'keep' ? 'on' : ''}
                  onClick={() => decide(curRegion.id, 'keep')}
                  title="F キー"
                >
                  残す
                </button>
                <button
                  className={curRegion.kind === 'hold' ? 'on' : ''}
                  onClick={() => decide(curRegion.id, 'hold')}
                  title="G キー"
                >
                  あとで
                </button>
              </div>
            </div>

            <div className="fcp-field">
              <label>始まり</label>
              <div className="fcp-stepper">
                <button onClick={() => nudge('start', -1)}>−1f</button>
                <output>{clock(curRegion.start)}</output>
                <button onClick={() => nudge('start', 1)}>+1f</button>
              </div>
            </div>
            <div className="fcp-field">
              <label>終わり</label>
              <div className="fcp-stepper">
                <button onClick={() => nudge('end', -1)}>−1f</button>
                <output>{clock(curRegion.end)}</output>
                <button onClick={() => nudge('end', 1)}>+1f</button>
              </div>
            </div>
            <div className="fcp-field">
              <label>長さ</label>
              <div style={{ fontVariantNumeric: 'tabular-nums' }}>
                {(curRegion.end - curRegion.start).toFixed(2)} 秒
                {curTrim && (curTrim.start !== 0 || curTrim.end !== 0) && (
                  <span className="fcp-dim">
                    {' '}
                    （元から {curTrim.start >= 0 ? '+' : ''}
                    {curTrim.start}f / {curTrim.end >= 0 ? '+' : ''}
                    {curTrim.end}f）
                  </span>
                )}
              </div>
            </div>

            <div className="fcp-field">
              <button onClick={() => playAround(curRegion.id)}>ここから流して確かめる</button>
            </div>
            {curTrim && (curTrim.start !== 0 || curTrim.end !== 0) && (
              <button
                onClick={() =>
                  setAdjust((a) => {
                    const n = { ...a };
                    delete n[curRegion.id];
                    return n;
                  })
                }
              >
                伸縮をもとに戻す
              </button>
            )}
            <p className="fcp-dim">
              タイムラインのクリップの<strong>端をドラッグ</strong>しても伸縮できます。
              Shift でフレームの吸着が外れます。
            </p>
          </>
        ) : (
          <>
            <div className="fcp-field">
              <label>間の詰め具合</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {PACE_ORDER.map((p) => (
                  <button
                    key={p}
                    className={p === pace ? 'on' : ''}
                    disabled={repacing || !onChangePace}
                    onClick={() => onChangePace?.(p)}
                  >
                    {PACE_LABEL[p]}
                  </button>
                ))}
              </div>
              <p className="fcp-dim">
                変えると候補を作り直します（解析はやり直しません）。
                それまでに押した「切る／残す」はやり直しになります。
              </p>
            </div>

            <div className="fcp-field">
              <label>判断待ちを片づける</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => goPending(-1)} disabled={held.length === 0} title="↑ キー">
                  ↑ 前へ
                </button>
                <button onClick={() => goPending(1)} disabled={held.length === 0} title="↓ キー">
                  ↓ 次へ
                </button>
              </div>
              <p className="fcp-dim">
                <strong>↓</strong> で次の判断待ちへ移り、その少し手前から流します。
                <strong>D</strong> 切る / <strong>F</strong> 残す / <strong>G</strong> あとで。
              </p>
            </div>

            <div className="fcp-field">
              <label>いまの見込み</label>
              <div>切るところ {approvedCuts.length} 箇所</div>
              <div>短くなる分 {removedSec.toFixed(1)} 秒</div>
              <div>判断待ち {held.length} 箇所</div>
            </div>

            <div className="fcp-field">
              <label>要らない場面を丸ごと切る</label>
              <div className="fcp-dim">
                切りたいところの手前で <strong>I</strong>、終わりで <strong>O</strong>、
                <strong>Enter</strong> で足します。Esc でやめられます。
              </div>
              <div className="fcp-dim" style={{ fontVariantNumeric: 'tabular-nums' }}>
                ここから {markIn === null ? '—' : clock(markIn)} / ここまで{' '}
                {markOut === null ? '—' : clock(markOut)}
              </div>
              <button onClick={addManual} disabled={markIn === null || markOut === null}>
                この範囲を切る
              </button>
            </div>

            <p className="fcp-dim">
              タイムラインのクリップを選ぶと、ここで細かく直せます。
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
          onSelect={select}
          onTrim={onTrim}
          focusId={focusId}
          extraControls={
            <div className="fcp-axis" title="タイムラインの時間軸">
              <button className={axis === 'source' ? 'on' : ''} onClick={() => setAxis('source')}>
                元の素材
              </button>
              <button className={axis === 'edited' ? 'on' : ''} onClick={() => setAxis('edited')}>
                カット後
              </button>
            </div>
          }
          tracks={[
            {
              id: 'film',
              label: 'コマ',
              regions: [],
              height: 46,
              render: (v) => (
                <Filmstrip
                  {...v}
                  videoPath={videoPath}
                  aspect={frame ? frame.width / frame.height : 16 / 9}
                  segments={applyCuts ? segments : undefined}
                />
              ),
            },
            { id: 'cut', label: 'カット', regions, showSource: true, height: 60 },
            {
              id: 'wave',
              label: '音',
              regions: [],
              height: 54,
              render: (v) => <Waveform {...v} audioPath={audioPath} />,
            },
          ]}
        />
      }
    />
  );
}
