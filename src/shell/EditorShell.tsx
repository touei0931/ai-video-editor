/**
 * 編集アプリの骨格。段階が変わっても**場所は動かさない**。
 *
 * 🔴 これが作り直しの本体。
 *    以前は段階ごとに画面まるごと入れ替えていたので、
 *    ボタンの位置も見るべき場所も毎回変わっていた。
 *    Final Cut に慣れた友達には「他の編集ソフトと違い過ぎて違和感」だった。
 *
 * 配置（Final Cut / Premiere / DaVinci に共通する形）:
 *
 *     ┌──────────────────────────────────────┐
 *     │ ツールバー（今どの段階か・進む戻る）    │
 *     ├───────────────────────┬──────────────┤
 *     │ ビューア               │ インスペクタ  │
 *     │ （映像と再生操作）      │ （選んだ物）  │
 *     ├───────────────────────┴──────────────┤
 *     │ タイムライン（素材全体・端をドラッグ）  │
 *     └──────────────────────────────────────┘
 */

import type { ReactNode } from 'react';
import { Resizer, useLayout } from './Resizer';
import { useShellInfo } from './ShellInfo';
import './shell.css';

export type StepId = 'source' | 'cut' | 'telop' | 'framing' | 'export';

export const STEPS: { id: StepId; label: string }[] = [
  { id: 'source', label: '素材' },
  { id: 'cut', label: 'カット' },
  { id: 'telop', label: 'テロップ' },
  { id: 'framing', label: '画角' },
  { id: 'export', label: '書き出し' },
];

export interface EditorShellProps {
  step: StepId;
  /** 済んだ段階。丸に色が付く */
  done?: StepId[];
  /** ツールバーの右側。段階ごとの「進む／やめる」を置く */
  toolbar?: ReactNode;
  /** ビューアの中身。映像でもキャンバスでもよい */
  viewer: ReactNode;
  /** ビューアの下の再生操作 */
  transport?: ReactNode;
  /** 右のインスペクタ。見出しと中身を分けて渡す */
  inspectorTitle: string;
  inspector: ReactNode;
  /** 下のタイムライン。Timeline をそのまま渡す */
  timeline: ReactNode;
}

export function EditorShell({
  step,
  done = [],
  toolbar,
  viewer,
  transport,
  inspectorTitle,
  inspector,
  timeline,
}: EditorShellProps) {
  const { layout, set, reset } = useLayout();
  const info = useShellInfo();
  const fps = info.media ? Math.round(info.media.fps * 100) / 100 : 0;

  return (
    <div
      className="fcp"
      style={
        {
          '--inspector-w': `${layout.inspector}px`,
          '--timeline-h': `${layout.timeline}px`,
        } as React.CSSProperties
      }
    >
      <header className="fcp-toolbar">
        <span className="fcp-brand">PAC</span>
        {/*
          🔴 版・素材・使った設定は必ず出す（ShellInfo.ts の注意書き）。
             素材の大きさが読めていないときは、そのことを警告として出す。
        */}
        {info.version && (
          <span className="fcp-badge" title="この画面の版（不具合を伝えるときは一緒に教えてください）">
            v{info.version}
          </span>
        )}
        {info.media !== undefined &&
          (info.media && info.media.width > 0 && info.media.height > 0 ? (
            <span className="fcp-badge" title="この大きさ・コマ数で書き出します">
              {info.media.width}×{info.media.height}
              {fps > 0 ? ` / ${fps}fps` : ''}
            </span>
          ) : (
            <span className="fcp-badge warn" title="素材の大きさが読めませんでした">
              素材の大きさが読めません（1920x1080 で書き出します）
            </span>
          ))}
        {info.analysis && (
          <span className="fcp-badge" title="この設定で候補を出しました">
            {info.analysis.paceLabel}
            {info.analysis.detectAside ? ' / 独り言 入' : ' / 独り言 切'}
            {` / 候補 ${info.analysis.candidates}`}
          </span>
        )}
        <nav className="fcp-steps" aria-label="手順">
          {STEPS.map((s, i) => {
            const state = s.id === step ? 'now' : done.includes(s.id) ? 'done' : '';
            return (
              <span
                key={s.id}
                className={`fcp-step ${state}`}
                aria-current={s.id === step ? 'step' : undefined}
              >
                <span className="n">{done.includes(s.id) && s.id !== step ? '✓' : i + 1}</span>
                {s.label}
              </span>
            );
          })}
        </nav>
        <div className="fcp-spacer" />
        {toolbar}
        <button
          className="icon"
          onClick={reset}
          title="パネルの幅と高さを既定に戻す"
          aria-label="配置を戻す"
        >
          ⤢
        </button>
      </header>

      <section className="fcp-viewer" aria-label="ビューア">
        <div className="fcp-stage">{viewer}</div>
        {transport && <div className="fcp-transport">{transport}</div>}
      </section>

      <Resizer
        direction="col"
        value={layout.inspector}
        onChange={(v) => set('inspector', v)}
        invert
        label="右のパネルの幅"
      />

      <aside className="fcp-inspector" aria-label={inspectorTitle}>
        <div className="fcp-insp-head">{inspectorTitle}</div>
        <div className="fcp-insp-body">{inspector}</div>
      </aside>

      <Resizer
        direction="row"
        value={layout.timeline}
        onChange={(v) => set('timeline', v)}
        invert
        label="タイムラインの高さ"
      />

      {timeline}
    </div>
  );
}
