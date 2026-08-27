import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { T1Wysiwyg } from './t1/T1Wysiwyg';
import { T2Budoux } from './t2/T2Budoux';
import { ReviewScreen } from './review/ReviewScreen';
import { TelopE2E } from './telop/TelopE2E';
import { ShellDemo } from './shell/ShellDemo';
import { TimelineDemo } from './timeline/TimelineDemo';
import { PacEditor } from './timeline/PacEditor';
import { TimelineE2E } from './timeline/TimelineE2E';
import { CutStage } from './shell/CutStage';
import { TelopStage } from './shell/TelopStage';
import { generateMockCandidates } from './review/mockCandidates';
import './index.css';

// 検証用モードは同じバンドルに同居させる。
// 別ページにすると「本番と同じビルド経路を通っているか」が怪しくなるため。
const mode = new URLSearchParams(location.search).get('mode');

/** テロップ画面の確認用。カットも触れる状態にする */
function TelopDemo() {
  const texts = [
    'これ、めちゃくちゃ硬くていいな',
    'このやり方がいちばん早いと思います',
    'ここ、ちょっと注意してください',
    '結論から言うと、やらなくていいです',
    'つまり こういうことです',
  ];
  const cards = Array.from({ length: 24 }, (_, i) => {
    const s = 4 + i * 24.5;
    const text = texts[i % texts.length];
    return {
      id: `t${i}`,
      unitId: `u${i}`,
      srcStart: Number(s.toFixed(2)),
      srcEnd: Number((s + 2.8).toFixed(2)),
      text,
      lines: [text],
      style: (['normal', 'note', 'emphasis'] as const)[i % 3],
      reason: '',
      needsCheck: i % 6 === 2,
      confidence: i % 6 === 2 ? 0.4 : 0.95,
      lowWords: 0,
      fontScale: 1,
      offsetX: 0,
      offsetY: 0,
    };
  });
  const [cutRegions, setCutRegions] = useState(() =>
    generateMockCandidates(40).map((c) => ({ id: c.id, start: c.srcStart, end: c.srcEnd })),
  );
  return (
    <TelopStage
      cards={cards}
      frame={{ width: 1920, height: 1080 }}
      duration={640}
      cutRegions={cutRegions}
      onCutsChange={setCutRegions}
      onExport={(cs) => console.log('テロップ', cs.length)}
    />
  );
}

function Root() {
  if (mode === 't1') return <T1Wysiwyg />;
  if (mode === 't2') return <T2Budoux />;
  if (mode === 'telop-e2e') return <TelopE2E />;
  if (mode === 'timeline-e2e') return <TimelineE2E />;
  // 作り直した骨格の見た目と操作感を、実素材なしで確かめる（src/shell/ShellDemo.tsx）
  if (mode === 'shell') return <ShellDemo />;
  // 作り直したメインの編集画面（素材を並べる方）を触る（src/timeline/）
  if (mode === 'timeline') return <TimelineDemo />;
  if (mode === 'editor') return <PacEditor />;
  /*
    作り直す前の一本道の画面。
    🔴 消さずに残すこと。並べる画面で何か起きたときに、
       ここに戻れば今まで通りの手順で書き出せる。逃げ道を断たない。
  */
  if (mode === 'classic') return <App />;
  if (mode === 'telop') return <TelopDemo />;

  // 作り直したカット画面を、モックの候補で触る
  if (mode === 'cut') {
    return (
      <CutStage
        candidates={generateMockCandidates(118)}
        videoDuration={720}
        onExport={(cuts) => console.log('カット', cuts.length, cuts)}
      />
    );
  }
  // モックデータでレビューUIの操作感だけ見たいとき。
  // 「結局何箇所カットされるのか」はこの画面が出す唯一の数字なので、
  // 書き出しへ進むボタンごと出す（押しても書き出しはしない）。
  if (mode === 'review-demo') {
    return <ReviewScreen onExport={(cuts) => console.log('カット', cuts.length, cuts)} />;
  }
  /*
    既定は「素材を並べる画面」。下ごしらえ（自動カット・自動テロップ）は
    その中の子画面として開く。

    🔴 一本道の画面を既定に戻さないこと。
       素材を複数扱えるようにした以上、入口が「動画を1本選ぶ」だと、
       2本目をどう足すのかが画面から分からなくなる。
  */
  return <PacEditor />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
