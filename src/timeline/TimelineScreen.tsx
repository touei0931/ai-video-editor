/**
 * メインの編集画面。Final Cut と同じ道具だけを置く。
 *
 * 🔴 ここに自動カット・自動テロップを持ち込まないこと。
 *    あれは取り込みの子画面に集約した。ここへ混ぜると、
 *    「素材を並べる」と「1本の素材を詰める」の2つの考え方が同居して、
 *    どちらの操作なのか分からない画面になる。
 *
 * 🔴 状態は Project ひとつ。画面側で別に持たないこと。
 *    位置や長さを画面側にも持つと、必ず片方が古くなる。
 *    見えているものは全部 project から計算して出す。
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { Timeline, clock, type TimelineRegion, type TimelineTrack } from '../shell/Timeline';
import {
  addAsset,
  appendToMain,
  bladeAt,
  clipAt,
  layout,
  moveClip,
  newId,
  placeOnLane,
  placedTelops,
  isGap,
  removeClip,
  setMagnetic,
  timelineDuration,
  trimClip,
  type Lane,
  type Project,
} from './project';
import { ProbeError, probeAsset } from './probe';
import { buildFCPXML } from './fcpxml';
import { fromSaved, toSaved } from './persist';
import { useTimelinePlayer } from './useTimelinePlayer';
import { Viewer } from './Viewer';
import './timeline-screen.css';

interface Props {
  project: Project;
  onChange(next: Project): void;
  fps?: number;
  /**
   * 「素材を追加」で開くファイル選択。素材にして置くのはこちらでやる。
   *
   * 🔴 置き場所を呼び出し側に決めさせないこと。
   *    どのレーンへ・どの位置へ、は選んでいるものと再生位置で決まる。
   *    外から渡すと、画面の状態を持ち回すことになる。
   */
  pickFile?(): Promise<string | null>;
  /** 「取り込み（自動カット）」を押したとき。子画面を開くのは呼び出し側の仕事 */
  onImport?(): void;
}

/** レーンの見出しに出す言葉 */
const LANE_LABEL: Record<Lane['kind'], string> = {
  main: '本編',
  video: '重ね',
  audio: '音',
};

