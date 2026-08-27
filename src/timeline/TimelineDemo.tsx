/**
 * メインの編集画面を、実素材なしで触るための入口（?mode=timeline）。
 *
 * 素材は assets/test-a.mp4 / test-b.mp4 を使う。無くても画面は開ける
 * （コマとプレビューが出ないだけ）。作り方:
 *
 *     python scripts/make_test_media.py
 *     cp samples/sample_landscape_solo.mp4 assets/test-a.mp4
 *     cp samples/sample_portrait_solo.mp4 assets/test-b.mp4
 *
 * 🔴 リポジトリには置かない。
 *    実素材（人が映っているもの）はリポジトリに置かない方針なので、
 *    scripts/make_test_media.py が作る合成動画を public/ へ複製して使う。
 *    Electron の media:// はブラウザでは開けないので、ここでは http で渡す
 *    （assetUrl が「すでに URL のもの」はそのまま通す）。
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
      path: `${location.origin}/test-a.mp4`,
      name: 'トーク本編',
      duration: 30,
      hasVideo: true,
      hasAudio: true,
    },
    keeps: [
      { srcStart: 0, srcEnd: 6 },
      { srcStart: 10, srcEnd: 18 },
      { srcStart: 22, srcEnd: 28 },
    ],
    telops: [
      { srcStart: 1.5, srcEnd: 4.2, text: 'はじめまして', style: 'normal' },
      { srcStart: 11, srcEnd: 14, text: '今日の本題です', style: 'emphasis' },
      { srcStart: 23, srcEnd: 26, text: 'まとめると', style: 'normal' },
    ],
  });
  p = importCutResult(p, {
    asset: {
      id: 'broll',
      path: `${location.origin}/test-b.mp4`,
      name: '差し込み映像',
      duration: 30,
      hasVideo: true,
      hasAudio: false,
    },
    keeps: [{ srcStart: 0, srcEnd: 5 }],
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
