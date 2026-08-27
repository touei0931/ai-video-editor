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
import {
  Timeline,
  clock,
  type TimelineRegion,
  type TimelineTrack,
  type TimelineView,
} from '../shell/Timeline';
import {
  addAsset,
  adoptSettings,
  appendToMain,
  bladeAt,
  clipAt,
  layout,
  moveClip,
  newId,
  placeOnLane,
  placedTelops,
  isGap,
  clipLength,
  addTelop,
  updateTelop,
  removeTelop,
  moveTelopEdge,
  duplicateClip,
  pasteClip,
  videoAt,
  type Clip,
  removeClip,
  setMagnetic,
  timelineDuration,
  trimClip,
  type Lane,
  type PlacedClip,
  type Project,
  type ProjectSettings,
} from './project';
import { ProbeError, probeAsset } from './probe';
import { Inspector, parseSelection } from './Inspector';
import { buildTimelineCards } from './telopCanvas';
import { renderBlank, renderTelopPngs } from '../telop/rasterize';
import { ClipFilmstrip } from './ClipFilmstrip';
import { ClipWaveform } from './ClipWaveform';
import { buildFCPXML } from './fcpxml';
import { fromSaved, toSaved } from './persist';
import { useTimelinePlayer } from './useTimelinePlayer';
import { Viewer } from './Viewer';
import './timeline-screen.css';

