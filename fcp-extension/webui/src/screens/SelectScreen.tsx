// ① 動画を選ぶ画面。
// 友達は IT に詳しくないので、置いてある場所を探させず
// 「ここに落とす」か「選ぶ」の2択だけにする。

import { useState } from 'react'
import { pickVideo } from '../lib/bridge'

interface Props {
  video: { path: string; name: string } | null
  onPicked: (video: { path: string; name: string }) => void
  onNext: () => void
}

export function SelectScreen({ video, onPicked, onNext }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const choose = async () => {
    setBusy(true)
    setError(null)
    try {
      const picked = await pickVideo()
      if (picked) onPicked(picked)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="body">
      <div className="panel" style={{ flex: 1 }}>
        <div className="panel-title">① 動画を選ぶ</div>

        <div className="step-body">
          <div className="dropzone">
            <div className="dropzone-icon">🎬</div>
            {video ? (
              <>
                <div className="dropzone-name">{video.name}</div>
                <div className="dropzone-path">{video.path}</div>
              </>
            ) : (
              <div className="dropzone-hint">
                下ごしらえしたい動画を選んでください
                <br />
                （はじめて使うときは、動画が入っているフォルダの許可を1回だけ聞かれます）
              </div>
            )}
            <button className="primary" onClick={() => void choose()} disabled={busy}>
              {busy ? '選んでいます…' : video ? '別の動画を選ぶ' : '動画を選ぶ'}
            </button>
            {error && <div className="warn">{error}</div>}
          </div>
        </div>

        <div className="step-footer">
          <span className="spacer" />
          <button className="primary" disabled={!video} onClick={onNext}>
            次へ（設定）
          </button>
        </div>
      </div>
    </div>
  )
}
