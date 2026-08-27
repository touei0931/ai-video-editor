/**
 * アプリの入れ物。並べる画面（メイン）と、下ごしらえの子画面を切り替える。
 *
 * 🔴 子画面は**閉じるまで作り直さないこと**。
 *    取り込みのたびに作り直すと、解析の途中で戻ってきたときに
 *    最初からやり直しになる。開いている間は同じものを出し続ける。
 *
 * 🔴 メインを外さないこと（画面から消さない）。
 *    子画面を出している間もメインは生かしておく。作り直すと、
 *    それまで並べたものと再生位置が消える。
 */

import { useCallback, useState } from 'react';
import { App } from '../App';
import { TimelineScreen } from './TimelineScreen';
import { emptyProject, type CutResult, type Project } from './project';
import './timeline-screen.css';

export function PacEditor() {
  const [project, setProject] = useState<Project>(emptyProject);
  const [importing, setImporting] = useState(false);

  /*
    子画面から受け取った下ごしらえの結果。

    🔴 ここで並べないこと。並べる画面に渡す。
       置き先は再生位置で決まるし、取り消し（⌘Z）にも乗せたい。
       どちらもあちらが持っている。
  */
  const [incoming, setIncoming] = useState<CutResult | null>(null);
  const receive = useCallback((result: CutResult) => {
    setIncoming(result);
    setImporting(false);
  }, []);

  return (
    <div className="pac-root">
      <div className="pac-main" aria-hidden={importing}>
        <TimelineScreen
          project={project}
          onChange={setProject}
          active={!importing}
          incoming={incoming}
          onIncomingDone={() => setIncoming(null)}
          pickFile={window.app ? () => window.app.pickVideo() : undefined}
          onImport={() => setImporting(true)}
        />
      </div>

      {importing && (
        <div className="pac-child" role="dialog" aria-label="下ごしらえ">
          <div className="pac-child-bar">
            <strong>下ごしらえ</strong>
            <span>自動カットと自動テロップ。終わったら「タイムラインに送る」を押してください</span>
            <button onClick={() => setImporting(false)}>閉じる</button>
          </div>
          <div className="pac-child-body">
            <App onSendToTimeline={receive} />
          </div>
        </div>
      )}
    </div>
  );
}
