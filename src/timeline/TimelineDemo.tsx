/**
 * メインの編集画面を、実素材なしで触るための入口（?mode=timeline）。
 *
 * 🔴 素材のファイルは開かない。
 *    置く場所・分ける・詰める、といった編集の当たり判定を見るためのもの。
 *    実ファイルを要求すると、手元に動画が無いと確かめられない。
 */

import { useState } from 'react';
import { TimelineScreen } from './TimelineScreen';
import { emptyProject, importCutResult, type Project } from './project';

/** 自動カットの子画面から返ってきた、という体の中身 */
function seeded(): Project {
  let p = emptyProject();
  p = importCutResult(p, {
    asset: {
      id: 'talk',
      path: '/dummy/talk.mp4',
      name: 'トーク本編',
      duration: 300,
      hasVideo: true,
      hasAudio: true,
    },
    keeps: [
      { srcStart: 0, srcEnd: 12 },
      { srcStart: 18, srcEnd: 47 },
      { srcStart: 52, srcEnd: 70 },
      { srcStart: 88, srcEnd: 121 },
    ],
    telops: [
      { srcStart: 1.5, srcEnd: 4.2, text: 'はじめまして', style: 'normal' },
      { srcStart: 20, srcEnd: 23.5, text: '今日の本題です', style: 'emphasis' },
      { srcStart: 30, srcEnd: 33, text: 'まず結論から', style: 'normal' },
      { srcStart: 55, srcEnd: 58.4, text: 'ここが大事', style: 'emphasis' },
      { srcStart: 92, srcEnd: 95, text: 'まとめると', style: 'normal' },
    ],
  });
  p = importCutResult(p, {
    asset: {
      id: 'broll',
      path: '/dummy/broll.mp4',
      name: '差し込み映像',
      duration: 60,
      hasVideo: true,
      hasAudio: false,
    },
    keeps: [{ srcStart: 0, srcEnd: 8 }],
  });
  return p;
}

export function TimelineDemo() {
  const [project, setProject] = useState<Project>(seeded);

  return (
    <div style={{ height: '100vh' }}>
      <TimelineScreen
        project={project}
        onChange={setProject}
        /*
          🔴 ブラウザで開いているときは押させないこと。
             ファイル選択は Electron の口（window.app）でしかできない。
             無い所で押せると、押しても何も起きない不具合に見える。
        */
        pickFile={window.app ? () => window.app.pickVideo() : undefined}
        onImport={() => window.alert('取り込みの子画面は次の段階でつなぎます')}
      />
    </div>
  );
}
