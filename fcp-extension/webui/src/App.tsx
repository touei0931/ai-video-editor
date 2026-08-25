import { useState } from 'react'
import { CutScreen } from './screens/CutScreen'
import { TelopScreen } from './screens/TelopScreen'
import { useStore } from './lib/store'
import { isInFCP, sendToFCP } from './lib/bridge'

type Tab = 'cut' | 'telop'

export function App() {
  const store = useStore()
  const [tab, setTab] = useState<Tab>('cut')
  const [sending, setSending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const send = async () => {
    if (!store.state) return
    setSending(true)
    setMessage(null)
    try {
      const res = await sendToFCP({
        cuts: store.approvedCuts,
        telops: store.state.telops,
        styles: store.state.styles,
      })
      setMessage(res.message)
    } catch (e) {
      setMessage(`失敗しました: ${String(e)}`)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="app">
      <div className="toolbar">
        <span className="brand">PAC</span>
        <div className="tabs">
          <button className={`tab ${tab === 'cut' ? 'active' : ''}`} onClick={() => setTab('cut')}>
            カット
          </button>
          <button className={`tab ${tab === 'telop' ? 'active' : ''}`} onClick={() => setTab('telop')}>
            テロップ
          </button>
        </div>

        <span className="spacer" />

        {message && <span style={{ color: 'var(--text-dim)' }}>{message}</span>}
        {!isInFCP && (
          <span className="warn" title="Final Cut Pro の外で動いています">
            開発モード
          </span>
        )}
        {/* 拡張からタイムラインへ直接書き込む API は存在しないので、
            FCPXML を書き出して FCP に読み込ませる形になる */}
        <button
          className="primary"
          onClick={send}
          disabled={sending || !store.state}
          title="FCPXML を書き出します。Final Cut Pro の「ファイル > 読み込む > XML」で取り込みます"
        >
          {sending ? '書き出し中…' : 'FCPXML を書き出す'}
        </button>
      </div>

      {tab === 'cut' ? <CutScreen store={store} /> : <TelopScreen store={store} />}
    </div>
  )
}
