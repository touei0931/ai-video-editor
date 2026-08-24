/**
 * 骨格と操作感の確認用（`?mode=shell`）。
 *
 * 実素材が無くても、配置・配色・端のドラッグを触って確かめられるようにする。
 * 🔴 実素材（友達が映っているもの）は絶対にリポジトリに入れないので、
 *    見た目の詰めは必ずここでやること。
 */

import { useMemo, useState } from 'react';
import { EditorShell, type StepId } from './EditorShell';
import { Timeline, clock, type TimelineRegion } from './Timeline';

const DURATION = 612; // 10分12秒の素材を想定
const FPS = 30;

function seed(): TimelineRegion[] {
  // それらしい間隔でカット候補を撒く。短いものと長いものを混ぜる
  const out: TimelineRegion[] = [];
  let t = 4;
  let i = 0;
  while (t < DURATION - 8) {
    const len = [0.35, 0.6, 1.2, 2.4, 0.9][i % 5];
    const kind = i % 7 === 3 ? 'hold' : 'cut';
    out.push({
      id: `c${i}`,
      start: Number(t.toFixed(2)),
      end: Number((t + len).toFixed(2)),
      kind,
      label: kind === 'hold' ? 'あとで見る' : ['無音', 'えー', 'あの', '言い直し'][i % 4],
    });
    t += len + [6, 11, 4, 18, 9][i % 5];
    i += 1;
  }
  return out;
}

const TELOP_TEXT = [
  'これ、めちゃくちゃ硬くていいな',
  'このやり方がいちばん早いと思います',
  'ここ、ちょっと注意してください',
  '結論から言うと',
  'つまり こういうことです',
];