export function TimelineScreen({ project, onChange, fps = 30, pickFile, onImport }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /*
    🔴 再生位置は再生器が持つこと。画面側にもう1つ持たない。
       2つ持つと、タイムラインを掴んで動かしたのに映像が付いてこない、
       という食い違いが必ず起きる。
  */
  const player = useTimelinePlayer(project);
  const time = player.time;
  const setTime = player.seek;

  /*
    取り消し。
    🔴 操作の**前**を積むこと。後を積むと、1回目の取り消しで何も変わらない。
  */
  const past = useRef<Project[]>([]);
  const apply = useCallback(
    (next: Project, message?: string) => {
      if (next === project) return;
      past.current = [...past.current.slice(-49), project];
      onChange(next);
      if (message) setNotice(message);
    },
    [project, onChange],
  );
  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) {
      setNotice('これ以上戻せません');
      return;
    }
    onChange(prev);
    setNotice('1つ戻しました');
  }, [onChange]);

  const duration = useMemo(() => timelineDuration(project), [project]);
  const placed = useMemo(() => layout(project), [project]);
  const telops = useMemo(() => placedTelops(project), [project]);
  const assetName = useCallback(
    (id: string) => project.assets.find((a) => a.id === id)?.name ?? '素材',
    [project.assets],
  );

  /** 選んでいるクリップが乗っているレーン */
  const selectedLane = useMemo(
    () => placed.find((c) => c.id === selected)?.laneId ?? null,
    [placed, selected],
  );

  /* ---------------------------------------------------------------- 操作 */

  /** 白線の所で分ける（⌘B）。選んでいるレーン、無ければ本編 */
  const blade = useCallback(() => {
    const laneId = selectedLane ?? project.lanes.find((l) => l.kind === 'main')?.id;
    if (!laneId) return;
    const target = clipAt(project, laneId, time);
    if (!target) {
      setNotice('白線の所にクリップがありません');
      return;
    }
    apply(bladeAt(project, laneId, time), `${clock(time)} で分けました`);
  }, [project, time, selectedLane, apply]);

  /**
   * 選んでいるクリップを消す。
   *
   * 🔴 既定は「詰める」。Final Cut の Delete と同じ。
   *    穴を空けたいときだけ Shift（Final Cut の ⌥Delete にあたる）。
   */
  const remove = useCallback(
    (lift: boolean) => {
      if (!selected) return;
      apply(
        removeClip(project, selected, lift ? 'lift' : 'ripple'),
        lift ? '空きにしました' : '消して詰めました',
      );
      setSelected(null);
    },
    [project, selected, apply],
  );

  /** 上に重ねるレーンを1本足す */
  const addLaneAbove = useCallback(
    (kind: 'video' | 'audio') => {
      const lane: Lane = {
        id: newId('lane'),
        kind,
        name: kind === 'video' ? '重ね' : '音',
      };
      apply({ ...project, lanes: [...project.lanes, lane] }, 'レーンを足しました');
    },
    [project, apply],
  );

  /**
   * 端をドラッグし終えたとき。
   *
   * 🔴 どちらの端が動いたかを、動く前の位置と比べて決めること。
   *    タイムラインは「始まりと終わり」しか返さない。長さが変わっていなければ
   *    移動、片側だけ変わっていれば伸縮。ここを取り違えると、
   *    端を伸ばしたつもりでクリップごと動く。
   */
  const onTrim = useCallback(
    (id: string, start: number, end: number) => {
      const before = placed.find((c) => c.id === id);
      if (!before) return;
      const movedWhole = Math.abs(end - start - (before.end - before.start)) < 0.002;

      if (movedWhole) {
        apply(moveClip(project, id, before.laneId, start));
        return;
      }
      if (Math.abs(start - before.start) > 0.002) {
        apply(trimClip(project, id, 'start', start - before.start));
      }
      if (Math.abs(end - before.end) > 0.002) {
        apply(trimClip(project, id, 'end', end - before.end));
      }
    },
    [placed, project, apply],
  );

  /** 別のレーンへ放したとき */
  const onMoveToLane = useCallback(
    (id: string, start: number, laneId: string) => {
      apply(moveClip(project, id, laneId, start), 'レーンを移しました');
    },
    [project, apply],
  );

  /**
   * 素材を選んで置く。
   *
   * 🔴 置き先は「選んでいるレーン」。本編を選んでいるなら末尾に足す。
   *    どこに置かれたか分からないのがいちばん困るので、置いたら選んで知らせる。
   */
  const [busy, setBusy] = useState(false);
  const addAssetHere = useCallback(async () => {
    if (!pickFile || busy) return;
    let path: string | null = null;
    try {
      path = await pickFile();
    } catch {
      return;
    }
    if (!path) return;

    setBusy(true);
    setNotice('素材を読み込んでいます…');
    try {
      const asset = await probeAsset(path);
      const lane = project.lanes.find((l) => l.id === selectedLane) ?? null;
      let next = addAsset(project, asset);
      if (!lane || lane.kind === 'main') {
        next = appendToMain(next, asset.id);
      } else {
        next = placeOnLane(next, lane.id, asset.id, time);
      }
      const added = next.clips[next.clips.length - 1];
      apply(next, `${asset.name} を置きました`);
      setSelected(added?.id ?? null);
    } catch (e) {
      setNotice(e instanceof ProbeError ? e.message : '素材を読み込めませんでした');
    } finally {
      setBusy(false);
    }
  }, [pickFile, busy, project, selectedLane, time, apply]);

  /**
   * Final Cut に読み込む XML を書き出す。
   *
   * 🔴 何も置かれていないときは押させないこと。
   *    中身の無い XML を読み込ませても、Final Cut では空の project が
   *    増えるだけで、何が起きたのか分からない。
   */
  const exportXML = useCallback(async () => {
    if (!project.clips.length) return;
    const api = window.app;
    if (!api?.saveFCPXML) {
      setNotice('この画面からは書き出せません（アプリ版で開いてください）');
      return;
    }
    try {
      const xml = buildFCPXML(project, { name: 'PAC', fps });
      const saved = await api.saveFCPXML({ xml, defaultName: 'PAC.fcpxml' });
      setNotice(
        saved
          ? '書き出しました。Final Cut の「ファイル > 読み込む > XML」から開いてください'
          : '中止しました',
      );
    } catch {
      setNotice('書き出しに失敗しました');
    }
  }, [project, fps]);

  /** タイムラインを保存する */
  const saveTimeline = useCallback(async () => {
    const api = window.app;
    if (!api?.saveTimeline) {
      setNotice('この画面からは保存できません（アプリ版で開いてください）');
      return;
    }
    const saved = await api.saveTimeline({
      data: toSaved(project),
      defaultName: 'タイムライン.pacproj',
    });
    setNotice(saved ? '保存しました' : '中止しました');
  }, [project]);

  /**
   * 保存したタイムラインを開く。
   *
   * 🔴 中身を確かめてから入れること。
   *    書類は人が触れる場所にある。そのまま入れると、壊れた1件で
   *    画面が真っ白になり、何が起きたか分からなくなる。
   */
  const openTimeline = useCallback(async () => {
    const api = window.app;
    if (!api?.openTimeline) {
      setNotice('この画面からは開けません（アプリ版で開いてください）');
      return;
    }
    const got = await api.openTimeline();
    if (!got) return;
    const next = fromSaved(got.data);
    if (!next) {
      setNotice('この書類は開けませんでした（PAC のタイムラインではないようです）');
      return;
    }
    apply(next, '開きました');
    setSelected(null);
  }, [apply]);

  /* ------------------------------------------------------------ キー操作 */

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return;
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        blade();
      } else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      } else if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        remove(e.shiftKey);
      } else if (!mod && e.key === ' ') {
        e.preventDefault();
        player.toggle();
      } else if (!mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        apply(setMagnetic(project, !project.magnetic));
      }
    },
    [blade, undo, remove, project, apply, player],
  );

  /* ------------------------------------------------------------- 見た目 */

  const tracks = useMemo<TimelineTrack[]>(() => {
    /*
      🔴 上のレーンを先に出すこと。
         編集ソフトは、重ねたものが上に見える。ここだけ逆にすると、
         同じ絵が別の位置にあるように見える。
    */
    const lanes = [...project.lanes].reverse();
    return lanes.map((lane) => {
      const regions: TimelineRegion[] = placed
        .filter((c) => c.laneId === lane.id)
        .map((c) => ({
          id: c.id,
          start: c.start,
          end: c.end,
          // 空きは切る所と同じ色にする。「ここには何も映らない」が一目で分かる
          kind: isGap(c) ? ('cut' as const) : ('keep' as const),
          label: isGap(c) ? '空き' : assetName(c.assetId),
        }));

      // 本編のレーンには、その上に出るテロップも見せる（触れない目印）
      if (lane.kind === 'main') {
        for (const t of telops) {
          regions.push({
            id: `telop:${t.id}:${t.clipId}`,
            start: t.start,
            end: t.end,
            kind: 'hold',
            label: t.text,
            fixed: true,
            decor: true,
          });
        }
      }
      return {
        id: lane.id,
        label: lane.name || LANE_LABEL[lane.kind],
        regions,
        height: lane.kind === 'audio' ? 40 : 56,
      };
    });
  }, [project.lanes, placed, telops, assetName]);

  /** 切れ目に吸い付かせる */
  const snapPoints = useMemo(
    () => [0, ...placed.flatMap((c) => [c.start, c.end])],
    [placed],
  );

  return (
    <div className="tl-screen" tabIndex={0} onKeyDown={onKeyDown} style={{ position: 'relative' }}>
      <div className="tl-bar">
        <button
          onClick={onImport}
          disabled={!onImport}
          title="動画を選んで、自動カットと自動テロップの下ごしらえをしてから並べます"
        >
          取り込み
        </button>
        <button onClick={addAssetHere} disabled={!pickFile || busy}>
          {busy ? '読み込み中…' : '素材を追加'}
        </button>
        <span className="tl-sep" />
        <button onClick={() => addLaneAbove('video')} title="B-roll や差し込みを重ねるレーン">
          ＋重ねる
        </button>
        <button onClick={() => addLaneAbove('audio')} title="BGM や効果音のレーン">
          ＋音
        </button>
        <span className="tl-sep" />
        <button onClick={blade} title="再生位置で素材を分ける（⌘B / Ctrl+B）">
          分ける
        </button>
        <button onClick={() => remove(false)} disabled={!selected} title="消して後ろを詰める（Delete）">
          消す
        </button>
        <button onClick={() => remove(true)} disabled={!selected} title="その場を空きにして消す（Shift+Delete）">
          空きにする
        </button>
        <button onClick={openTimeline} title="保存したタイムラインを開きます">
          開く
        </button>
        <button onClick={saveTimeline} title="並べたものを保存します">
          保存
        </button>
        <span className="tl-sep" />
        <button
          onClick={exportXML}
          disabled={!project.clips.length}
          title="Final Cut Pro に読み込む XML を書き出します"
        >
          FCPXML を書き出す
        </button>
        <span className="tl-spacer" />
        <span className="tl-len">{clock(duration)}</span>
      </div>

      {notice && (
        <div className="tl-notice" onAnimationEnd={() => setNotice(null)}>
          {notice}
        </div>
      )}

      <Viewer project={project} player={player} />

      <Timeline
        duration={Math.max(duration, 1)}
        fps={fps}
        currentTime={time}
        onSeek={setTime}
        selectedId={selected}
        onSelect={setSelected}
        onTrim={onTrim}
        onMoveToLane={onMoveToLane}
        snapPoints={snapPoints}
        tracks={tracks}
        extraControls={
          <button
            className={`fcp-snap-toggle ${project.magnetic ? 'on' : ''}`}
            onClick={() => apply(setMagnetic(project, !project.magnetic))}
            title="本編のクリップを隙間なく詰める（N キー）"
          >
            🧲 詰める
          </button>
        }
      />
    </div>
  );
}
