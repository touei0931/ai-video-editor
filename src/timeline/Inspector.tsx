/**
 * インスペクタ。選んだものを直す場所（Final Cut の右パネル）。
 *
 * 🔴 ここが無いと、選べても直せない。
 *    テロップの本文を直せないアプリは、音声認識の誤りをそのまま出すことになる。
 *    固有名詞と専門用語は必ず外れるので、直せないなら公開できない。
 *
 * 🔴 直したら即座に反映すること（確定ボタンを置かない）。
 *    プレビューは同じ Canvas を通しているので、打った文字がその場で
 *    書き出しと同じ見た目で出る。確定を挟むと、その往復ぶん確かめが遅くなる。
 *
 * 🔴 テロップの時刻は「素材の中の時刻」で持たれている。
 *    画面には**タイムライン上の時刻**を出し、入れるときに直すこと。
 *    そのまま入れると、クリップを動かした瞬間にテロップだけ取り残される。
 */

import { useCallback } from 'react';
import { clock } from '../shell/Timeline';
import {
  GAIN_RANGE,
  clipsOnLane,
  isGap,
  removeLane,
  renameLane,
  moveTelopEdge,
  removeTelop,
  renameClip,
  setClipGain,
  updateTelop,
  type PlacedClip,
  type PlacedTelop,
  type Project,
} from './project';

interface Props {
  project: Project;
  placed: readonly PlacedClip[];
  telops: readonly PlacedTelop[];
  selected: string | null;
  time: number;
  onChange(next: Project, message?: string): void;
  onSelect(id: string | null): void;
  /** 素材の一覧から「置く」を押したとき */
  onPlaceAsset?(assetId: string): void;
}

/**
 * 選んでいるものが何かを解く。
 *
 * テロップの印は `telop:<テロップの id>:<クリップの id>` の形。
 * 🔴 id に : を入れないこと（newId は入れない）。入れるとここで割れる。
 */
export function parseSelection(
  selected: string | null,
): { kind: 'telop'; telopId: string; clipId: string } | { kind: 'clip'; clipId: string } | null {
  if (!selected) return null;
  if (selected.startsWith('telop:')) {
    const [telopId, clipId] = selected.slice('telop:'.length).split(':');
    return telopId && clipId ? { kind: 'telop', telopId, clipId } : null;
  }
  return { kind: 'clip', clipId: selected };
}