export function ShellDemo() {
  const [step, setStep] = useState<StepId>('cut');
  const [regions, setRegions] = useState<TimelineRegion[]>(seed);
  const [selected, setSelected] = useState<string | null>(null);
  const [time, setTime] = useState(0);

  const telops = useMemo<TimelineRegion[]>(
    () =>
      Array.from({ length: 26 }, (_, i) => {
        const s = 6 + i * 22.5;
        return {
          id: `t${i}`,
          start: Number(s.toFixed(2)),
          end: Number((s + 2.6).toFixed(2)),
          kind: 'telop' as const,
          label: TELOP_TEXT[i % TELOP_TEXT.length],
        };
      }),
    [],
  );

  const cur = regions.find((r) => r.id === selected) ?? null;
  const curTelop = telops.find((r) => r.id === selected) ?? null;

  const trim = (id: string, start: number, end: number) =>
    setRegions((rs) => rs.map((r) => (r.id === id ? { ...r, start, end } : r)));

  const nudge = (edge: 'start' | 'end', frames: number) => {
    if (!cur) return;
    setRegions((rs) =>
      rs.map((r) => {
        if (r.id !== cur.id) return r;
        const d = frames / FPS;
        if (edge === 'start') return { ...r, start: Math.max(0, Number((r.start + d).toFixed(3))) };
        return { ...r, end: Math.min(DURATION, Number((r.end + d).toFixed(3))) };
      }),
    );
  };

  const counts = {
    cut: regions.filter((r) => r.kind === 'cut').length,
    hold: regions.filter((r) => r.kind === 'hold').length,
  };
  const removed = regions
    .filter((r) => r.kind === 'cut')
    .reduce((a, r) => a + (r.end - r.start), 0);

  return (
    <EditorShell
      step={step}
      done={step === 'telop' ? ['source', 'cut'] : ['source']}
      toolbar={
        <>
          <button onClick={() => setStep('cut')} className={step === 'cut' ? 'on' : ''}>
            カット
          </button>
          <button onClick={() => setStep('telop')} className={step === 'telop' ? 'on' : ''}>
            テロップ
          </button>
          <button className="go">テロップへ進む →</button>
        </>
      }
      viewer={
        <div
          className="fcp-stage-inner"
          style={{
            width: 'min(100%, 900px)',
            aspectRatio: '16 / 9',
            display: 'grid',
            placeItems: 'center',
            border: '1px solid var(--line)',
            borderRadius: 4,
          }}
        >
          <div className="fcp-stage-empty">
            映像はここに出ます
            <br />
            <span style={{ fontSize: 12 }}>{clock(time)}</span>
          </div>
        </div>
      }
      transport={
        <>
          <button className="icon" title="頭出し" onClick={() => setTime(0)}>
            ⏮
          </button>
          <button className="icon" title="再生 / 一時停止">
            ▶
          </button>
          <button className="icon" title="1フレーム戻る" onClick={() => setTime((t) => Math.max(0, t - 1 / FPS))}>
            ◀
          </button>
          <button
            className="icon"
            title="1フレーム進む"
            onClick={() => setTime((t) => Math.min(DURATION, t + 1 / FPS))}
          >
            ▶
          </button>
          <span className="fcp-time">
            <strong>{clock(time)}</strong> / {clock(DURATION)}
          </span>
          <div className="fcp-spacer" />
          <span className="fcp-chip">
            <span className="dot" style={{ background: 'var(--cut)' }} />
            切る {counts.cut}
          </span>
          <span className="fcp-chip">
            <span className="dot" style={{ background: 'var(--hold)' }} />
            保留 {counts.hold}
          </span>
        </>
      }
      inspectorTitle={cur || curTelop ? '選択中のクリップ' : '素材'}
      inspector={
        cur ? (
          <>
            <div className="fcp-field">
              <label>種類</label>
              <div>{cur.label}</div>
            </div>
            <div className="fcp-field">
              <label>始まり</label>
              <div className="fcp-stepper">
                <button onClick={() => nudge('start', -1)}>−1f</button>
                <output>{clock(cur.start)}</output>
                <button onClick={() => nudge('start', 1)}>+1f</button>
              </div>
            </div>
            <div className="fcp-field">
              <label>終わり</label>
              <div className="fcp-stepper">
                <button onClick={() => nudge('end', -1)}>−1f</button>
                <output>{clock(cur.end)}</output>
                <button onClick={() => nudge('end', 1)}>+1f</button>
              </div>
            </div>
            <div className="fcp-field">
              <label>長さ</label>
              <div style={{ fontVariantNumeric: 'tabular-nums' }}>
                {(cur.end - cur.start).toFixed(2)} 秒
              </div>
            </div>
            <p className="fcp-dim">
              タイムラインのクリップの<strong>端をドラッグ</strong>しても伸縮できます。
              Shift を押しながらだとフレームに吸着しません。
            </p>
            <div className="fcp-field">
              <button
                onClick={() =>
                  setRegions((rs) =>
                    rs.map((r) =>
                      r.id === cur.id ? { ...r, kind: r.kind === 'cut' ? 'keep' : 'cut' } : r,
                    ),
                  )
                }
              >
                {cur.kind === 'cut' ? 'ここは残す' : 'ここを切る'}
              </button>
            </div>
          </>
        ) : curTelop ? (
          <>
            <div className="fcp-field">
              <label>文言</label>
              <div>{curTelop.label}</div>
            </div>
            <div className="fcp-field">
              <label>出る時間</label>
              <div style={{ fontVariantNumeric: 'tabular-nums' }}>
                {clock(curTelop.start)} 〜 {clock(curTelop.end)}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="fcp-field">
              <label>長さ</label>
              <div>{clock(DURATION)}</div>
            </div>
            <div className="fcp-field">
              <label>切ると短くなる分</label>
              <div>{removed.toFixed(1)} 秒</div>
            </div>
            <p className="fcp-dim">
              タイムラインのクリップを選ぶと、ここで細かく直せます。
            </p>
          </>
        )
      }
      timeline={
        <Timeline
          duration={DURATION}
          fps={FPS}
          currentTime={time}
          onSeek={setTime}
          selectedId={selected}
          onSelect={setSelected}
          onTrim={trim}
          tracks={[
            { id: 'cut', label: 'カット', regions, showSource: true, height: 56 },
            { id: 'telop', label: 'テロップ', regions: telops, height: 34 },
          ]}
        />
      }
    />
  );
}
