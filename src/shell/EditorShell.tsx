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
  return (
    <div className="fcp">
      <header className="fcp-toolbar">
        <span className="fcp-brand">PAC</span>
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
      </header>

      <section className="fcp-viewer" aria-label="ビューア">
        <div className="fcp-stage">{viewer}</div>
        {transport && <div className="fcp-transport">{transport}</div>}
      </section>

      <aside className="fcp-inspector" aria-label={inspectorTitle}>
        <div className="fcp-insp-head">{inspectorTitle}</div>
        <div className="fcp-insp-body">{inspector}</div>
      </aside>

      {timeline}
    </div>
  );
}