interface Props {
  project: Project;
  onChange(next: Project): void;
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

/**
 * そのファイルが入っているフォルダ。
 *
 * 🔴 区切りは / と \ の両方を見ること。Windows と mac で違う。
 *    片方だけ見ると、もう片方でフォルダ名がファイル名ごと残り、
 *    存在しない場所へ書こうとして失敗する。
 */
function dirOf(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/');
  const cut = norm.lastIndexOf('/');
  return cut <= 0 ? norm : norm.slice(0, cut);
}

/**
 * よく使う大きさ。
 * 🔴 幅も高さも偶数にすること。奇数だと yuv420p にできず、書き出しの ffmpeg が落ちる。
 */
const SIZE_PRESETS = [
  { label: '横 1080p', width: 1920, height: 1080 },
  { label: '縦 1080p', width: 1080, height: 1920 },
  { label: '横 720p', width: 1280, height: 720 },
  { label: '正方形', width: 1080, height: 1080 },
];

/** よく使うコマ数。29.97 は放送・iPhone 由来の素材で要る */
const FPS_PRESETS = [24, 25, 29.97, 30, 60];

/** レーンの見出しに出す言葉 */
const LANE_LABEL: Record<Lane['kind'], string> = {
  main: '本編',
  video: '重ね',
  audio: '音',
};

export function TimelineScreen({ project, onChange, pickFile, onImport }: Props) {
  /*
    テロップの見た目はプロジェクトが持つ。
    🔴 画面側で既定に落とさないこと。子画面で整えた見た目が
       並べた瞬間に潰れ、しかも書き出すまで気づけない。
  */
  const styles = project.styles;
  /*
    コマ数はプロジェクトが持つ（Final Cut の「プロジェクトのプロパティ」）。
    🔴 素材から決めないこと。素材を1本足すたびに書き出しのコマ数が変わる。
  */
  const fps = project.settings.fps;
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
      const sel = parseSelection(selected);
      if (!sel) return;
      /*
        🔴 テロップを選んでいるときは、テロップを消すこと。
           下のクリップを消すと、選んでいないものが消えることになる。
      */
      if (sel.kind === 'telop') {
        apply(removeTelop(project, sel.telopId), 'テロップを消しました');
        setSelected(null);
        return;
      }
      apply(
        removeClip(project, sel.clipId, lift ? 'lift' : 'ripple'),
        lift ? '空きにしました' : '消して詰めました',
      );
      setSelected(null);
    },
    [project, selected, apply],
  );

  /**
   * 再生位置にテロップを1枚足す。
   *
   * 🔴 置き先は「その時見えている映像のクリップ」。
   *    レーンを選ばせない。テロップは素材に結び付くので、
   *    どのクリップの上かが決まれば置き場所は決まる。
   */
  const addTelopHere = useCallback(() => {
    const clip = videoAt(project, time);
    if (!clip) {
      setNotice('白線の所に映像がありません');
      return;
    }
    const next = addTelop(project, clip, time, 2, '新しいテロップ');
    if (next === project) {
      setNotice('ここにはテロップを置けません');
      return;
    }
    const added = next.telops[next.telops.length - 1];
    apply(next, 'テロップを足しました');
    setSelected(`telop:${added.id}:${clip.id}`);
  }, [project, time, apply]);

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
      /*
        テロップの帯を掴んだとき。
        🔴 素材の時刻へ直してから入れること。タイムライン上の時刻のまま入れると、
           そのクリップを動かした瞬間にテロップだけ取り残される。
      */
      const sel = parseSelection(id);
      if (sel?.kind === 'telop') {
        const shown = telops.find((t) => t.id === sel.telopId && t.clipId === sel.clipId);
        const raw = project.telops.find((t) => t.id === sel.telopId);
        const on = placed.find((c) => c.id === sel.clipId);
        if (!shown || !raw || !on) return;
        if (Math.abs(end - start - (shown.end - shown.start)) < 0.002) {
          // まるごと動かす
          const d = start - shown.start;
          apply(updateTelop(project, raw.id, { srcStart: raw.srcStart + d, srcEnd: raw.srcEnd + d }));
          return;
        }
        let next = project;
        if (Math.abs(start - shown.start) > 0.002) {
          next = moveTelopEdge(next, raw.id, on, 'start', start);
        }
        if (Math.abs(end - shown.end) > 0.002) {
          next = moveTelopEdge(next, raw.id, on, 'end', end);
        }
        apply(next);
        return;
      }

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
    [placed, telops, project, apply],
  );

  /** 別のレーンへ放したとき */
  const onMoveToLane = useCallback(
    (id: string, start: number, laneId: string) => {
      /*
        🔴 テロップは段を跨がせないこと。
           テロップの段は「どこに出るか」を見せるための場所で、レーンではない。
           そこへ落としたクリップは行き先を失う。
      */
      if (id.startsWith('telop:') || laneId === 'telops') return;
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
      // 🔴 置く**前**に大きさを決める。置いたあとでは「もう並んでいる」と見なされる
      let next = adoptSettings(addAsset(project, asset), asset);
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

  /**
   * 並べたものを1本の動画にする。
   *
   * 🔴 テロップは**タイムライン上の時刻**に直してから渡すこと。
   *    Telop は素材の中の時刻で持っている（クリップを動かしても付いてくるように）。
   *    そのまま渡すと、同じ素材を何度も切って並べた分だけ出る場所が食い違う。
   *
   * 🔴 PNG はプロジェクトの大きさちょうどで焼くこと。
   *    違う大きさだと overlay は黙って左上に貼るだけで、
   *    「テロップが見切れている」という形で書き出したあとに気づく。
   *    サイドカー側にも同じ検査を置いてある。
   *
   * 🔴 中間ファイルを書き出し先に散らかさないこと。
   *    テロップの PNG は数百枚になる。利用者が選んだフォルダにそのまま置くと、
   *    書き出した動画がどれか分からなくなる。隠しフォルダにまとめる。
   */
  const [exporting, setExporting] = useState<string | null>(null);
  const exportVideo = useCallback(async () => {
    if (!project.clips.length || exporting) return;
    const api = window.app;
    if (!api?.exportTimeline || !api.pickOutput) {
      setNotice('この画面からは書き出せません（アプリ版で開いてください）');
      return;
    }

    const out = await api.pickOutput('PAC.mp4');
    if (!out) return;

    const workDir = `${dirOf(out)}/.pac-work`;
    const frame = { width: project.settings.width, height: project.settings.height };
    const assets = new Map(project.assets.map((a) => [a.id, a]));
    const laneOf = new Map(project.lanes.map((l) => [l.id, l]));
    // レーンの並び順がそのまま重なりの順。本編は必ず 0
    const zOf = new Map(
      project.lanes.map((l, i) => [l.id, l.kind === 'main' ? 0 : i + 1] as const),
    );

    const clips = placed
      .filter((c): c is PlacedClip => !isGap(c) && clipLength(c) > 0)
      .map((c) => {
        const asset = assets.get(c.assetId);
        const lane = laneOf.get(c.laneId);
        if (!asset || !lane) return null;
        return {
          path: asset.path,
          at: c.start,
          src_start: c.srcStart,
          src_end: c.srcEnd,
          z: zOf.get(c.laneId) ?? 0,
          // 音のレーンに置かれた映像素材は、音だけ使う（Final Cut と同じ）
          video: lane.kind !== 'audio' && asset.hasVideo,
          audio: asset.hasAudio,
          gain_db: c.gainDb ?? 0,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    if (!clips.length) {
      setNotice('書き出せる中身がありません');
      return;
    }

    const stop = api.onProgress?.((p) =>
      setExporting(`${p.message}${p.value > 0 ? ` ${Math.round(p.value * 100)}%` : ''}`),
    );
    setExporting('書き出しの準備をしています');

    try {
      // ── テロップを焼く ──
      let telops: unknown[] = [];
      let blankPng = '';
      const shown = placedTelops(project);
      // 焼き込まない場合でも、字幕ファイルを出すために時刻と文言は渡す
      const wantPng = project.settings.burnTelops;
      if (shown.length && (wantPng || project.settings.writeSrt)) {
        const cards = buildTimelineCards(shown, frame, styles);
        if (wantPng) {
          const rendered = await renderTelopPngs(cards, frame, styles, (done, total) =>
            setExporting(`テロップを描いています ${done}/${total}`),
          );
          const saved = await api.saveTelopFrames({
            dir: `${workDir}/telops`,
            frames: [
              ...rendered.map((r) => ({ name: r.name, base64: r.base64 })),
              { name: '_blank.png', base64: renderBlank(frame) },
            ],
          });
          blankPng = saved['_blank.png'];
          telops = cards.map((c, i) => ({
            out_start: c.srcStart,
            out_end: c.srcEnd,
            text: c.text,
            png: saved[rendered[i].name],
            lane: rendered[i].lane,
          }));
        } else {
          telops = cards.map((c) => ({
            out_start: c.srcStart,
            out_end: c.srcEnd,
            text: c.text,
            png: '',
            lane: 0,
          }));
        }
      }

      const result = (await api.exportTimeline({
        out_path: out,
        work_dir: workDir,
        settings: project.settings,
        duration,
        clips,
        telops,
        blank_png: blankPng,
        burn_telops: wantPng && telops.length > 0,
        write_srt: project.settings.writeSrt && telops.length > 0,
        loudnorm: project.settings.loudnorm,
      })) as { out_path?: string; telop_count?: number; size_mb?: number; srt_path?: string };

      setNotice(
        `書き出しました（${clock(duration)} / ${result.size_mb ?? '?'}MB` +
          `${result.telop_count ? ` / テロップ ${result.telop_count} 枚` : ''}` +
          `${result.srt_path ? ' / 字幕も出しました' : ''}）`,
      );
      void api.revealFile?.(result.out_path ?? out);
    } catch (e) {
      setNotice(`書き出せませんでした: ${(e as Error).message}`);
    } finally {
      stop?.();
      setExporting(null);
    }
  }, [project, placed, duration, styles, exporting]);

  /**
   * 控え（コピー）。
   *
   * 🔴 クリップそのものではなく「素材のどこか」を控えること。
   *    クリップは消えたり分かれたりする。控えが元のクリップを指していると、
   *    貼るときには既に無い、ということが起きる。
   */
  const [clipboard, setClipboard] = useState<Pick<
    Clip,
    'assetId' | 'srcStart' | 'srcEnd' | 'gainDb'
  > | null>(null);

  const copyClip = useCallback(() => {
    const sel = parseSelection(selected);
    if (sel?.kind !== 'clip') return;
    const c = placed.find((x) => x.id === sel.clipId);
    if (!c || isGap(c)) return;
    setClipboard({ assetId: c.assetId, srcStart: c.srcStart, srcEnd: c.srcEnd, gainDb: c.gainDb });
    setNotice(`${c.name} を控えました`);
  }, [selected, placed]);

  const paste = useCallback(() => {
    if (!clipboard) {
      setNotice('控えているものがありません');
      return;
    }
    const laneId = selectedLane ?? project.lanes.find((l) => l.kind === 'main')?.id;
    if (!laneId) return;
    const next = pasteClip(project, clipboard, laneId, time);
    if (next === project) {
      setNotice('ここには貼れません');
      return;
    }
    const added = next.clips.find((c) => !project.clips.some((o) => o.id === c.id));
    apply(next, '貼りました');
    setSelected(added?.id ?? null);
  }, [clipboard, project, selectedLane, time, apply]);

  const duplicate = useCallback(() => {
    const sel = parseSelection(selected);
    if (sel?.kind !== 'clip') return;
    const next = duplicateClip(project, sel.clipId);
    if (next === project) return;
    const added = next.clips.find((c) => !project.clips.some((o) => o.id === c.id));
    apply(next, '複製しました');
    setSelected(added?.id ?? null);
  }, [selected, project, apply]);

  /** 書き出しの大きさ・コマ数を変える */
  const setSettings = useCallback(
    (patch: Partial<ProjectSettings>) => {
      apply({ ...project, settings: { ...project.settings, ...patch } }, '設定を変えました');
    },
    [project, apply],
  );

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

  /**
   * 編集点（クリップの切れ目）の一覧。
   *
   * 🔴 全レーンの切れ目を混ぜること。
   *    本編だけ見ていると、上に重ねた差し込みの頭へ行けない。
   *    Final Cut の ↑↓ も、全レーンの編集点を渡り歩く。
   */
  const editPoints = useMemo(() => {
    const set = new Set<number>([0, Number(duration.toFixed(4))]);
    for (const c of placed) {
      set.add(Number(c.start.toFixed(4)));
      set.add(Number(c.end.toFixed(4)));
    }
    return [...set].sort((a, b) => a - b);
  }, [placed, duration]);

  /** 再生位置を動かす。行き過ぎないように端で止める */
  const seekBy = useCallback(
    (delta: number) => {
      player.seek(Math.max(0, Math.min(duration, time + delta)));
    },
    [player, time, duration],
  );

  /** 次（前）の編集点へ */
  const seekEdit = useCallback(
    (dir: 1 | -1) => {
      // 🔴 わずかな誤差で「今いる所」に吸い戻されないよう、少し余裕を取る
      const next =
        dir > 0
          ? editPoints.find((p) => p > time + 0.004)
          : [...editPoints].reverse().find((p) => p < time - 0.004);
      if (next === undefined) return;
      player.seek(next);
    },
    [editPoints, time, player],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return;
      const mod = e.ctrlKey || e.metaKey;

      if (!mod && e.key.toLowerCase() === 't') {
        e.preventDefault();
        addTelopHere();
        return;
      }

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
      } else if (!mod && e.key === 'ArrowLeft') {
        /*
          🔴 1コマ単位を用意すること。
             テロップの出だしが1コマ早いだけで、声より先に文字が出る。
             マウスのドラッグでは 1/30 秒には届かない。
        */
        e.preventDefault();
        seekBy(e.shiftKey ? -1 : -1 / fps);
      } else if (!mod && e.key === 'ArrowRight') {
        e.preventDefault();
        seekBy(e.shiftKey ? 1 : 1 / fps);
      } else if (!mod && e.key === 'ArrowUp') {
        e.preventDefault();
        seekEdit(-1);
      } else if (!mod && e.key === 'ArrowDown') {
        e.preventDefault();
        seekEdit(1);
      } else if (!mod && e.key === 'Home') {
        e.preventDefault();
        player.seek(0);
      } else if (!mod && e.key === 'End') {
        e.preventDefault();
        player.seek(duration);
      } else if (!mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        player.pause();
      } else if (!mod && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        player.play();
      } else if (mod && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        copyClip();
      } else if (mod && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        paste();
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicate();
      }
    },
    [
      blade, undo, remove, addTelopHere, seekBy, seekEdit,
      copyClip, paste, duplicate,
      fps, duration, project, apply, player,
    ],
  );

  /* ------------------------------------------------------------- 見た目 */

  const tracks = useMemo<TimelineTrack[]>(() => {
    /*
      🔴 上のレーンを先に出すこと。
         編集ソフトは、重ねたものが上に見える。ここだけ逆にすると、
         同じ絵が別の位置にあるように見える。
    */
    const lanes = [...project.lanes].reverse();

    /*
      テロップは専用の段に出す。
      🔴 素材の段に重ねないこと。
         あの段には素材のコマとクリップの帯が既にある。そこへテロップまで
         重ねると、同じ場所で3つの意味の帯が押し合い、
         **どれを掴んだのか分からなくなる**。
         Final Cut でもテロップは別の段に乗る。
    */
    const telopTrack: TimelineTrack | null = telops.length
      ? {
          id: 'telops',
          label: 'テロップ',
          height: 26,
          regions: telops.map((t) => ({
            id: `telop:${t.id}:${t.clipId}`,
            start: t.start,
            end: t.end,
            kind: 'telop' as const,
            label: t.text || '（空）',
            // 掴んで動かせる。本文と見た目はインスペクタで直す
            fixed: false,
          })),
        }
      : null;

    const out = lanes.map((lane) => {
      const regions: TimelineRegion[] = placed
        .filter((c) => c.laneId === lane.id)
        .map((c) => ({
          id: c.id,
          start: c.start,
          end: c.end,
          // 空きは切る所と同じ色にする。「ここには何も映らない」が一目で分かる
          kind: isGap(c) ? ('cut' as const) : ('keep' as const),
          label: c.name,
        }));

      const mine = placed.filter((c) => c.laneId === lane.id);
      return {
        id: lane.id,
        label: lane.name || LANE_LABEL[lane.kind],
        regions,
        height: lane.kind === 'audio' ? 40 : 56,
        /*
          🔴 コマはクリップの上に重ねること。別のレーンに分けない。
             縦に離れていると、「この絵のところを触っている」の対応を
             目で追わないと分からない。
        */
        overlay: lane.kind !== 'audio',
        scalable: lane.kind !== 'audio',
        /*
          🔴 喋り主体では、コマより波形のほうが効く。
             同じ人が10分喋っている素材のコマはどこを見ても同じ顔で、
             切れ目の良し悪しが分からない。波なら
             「立ち上がる直前で切れているか」を再生せずに判断できる。
             コマも残すのは、差し込み映像や画の切り替わりを探すときに要るため。
        */
        render:
          lane.kind === 'audio'
            ? (v: TimelineView) => (
                <ClipWaveform {...v} clips={mine} assets={project.assets} />
              )
            : (v: TimelineView) => (
                <>
                  <ClipFilmstrip {...v} clips={mine} assets={project.assets} />
                  <ClipWaveform
                    {...v}
                    clips={mine}
                    assets={project.assets}
                    height={Math.max(14, Math.round(v.height * 0.38))}
                    align="bottom"
                    color="rgba(120, 220, 170, 0.85)"
                  />
                </>
              ),
      };
    });
    return telopTrack ? [telopTrack, ...out] : out;
  }, [project.lanes, project.assets, placed, telops]);

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
        <button onClick={addTelopHere} title="再生位置にテロップを1枚足す（T）">
          ＋テロップ
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
          onClick={() => void exportVideo()}
          disabled={!project.clips.length || !!exporting}
          title="並べたものを1本の動画にします（テロップは焼き込みます）"
        >
          {exporting ? '書き出し中…' : '動画を書き出す'}
        </button>
        <button
          onClick={exportXML}
          disabled={!project.clips.length}
          title="Final Cut Pro に読み込む XML を書き出します"
        >
          FCPXML を書き出す
        </button>
        {/*
          プロジェクトの決めごと（Final Cut の「プロジェクトのプロパティ」）。
          🔴 素材から自動で決めないこと。素材を1本足すたびに
             書き出しの大きさが変わると、作業が壊れる。
        */}
        <details className="tl-keys tl-settings">
          <summary title="書き出しの大きさとコマ数">設定</summary>
          <div className="tl-settings-body">
            <p className="tl-settings-now">
              {project.settings.width}×{project.settings.height} / {project.settings.fps}fps
            </p>
            <div className="tl-settings-row">
              {SIZE_PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => setSettings({ width: p.width, height: p.height })}
                  aria-pressed={
                    project.settings.width === p.width && project.settings.height === p.height
                  }
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="tl-settings-row">
              {FPS_PRESETS.map((f) => (
                <button
                  key={f}
                  onClick={() => setSettings({ fps: f })}
                  aria-pressed={project.settings.fps === f}
                >
                  {f}fps
                </button>
              ))}
            </div>
            <p className="tl-settings-note">
              素材はこの大きさに収めて書き出します（足りない分は黒で埋めます）。
            </p>

            {/*
              🔴 書き出しの選択は画面から変えられるようにしておくこと。
                 既定のまま隠すと、字幕だけ欲しい人に手立てが無くなる。
                 以前これを隠していて、Final Cut への受け渡しが
                 一度もできない状態で配りかけた。
            */}
            <hr className="tl-settings-line" />
            <label className="tl-check">
              <input
                type="checkbox"
                checked={project.settings.burnTelops}
                onChange={(e) => setSettings({ burnTelops: e.target.checked })}
              />
              テロップを映像に焼き込む
            </label>
            <label className="tl-check">
              <input
                type="checkbox"
                checked={project.settings.writeSrt}
                onChange={(e) => setSettings({ writeSrt: e.target.checked })}
              />
              字幕ファイル（.srt）も作る
            </label>
            <label className="tl-check">
              <input
                type="checkbox"
                checked={project.settings.loudnorm}
                onChange={(e) => setSettings({ loudnorm: e.target.checked })}
              />
              音量を配信の基準にそろえる
            </label>
          </div>
        </details>
        <span className="tl-spacer" />
        <span className="tl-len">{clock(duration)}</span>
        {/*
          🔴 キーの一覧を画面の中に置くこと。
             ⌘B も Delete も、押せると知らなければ一度も使われない。
             別の窓や説明書に隠すと、結局マウスだけで操作することになる。
        */}
        <details className="tl-keys">
          <summary title="キー操作">キー</summary>
          <dl>
            <div><dt>Space</dt><dd>再生 / 一時停止</dd></div>
            <div><dt>⌘B / Ctrl+B</dt><dd>再生位置で分ける</dd></div>
            <div><dt>Delete</dt><dd>消して後ろを詰める</dd></div>
            <div><dt>Shift+Delete</dt><dd>その場を空きにする</dd></div>
            <div><dt>N</dt><dd>詰める の入 / 切</dd></div>
            <div><dt>⌘Z / Ctrl+Z</dt><dd>ひとつ戻す</dd></div>
            <div><dt>T</dt><dd>再生位置にテロップを足す</dd></div>
            <div><dt>⌘C / ⌘V</dt><dd>控える / 貼る</dd></div>
            <div><dt>⌘D</dt><dd>複製して後ろに置く</dd></div>
            <div><dt>← / →</dt><dd>1コマ戻す / 進める</dd></div>
            <div><dt>Shift+← / →</dt><dd>1秒戻す / 進める</dd></div>
            <div><dt>↑ / ↓</dt><dd>前 / 次の切れ目へ</dd></div>
            <div><dt>Home / End</dt><dd>先頭 / 末尾</dd></div>
            <div><dt>K / L</dt><dd>止める / 再生</dd></div>
            <div><dt>1 / 2</dt><dd>拡大 / 縮小</dd></div>
            <div><dt>Shift+1 / 2</dt><dd>コマを大きく / 小さく</dd></div>
          </dl>
        </details>
      </div>

      {notice && (
        <div className="tl-notice" onAnimationEnd={() => setNotice(null)}>
          {notice}
        </div>
      )}

      <Inspector
        project={project}
        placed={placed}
        telops={telops}
        selected={selected}
        time={time}
        onChange={apply}
        onSelect={setSelected}
      />

      <Viewer project={project} player={player} />

      {/*
        🔴 書き出し中は何が起きているか出し続けること。
           数分〜十数分かかるので、黙っていると固まったと思われる。
      */}
      {exporting && (
        <div className="tl-exporting" role="status">
          {exporting}
          <button onClick={() => void window.app?.cancel?.()}>中止</button>
        </div>
      )}

      <Timeline
        /*
          🔴 空のときに 1 秒などを渡さないこと。
             タイムラインは「開いたときの尺」に合わせて倍率を決め、
             それを一度きり行う。空を 1 秒として渡すと、画面幅いっぱいが
             1秒という倍率で固定され、**あとから10分の素材を取り込むと
             横に何十万ピクセルも伸びる**（画面外まで続いて操作できない）。
             0 を渡せば、中身が入るまで倍率決めを待つ。
        */
        duration={duration}
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
