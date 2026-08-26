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
import { buildSegments, toOutput, toSource } from './editedTime';
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

  /*
    確信度の3分割（§3.3.1）。人が1件ずつ見るのは中間層だけ、という考え方は変えない。
    どの層に入るかは effective() と decide() の中で見る。
  */
  const [decisions, setDecisions] = useState<Record<string, 'approved' | 'rejected' | 'held'>>(
    initialState?.decisions ?? {},
  );
  const [adjust, setAdjust] = useState<Record<string, Trim>>(initialState?.adjust ?? {});
  const [excludedFillers, setExcludedFillers] = useState<Set<string>>(
    () => new Set(initialState?.excludedFillers ?? []),
  );
  const [autoOverride, setAutoOverride] = useState<Record<string, 'cut' | 'keep' | 'hold'>>(
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

  /**
   * その候補が結局どうなるか。表示も書き出しもこの判定に従う。
   *
   * 🔴 人が指定した分を最初に見ること。
   *    以前は「自動で決まった箇所」を先に判定していたので、
   *    そこで G（保留）を押しても保留にならず「残す」になっていた。
   *    保留は**どの箇所にも付けられる**べき状態（あとで見直す、の意味）。
   */
  const effective = useCallback(
    (c: CutCandidate): Effective => {
      const ov = autoOverride[c.id];
      if (ov === 'cut' || ov === 'keep' || ov === 'hold') return ov;

      // 指定が無いときの既定
      if (c.kind === 'filler' && c.confidence >= LOW) {
        return excludedFillers.has(c.id) ? 'keep' : 'cut';
      }
      if (c.confidence >= HIGH) return 'cut';
      if (c.confidence < LOW) return 'keep';
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

      /*
        人が1件ずつ見る中間層だけ decisions に書く。
        「何件を人が確認したか」「1件あたり何秒か」の数字がここから出るので、
        自動で決まった分の直しを混ぜると意味を失う。
      */
      const inReviewBand =
        !(c.kind === 'filler' && c.confidence >= LOW) && c.confidence >= LOW && c.confidence < HIGH;

      if (inReviewBand) {
        setDecisions((d) => ({
          ...d,
          [id]: next === 'cut' ? 'approved' : next === 'keep' ? 'rejected' : 'held',
        }));
        return;
      }
      // それ以外（自動で決まった分・フィラー）は上書きとして持つ。保留も付けられる
      setAutoOverride((o) => ({ ...o, [id]: next }));
    },
    [byId, LOW, HIGH],
  );

  /**
   * 直前の操作を取り消す。
   *
   * 🔴 戻したことを言葉で出すこと。
   *    黙って状態だけ戻すと、**本当に1つ戻ったのか**が分からない。
   *    どこを戻したのかも選び直して見せる。
   */
  const undo = useCallback(() => {
    setHistory((h) => {
      const last = h[h.length - 1];
      if (!last) {
        setNotice('これ以上戻せません');
        return h;
      }
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
      const c = byId.get(last);
      setNotice(
        `1つ戻しました：${c ? (c.word ? `${KIND_LABEL[c.kind]}「${c.word}」` : KIND_LABEL[c.kind]) : '手動のカット'}`,
      );
      return h.slice(0, -1);
    });
  }, [byId]);

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

  /**
   * 実際に書き出すカット。
   *
   * 🔴 画面に出している判定（effective）と同じ関数から作ること。
   *    別々に組み立てると、赤く見えているのに切られない（逆も）が起きる。
   *    しかも書き出すまで気づけない。
   *
   * 🔴 保留は「まだ決めていない」なので切らない。
   *    自動で切る判断だったものを保留にした場合も、ここでは切らずに残す。
   */
  const approvedCuts = useMemo(
    () =>
      [
        ...candidates.filter((c) => effective(c) === 'cut'),
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
    [candidates, effective, manualCuts, adjust, fps],
  );

  const held = candidates.filter((c) => effective(c) === 'hold');

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
   * 🔴 赤（切る）だけでなく保留も外す。
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
  /** 「カット後」で見るときの残る区間。プレビューと同じ区切りを使う */
  const segments = useMemo(() => buildSegments(duration, previewCuts), [duration, previewCuts]);

  /**
   * タイムラインに置く区間を、いま見ている目盛りに合わせる。
   *
   * 🔴 白い線と帯は必ず同じ時刻で描くこと。
   *    以前は白い線だけ出来上がりの時刻、帯は元素材の時刻のままだった。
   *    再生するほど両者がずれていき、どこを見ているのか分からなくなる。
   *
   * 「カット後」では、外した箇所そのものは出来上がりに存在しない。
   * 消してしまうと「どこで切ったか」が分からなくなるので、
   * 繋ぎ目の細い印として残す（掴んで伸縮はできない）。
   */
  const displayRegions = useMemo<TimelineRegion[]>(() => {
    if (axis === 'source' || segments.length === 0) return regions;

    /*
      カットを「非表示」にしているときは、**残っている素材そのもの**を並べる。

      🔴 残る区間をクリップとして出すこと。
         切る区間を細い印にしただけだと、掴めるのは「切る所」しかない。
         編集ソフトでカットを戻すのは、**残っている側の端を伸ばす**操作。
         残る区間が掴めて初めて、その操作ができる。
    */
    const out: TimelineRegion[] = [];
    let acc = 0;
    segments.forEach((sg, i) => {
      const len = sg.srcEnd - sg.srcStart;
      out.push({
        id: `seg-${i}`,
        start: Number(acc.toFixed(3)),
        end: Number((acc + len).toFixed(3)),
        kind: 'keep',
        label: '',
      });
      acc += len;
      // 切れ目の印。掴みたい端の真上に来るので、触れないようにする（decor）
      if (i < segments.length - 1) {
        out.push({
          id: `join-${i}`,
          start: Number(acc.toFixed(3)),
          end: Number((acc + 6 / 40).toFixed(3)),
          kind: 'cut',
          label: '',
          fixed: true,
          decor: true,
        });
      }
    });
    return out;
  }, [regions, axis, segments]);

  /**
   * 切れ目に接しているカットの端を、秒単位で動かす。
   *
   * 🔴 全部戻しきったら、そのカットは「残す」にすること。
   *    長さ0の区間を残すと、掴めない印だけがタイムラインに残る。
   *
   * 戻り値は、動かす相手が見つかったかどうか。
   */
  const nudgeCutAt = useCallback(
    (atSrc: number, side: 'left' | 'right', deltaSec: number): boolean => {
      const list = regions.filter((r) => r.kind === 'cut' || r.kind === 'hold');
      const target =
        side === 'left'
          ? list.find((r) => Math.abs(r.end - atSrc) < 0.03)
          : list.find((r) => Math.abs(r.start - atSrc) < 0.03);
      if (!target) return false;

      const base =
        byId.get(target.id) ??
        (manualCuts.find((m) => m.id === target.id) as
          | { srcStart: number; srcEnd: number }
          | undefined);
      if (!base) return false;

      const cur = adjust[target.id] ?? { start: 0, end: 0 };
      const edge = side === 'left' ? 'end' : 'start';
      const next = { ...cur, [edge]: cur[edge] + Math.round(deltaSec * fps) };
      const newStart = base.srcStart + next.start / fps;
      const newEnd = base.srcEnd + next.end / fps;

      if (newEnd - newStart <= 0.04) {
        setAdjust((a) => {
          const n = { ...a };
          delete n[target.id];
          return n;
        });
        decide(target.id, 'keep');
        setNotice('カットを戻しました');
        return true;
      }
      setAdjust((a) => ({ ...a, [target.id]: next }));
      return true;
    },
    [regions, byId, manualCuts, adjust, fps, decide],
  );

  /**
   * 端をドラッグし終えたとき。
   * 🔴 adjust（フレーム単位のずらし量）に直して持つこと。
   *    ここを秒のまま持つと withTrim と二重にずれる。
   */
  const onTrim = useCallback(
    (id: string, start: number, end: number) => {
      /*
        「カット非表示」で残る区間の端を動かした場合。
        伸ばした分だけ、隣のカットを削る（＝素材が戻る）。
      */
      if (id.startsWith('seg-')) {
        const i = Number(id.slice(4));
        const sg = segments[i];
        if (!sg) return;
        let acc = 0;
        for (let k = 0; k < i; k++) acc += segments[k].srcEnd - segments[k].srcStart;
        const len = sg.srcEnd - sg.srcStart;
        const dStart = start - acc;
        const dEnd = end - (acc + len);
        let moved = false;
        if (Math.abs(dStart) > 0.005) moved = nudgeCutAt(sg.srcStart, 'left', dStart) || moved;
        if (Math.abs(dEnd) > 0.005) moved = nudgeCutAt(sg.srcEnd, 'right', dEnd) || moved;
        if (!moved) setNotice('この端の先には、切った所がありません');
        return;
      }

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
    [byId, fps, manualCuts, segments, nudgeCutAt],
  );

  /**
   * 吸着させる時刻。カット画面では**他のカットの端**に合わせられるようにする。
   * 隣り合うカットをぴったり繋げたいときに、1フレームずつ詰めなくて済む。
   */
  const snapPoints = useMemo(() => {
    const out = new Set<number>();
    for (const r of displayRegions) {
      out.add(Number(r.start.toFixed(3)));
      out.add(Number(r.end.toFixed(3)));
    }
    return [...out].sort((a, b) => a - b);
  }, [displayRegions]);

  /** 吸着の入り切り。Final Cut と同じく N キーで切り替える */
  const [snapEnabled, setSnapEnabled] = useState(true);

  /** 一言の知らせ。キーを押したのに何も起きないとき、その理由を出す */
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2800);
    return () => clearTimeout(t);
  }, [notice]);

  /**
   * 元素材の時刻を、いま再生している目盛りの時刻に直す。
   *
   * 🔴 seek に渡す時刻は**再生している時間軸**でなければならない。
   *    regions は元素材の時刻で持っているので、そのまま渡すと
   *    「カット後」で見ているときだけ、切った分だけ先へ飛んでしまう。
   *    ↓ を押しても目当ての保留に着かない、として現れる。
   */
  const toPlayTime = useCallback(
    (t: number) => (axis === 'edited' && segments.length ? toOutput(segments, t) : t),
    [axis, segments],
  );
  /** 逆向き。再生している目盛りの時刻 → 元素材の時刻 */
  const fromPlayTime = useCallback(
    (t: number) => (axis === 'edited' && segments.length ? toSource(segments, t) : t),
    [axis, segments],
  );

  /** 選んだ区間の少し手前から流す。繋ぎ目は前後を見ないと判断できない */
  const playAround = useCallback(
    (id: string) => {
      const r = regions.find((x) => x.id === id);
      if (r) seek(Math.max(0, toPlayTime(r.start) - 1.2));
      player.play();
    },
    [regions, seek, player, toPlayTime],
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
   * 白線より前（後ろ）を、まとめて切る。
   *
   * 🔴 素材の頭と尻を落とす操作は、範囲を指定するまでもない。
   *    I → O → Enter の3手を1手にする。聞きながら押せる。
   *
   * 🔴 押すたびに足さないこと。もう頭からのカットがあるなら、その終わりを
   *    動かす。押し直すたびに区間が増えると、どれが効いているのか分からなくなる。
   */
  const cutOutside = useCallback(
    (side: 'before' | 'after') => {
      const t = Number(fromPlayTime(player.time).toFixed(3));
      if (side === 'before' && t <= 0.05) {
        setNotice('先頭にいるので、切る所がありません');
        return;
      }
      if (side === 'after' && t >= duration - 0.05) {
        setNotice('末尾にいるので、切る所がありません');
        return;
      }
      setManualCuts((m) => {
        const head = side === 'before'
          ? m.find((x) => x.srcStart <= 0.001)
          : m.find((x) => x.srcEnd >= duration - 0.001);
        const rest = m.filter((x) => x !== head);
        const next = side === 'before'
          ? { id: head?.id ?? `manual-head-${Date.now()}`, srcStart: 0, srcEnd: t }
          : { id: head?.id ?? `manual-tail-${Date.now()}`, srcStart: t, srcEnd: duration };
        return [...rest, next].sort((a, b) => a.srcStart - b.srcStart);
      });
      setNotice(
        side === 'before'
          ? `先頭から ${clock(t)} までを切ります（戻すときは選んで F）`
          : `${clock(t)} から末尾までを切ります（戻すときは選んで F）`,
      );
    },
    [player.time, fromPlayTime, duration],
  );

  /**
   * 次（前）の保留へ移る。
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
      /*
        🔴 黙って何もしないことがないようにする。

           保留が無くなると ↑↓ は行き先が無くなる。以前はそこで
           何も起きなかったので、**キーが効かなくなった**ようにしか見えなかった。
           片づけ終わったのなら、そう言う。
      */
      if (pending.length === 0) {
        setNotice('保留はもうありません（↑↓ で移る先がありません）');
        return;
      }

      /*
        🔴 基準は「いま選んでいる箇所」にすること。再生位置ではない。

        移った先では前後の繋がりを見せるために 1.2 秒手前から流す。
        その位置を基準に次を探すと、**さっき移った箇所がまた次に見える**ので、
        ↓ を何度押しても同じところから動かない（実際にそうなった）。
      */
      const current = regions.find((r) => r.id === selected);
      // 🔴 比べる相手も元素材の時刻に揃える。player.time は目盛り側の時刻
      const ref = current ? current.start : fromPlayTime(player.time);
      const next =
        dir === 1
          ? (pending.find((r) => r.start > ref + 0.01) ?? pending[0])
          : ([...pending].reverse().find((r) => r.start < ref - 0.01) ?? pending[pending.length - 1]);

      setSelected(next.id);
      setFocusId(next.id);
      // 前後の繋がりを見たいので、少し手前から
      player.seek(Math.max(0, toPlayTime(next.start) - 1.2));
      player.play();
    },
    [regions, player, selected, toPlayTime, fromPlayTime],
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
        case 'cutBefore':
          cutOutside('before');
          break;
        case 'cutAfter':
          cutOutside('after');
          break;
        case 'toggleSnap':
          setSnapEnabled((v) => !v);
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
  }, [selected, decide, undo, player, fps, goPending, cutOutside]);

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
                保留 {held.length}
              </span>
              <span className="fcp-chip">−{removedSec.toFixed(1)}秒</span>
              {notice && (
                <span className="fcp-chip" style={{ color: 'var(--sel)' }}>
                  {notice}
                </span>
              )}
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
                  保留
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
              <label>カット判定</label>
              <div className="fcp-tally">
                <span>カット：</span>
                <strong>{approvedCuts.length} 箇所</strong>
              </div>
              <div className="fcp-tally">
                <span>カット時間：</span>
                <strong>{removedSec.toFixed(1)} 秒</strong>
              </div>
              <div className="fcp-tally">
                <span>保留：</span>
                <strong>{held.length} 箇所</strong>
              </div>
            </div>

            <div className="fcp-field">
              <label>保留を片づける</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => goPending(-1)} disabled={held.length === 0} title="↑ キー">
                  ↑ 前へ
                </button>
                <button onClick={() => goPending(1)} disabled={held.length === 0} title="↓ キー">
                  ↓ 次へ
                </button>
              </div>
              <dl className="fcp-keys">
                <div>
                  <dt>↓ / ↑</dt>
                  <dd>次 / 前の保留へ（少し手前から流します）</dd>
                </div>
                <div>
                  <dt>D</dt>
                  <dd>ここを切る</dd>
                </div>
                <div>
                  <dt>F</dt>
                  <dd>ここは残す</dd>
                </div>
                <div>
                  <dt>G</dt>
                  <dd>保留にする</dd>
                </div>
              </dl>
            </div>


            <div className="fcp-field">
              <label>要らない場面を丸ごと切る</label>
              <dl className="fcp-keys">
                <div>
                  <dt>I</dt>
                  <dd>ここから（範囲の始まり）</dd>
                </div>
                <div>
                  <dt>O</dt>
                  <dd>ここまで（範囲の終わり）</dd>
                </div>
                <div>
                  <dt>Enter</dt>
                  <dd>その範囲を切る</dd>
                </div>
                <div>
                  <dt>Esc</dt>
                  <dd>選んだ範囲をやめる</dd>
                </div>
                <div>
                  <dt>Q</dt>
                  <dd>白線より前を、頭からまとめて切る</dd>
                </div>
                <div>
                  <dt>W</dt>
                  <dd>白線より後ろを、末尾までまとめて切る</dd>
                </div>
              </dl>
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
            <p className="fcp-dim">
              <strong>カットを戻したいとき</strong>は、<strong>カット「非表示」</strong>に切り替えて、
              残っている素材の端を切れ目のほうへ<strong>ドラッグ</strong>してください。
              引いた分だけ切った素材が戻り、全部戻すとそのカットは無くなります。
            </p>

            {/* 🔴 一番下に置く。最初に一度決めたら、あとはめったに触らない */}
            <div className="fcp-field fcp-minor">
              <label>間の詰め具合</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
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
          snapPoints={snapPoints}
          snapEnabled={snapEnabled}
          extraControls={
            <>
              <button
                className={`fcp-snap-toggle ${snapEnabled ? 'on' : ''}`}
                onClick={() => setSnapEnabled((v) => !v)}
                title="隣のカットの端に吸い付ける（N キー）"
              >
                🧲 吸着
              </button>
            <div className="fcp-axis" title="切る所を、暗くして見せるか、詰めて見せるか">
              <span className="fcp-axis-label">カット</span>
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
              🔴 切る所は**コマの上に重ねる**こと。

                 以前は「コマ」と「カット」を別のレーンにしていた。帯とコマが
                 縦に離れているので、「この絵のところを切る」の対応を目で
                 追わないと分からなかった。重ねれば、切る所の絵がそのまま
                 暗くなるので、対応を考えなくて済む。
                 端のドラッグも、絵を見ながらそのまま合わせられる。
            */
            {
              id: 'film',
              label: '素材',
              regions: displayRegions,
              overlay: true,
              scalable: true,
              height: 64,
              render: (v) => (
                <Filmstrip
                  {...v}
                  videoPath={videoPath}
                  aspect={frame ? frame.width / frame.height : 16 / 9}
                  segments={applyCuts ? segments : undefined}
                />
              ),
            },
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