export function Inspector({
  project,
  placed,
  telops,
  selected,
  time,
  onChange,
  onSelect,
  onPlaceAsset,
}: Props) {
  const sel = parseSelection(selected);
  const fps = project.settings.fps;
  const frame = 1 / fps;

  const clipOf = useCallback((id: string) => placed.find((c) => c.id === id) ?? null, [placed]);

  /* ------------------------------------------------------------ テロップ */
  if (sel?.kind === 'telop') {
    const shown = telops.find((t) => t.id === sel.telopId && t.clipId === sel.clipId);
    const telop = project.telops.find((t) => t.id === sel.telopId);
    const clip = clipOf(sel.clipId);
    if (!shown || !telop || !clip) {
      return <Empty project={project} onPlaceAsset={onPlaceAsset} onChange={onChange} note="選んでいたテロップが無くなりました" />;
    }

    const edge = (which: 'start' | 'end', delta: number) =>
      onChange(
        moveTelopEdge(project, telop.id, clip, which, (which === 'start' ? shown.start : shown.end) + delta),
      );

    const toPlayhead = (which: 'start' | 'end') =>
      onChange(moveTelopEdge(project, telop.id, clip, which, time), '白線に合わせました');

    return (
      <aside className="tl-inspector">
        <h2>テロップ</h2>

        <label className="tl-field">
          <span>本文</span>
          <textarea
            value={telop.text}
            rows={3}
            onChange={(e) => onChange(updateTelop(project, telop.id, { text: e.target.value }))}
            placeholder="ここに文字を入れます"
          />
        </label>

        <label className="tl-field">
          <span>見た目</span>
          <select
            value={telop.style}
            onChange={(e) => onChange(updateTelop(project, telop.id, { style: e.target.value }))}
          >
            {Object.keys(project.styles).map((name) => (
              <option key={name} value={name}>
                {STYLE_LABEL[name] ?? name}
              </option>
            ))}
          </select>
        </label>

        <div className="tl-field">
          <span>出ている時間</span>
          <p className="tl-readout">
            {clock(shown.start)} → {clock(shown.end)}（{(shown.end - shown.start).toFixed(2)} 秒）
          </p>
        </div>

        <TimeNudge label="始まり" onNudge={(d) => edge('start', d)} onPlayhead={() => toPlayhead('start')} frame={frame} />
        <TimeNudge label="終わり" onNudge={(d) => edge('end', d)} onPlayhead={() => toPlayhead('end')} frame={frame} />

        {/*
          🔴 「同じテロップが他のクリップにも出ている」ことを伝えること。
             1つ直したつもりで全部変わるのは、知らないと不具合に見える。
        */}
        {telops.filter((t) => t.id === telop.id).length > 1 && (
          <p className="tl-hint">
            このテロップは {telops.filter((t) => t.id === telop.id).length} か所に出ています。
            直すとすべてに効きます。
          </p>
        )}

        <button
          className="tl-danger"
          onClick={() => {
            onChange(removeTelop(project, telop.id), 'テロップを消しました');
            onSelect(null);
          }}
        >
          このテロップを消す
        </button>
      </aside>
    );
  }

  /* ------------------------------------------------------------ クリップ */
  if (sel?.kind === 'clip') {
    const clip = clipOf(sel.clipId);
    if (!clip) {
      return <Empty project={project} onPlaceAsset={onPlaceAsset} onChange={onChange} note="選んでいたクリップが無くなりました" />;
    }
    if (isGap(clip)) {
      return (
        <aside className="tl-inspector">
          <h2>空き</h2>
          <p className="tl-readout">
            {clock(clip.start)} → {clock(clip.end)}（{(clip.end - clip.start).toFixed(2)} 秒）
          </p>
          <p className="tl-hint">ここには何も映りません。書き出すと黒くなります。</p>
        </aside>
      );
    }

    const asset = project.assets.find((a) => a.id === clip.assetId);
    const lane = project.lanes.find((l) => l.id === clip.laneId);
    const gain = clip.gainDb ?? 0;

    return (
      <aside className="tl-inspector">
        <h2>クリップ</h2>

        <label className="tl-field">
          <span>名前</span>
          <input
            value={clip.name}
            onChange={(e) => onChange(renameClip(project, clip.id, e.target.value))}
          />
        </label>

        <dl className="tl-facts">
          <div>
            <dt>素材</dt>
            <dd title={asset?.path}>{asset?.name ?? '（見つかりません）'}</dd>
          </div>
          <div>
            <dt>レーン</dt>
            <dd>{lane?.name || lane?.kind || '—'}</dd>
          </div>
          <div>
            <dt>置き場所</dt>
            <dd>
              {clock(clip.start)} → {clock(clip.end)}
            </dd>
          </div>
          <div>
            <dt>素材の中</dt>
            <dd>
              {clip.srcStart.toFixed(2)} → {clip.srcEnd.toFixed(2)} 秒
            </dd>
          </div>
          <div>
            <dt>長さ</dt>
            <dd>{(clip.end - clip.start).toFixed(2)} 秒</dd>
          </div>
        </dl>

        {/*
          音量。
          🔴 デシベルで見せること。倍率だと、耳で感じる変化と目盛りが合わない。
        */}
        <label className="tl-field">
          <span>
            音量 <b>{gain === 0 ? '素材のまま' : `${gain > 0 ? '+' : ''}${gain.toFixed(1)} dB`}</b>
          </span>
          <input
            type="range"
            min={GAIN_RANGE.min}
            max={GAIN_RANGE.max}
            step={0.5}
            value={gain}
            disabled={!asset?.hasAudio}
            onChange={(e) => onChange(setClipGain(project, clip.id, Number(e.target.value)))}
          />
        </label>
        <div className="tl-row">
          {[-6, -3, -1, 1, 3, 6].map((d) => (
            <button
              key={d}
              disabled={!asset?.hasAudio}
              onClick={() => onChange(setClipGain(project, clip.id, gain + d))}
            >
              {d > 0 ? `+${d}` : d}
            </button>
          ))}
          <button disabled={gain === 0} onClick={() => onChange(setClipGain(project, clip.id, 0))}>
            戻す
          </button>
        </div>
        {!asset?.hasAudio && <p className="tl-hint">この素材には音がありません。</p>}
      </aside>
    );
  }

  return (
    <Empty
      project={project}
      onPlaceAsset={onPlaceAsset}
      onChange={onChange}
      note="タイムラインでクリップかテロップを選ぶと、ここで直せます。"
    />
  );
}

