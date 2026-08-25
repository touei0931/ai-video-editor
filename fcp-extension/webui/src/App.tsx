// パネル全体。①動画を選ぶ → ②設定 → ③解析 → ④カット → ⑤テロップ → 書き出し。
//
// ②と③の順番は入れ替えられない。
// フィラー（「えー」）と言い直しは「何と言ったか」が分からないと判定できないので、
// カット候補は文字起こしの後にしか作れない。だから1回の解析で両方を作る。

import { useState } from 'react'
import { CutScreen } from './screens/CutScreen'
import { TelopScreen } from './screens/TelopScreen'
import { SelectScreen } from './screens/SelectScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { AnalyzingScreen } from './screens/AnalyzingScreen'
import { useStore } from './lib/store'
import { isInFCP, runAnalysis, sendToFCP } from './lib/bridge'
import type { AnalyzeSettings, Step } from './lib/types'

const STEPS: { key: Step; label: string }[] = [
  { key: 'select', label: '① 動画' },
  { key: 'settings', label: '② 設定' },
  { key: 'analyzing', label: '③ 解析' },
  { key: 'cut', label: '④ カット' },
  { key: 'telop', label: '⑤ テロップ' },
]

export function App() {
  const store = useStore()
  const [step, setStep] = useState<Step>('select')
  const [video, setVideo] = useState<{ path: string; name: string } | null>(null)
  const [settings, setSettings] = useState<AnalyzeSettings>({
    language: 'ja',
    model: 'large-v3-turbo',
  })
  const [progress, setProgress] = useState({ stage: '準備しています', ratio: 0 })
  const [analyzeError, setAnalyzeError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const done = step === 'cut' || step === 'telop'

  const start = async () => {
    if (!video) return
    setAnalyzeError(null)
    setProgress({ stage: '準備しています', ratio: 0 })
    setStep('analyzing')
    try {
      const result = await runAnalysis({ videoPath: video.path, ...settings }, (stage, ratio) =>
        setProgress({ stage, ratio }),
      )
      store.applyAnalysis(result)
      setStep('cut')
    } catch (e) {
      setAnalyzeError(String(e))
    }
  }

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

        <div className="steps">
          {STEPS.map((s) => {
            const reachable =
              s.key === step ||
              (done && (s.key === 'cut' || s.key === 'telop')) ||
              (step !== 'analyzing' && (s.key === 'select' || s.key === 'settings'))
            return (
              <button
                key={s.key}
                className={`step ${step === s.key ? 'active' : ''}`}
                disabled={!reachable}
                onClick={() => reachable && setStep(s.key)}
              >
                {s.label}
              </button>
            )
          })}
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
          disabled={sending || !done}
          title="FCPXML を書き出します。Final Cut Pro の「ファイル > 読み込む > XML」で取り込みます"
        >
          {sending ? '書き出し中…' : '⑥ FCPXML を書き出す'}
        </button>
      </div>

      {step === 'select' && (
        <SelectScreen video={video} onPicked={setVideo} onNext={() => setStep('settings')} />
      )}

      {step === 'settings' && (
        <SettingsScreen
          video={video}
          settings={settings}
          template={store.state?.template}
          onChange={(patch) => setSettings((s) => ({ ...s, ...patch }))}
          onPickTemplate={() => void store.pickTemplate()}
          onDropTemplate={() => void store.dropTemplate()}
          onBack={() => setStep('select')}
          onStart={() => void start()}
        />
      )}

      {step === 'analyzing' && (
        <AnalyzingScreen
          stage={progress.stage}
          ratio={progress.ratio}
          error={analyzeError}
          onCancel={() => setStep('settings')}
        />
      )}

      {step === 'cut' && <CutScreen store={store} />}
      {step === 'telop' && <TelopScreen store={store} />}
    </div>
  )
}