/**
 * 何も選んでいないとき。素材の一覧を出す。
 *
 * 🔴 一度読んだ素材を、もう一度使えるようにしておくこと。
 *    これが無いと、同じ動画をもう一度置くのに
 *    ファイル選択からやり直すことになる（読み込みも待ち直しになる）。
 *
 * 🔴 空きの余白に置くこと。列を増やすとプレビューが狭くなる。
 */
function Empty({
  note,
  project,
  onPlaceAsset,
  onChange,
}: {
  note: string;
  project: Project;
  onPlaceAsset?(assetId: string): void;
  onChange?(next: Project, message?: string): void;
}) {
  const used = new Map<string, number>();
  for (const c of project.clips) {
    if (!isGap(c)) used.set(c.assetId, (used.get(c.assetId) ?? 0) + 1);
  }

  return (
    <aside className="tl-inspector tl-inspector-empty">
      <h2>インスペクタ</h2>
      <p className="tl-hint">{note}</p>

      {/*
        レーン。
        🔴 足せるのに消せない、という行き止まりを作らないこと。
           間違えて足したレーンが一生残ることになる。
      */}
      {onChange && project.lanes.length > 1 && (
        <>
          <h2>レーン</h2>
          <ul className="tl-lanes">
            {[...project.lanes].reverse().map((l) => (
              <li key={l.id}>
                <input
                  value={l.name}
                  placeholder={LANE_KIND_LABEL[l.kind]}
                  onChange={(e) => onChange(renameLane(project, l.id, e.target.value))}
                />
                <span className="tl-lane-kind">{LANE_KIND_LABEL[l.kind]}</span>
                <button
                  className="tl-danger"
                  disabled={l.kind === 'main'}
                  title={
                    l.kind === 'main'
                      ? '本編は消せません（土台なので）'
                      : `このレーンと、乗っている ${clipsOnLane(project, l.id)} 本を消します`
                  }
                  onClick={() => {
                    const n = clipsOnLane(project, l.id);
                    onChange(
                      removeLane(project, l.id),
                      n > 0 ? `レーンと ${n} 本を消しました` : 'レーンを消しました',
                    );
                  }}
                >
                  消す
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {project.assets.length > 0 && (
        <>
          <h2>素材</h2>
          <ul className="tl-assets">
            {project.assets.map((a) => (
              <li key={a.id}>
                <div className="tl-asset-name" title={a.path}>
                  {a.name}
                </div>
                <div className="tl-asset-facts">
                  {fmtLen(a.duration)}
                  {a.width && a.height ? ` / ${a.width}×${a.height}` : ''}
                  {!a.hasVideo ? ' / 音だけ' : ''}
                  {used.get(a.id) ? ` / ${used.get(a.id)} 本使用中` : ' / 未使用'}
                </div>
                <button disabled={!onPlaceAsset} onClick={() => onPlaceAsset?.(a.id)}>
                  置く
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}

/** 分:秒 */
function fmtLen(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * 時刻を少しずつ動かす。
 *
 * 🔴 1コマ単位を用意すること。
 *    テロップの出だしが1コマ早いだけで、声より先に文字が出る。
 *    マウスのドラッグでは 1/30 秒には届かない。
 */
function TimeNudge({
  label,
  frame,
  onNudge,
  onPlayhead,
}: {
  label: string;
  frame: number;
  onNudge(delta: number): void;
  onPlayhead(): void;
}) {
  return (
    <div className="tl-row tl-nudge">
      <span className="tl-nudge-label">{label}</span>
      <button onClick={() => onNudge(-frame * 5)} title="5コマ前へ">
        ⏪
      </button>
      <button onClick={() => onNudge(-frame)} title="1コマ前へ">
        ◀
      </button>
      <button onClick={() => onNudge(frame)} title="1コマ後ろへ">
        ▶
      </button>
      <button onClick={() => onNudge(frame * 5)} title="5コマ後ろへ">
        ⏩
      </button>
      <button onClick={onPlayhead} title="再生位置（白線）に合わせる">
        白線へ
      </button>
    </div>
  );
}

/** レーンの種類の呼び名 */
const LANE_KIND_LABEL: Record<string, string> = {
  main: '本編',
  video: '重ね',
  audio: '音',
};

/** 組み込みの雛形の呼び名。名前を付けた雛形はその名前のまま出す */
const STYLE_LABEL: Record<string, string> = {
  normal: '通常',
  note: '補足',
  emphasis: '強調',
};
