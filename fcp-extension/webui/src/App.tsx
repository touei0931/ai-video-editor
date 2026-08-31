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
import { DEFAULT_TELOP_MAX_CHARS } from './lib/splitTelop'
import { CUT_PRESETS } from './lib/types'
import type { AnalyzeSettings, ProjectState, Step } from './lib/types'

const STEPS: { key: Step; label: string }[] = [
  { key: 'select', label: '① 動画' },
  { key: 'settings', label: '② 設定' },
  { key: 'analyzing', label: '③ 解析' },
  { key: 'cut', label: '④ カット' },
  { key: 'telop', label: '⑤ テロップ' },
]

/** 素材の大きさとコマ数。読めていなければ、その理由ごと警告として出す */
function MediaBadge({ state }: { state: ProjectState }) {
  const reason = state.report?.videoInfoError
  if (!state.width || !state.height) {
    return (
      <span
        className="build warn"
        title={
          reason
            ? `理由: ${reason}`
            : '素材の大きさが読めませんでした'
        }
      >
        素材の大きさが読めません（1920x1080 で書き出します）
      </span>
    )
  }
  return (
    <span className="build" title="この大きさ・コマ数でプロジェクトを組みます">
      {state.width}×{state.height}
      {state.fps ? ` / ${Math.round(state.fps * 100) / 100}fps` : ''}
    </span>
  )
}

/** エンジンが実際に使ったカットの設定。選んだものと食い違っていたら警告する */
function CutSettingBadge({ state, asked }: { state: ProjectState; asked: AnalyzeSettings }) {
  const used = state.report?.cutPreset
  if (!used) return null
  const label = (name: string) => CUT_PRESETS.find((p) => p.name === name)?.label ?? name
  const usedAside = state.report?.detectAside !== false
  const n = state.report?.cutCandidates

  // 選んだものと違うものが使われていたら、それが原因になりうる
  const mismatch = used !== asked.cutPreset || usedAside !== asked.detectAside
  if (mismatch) {
    return (
      <span
        className="build warn"
        title={
          `選んだ設定が解析に届いていません。
` +
          `選んだ: ${label(asked.cutPreset)} / 独り言 ${asked.detectAside ? '入' : '切'}
` +
          `使われた: ${label(used)} / 独り言 ${usedAside ? '入' : '切'}
` +
          `「インストールと確認」をもう一度実行してください（古い本体が動いている可能性があります）`
        }
      >
        設定が届いていません（{label(used)} で解析）
      </span>
    )
  }
  return (
    <span className="build" title="この設定で候補を出しました">
      {label(used)}
      {usedAside ? ' / 独り言 入' : ' / 独り言 切'}
      {typeof n === 'number' ? ` / 候補 ${n}` : ''}
    </span>
  )
}

export function App() {
  const store = useStore()
  const [step, setStep] = useState<Step>('select')
  const [video, setVideo] = useState<{ path: string; name: string } | null>(null)
  const [settings, setSettings] = useState<AnalyzeSettings>({
    language: 'ja',
    model: 'large-v3-turbo',
    // 既定は「ふつう」。詰めた設定を長尺に当てると、意図して置いた間まで消える
    cutPreset: 'talk',
    // 必ず人が1件ずつ見る側に入るので、既定で挙げる
    detectAside: true,
    telopMaxChars: DEFAULT_TELOP_MAX_CHARS,
  })
  const [progress, setProgress] = useState({ stage: '準備しています', ratio: 0 })
  const [analyzeError, setAnalyzeError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  /*
    書き出しの進み具合。
    🔴 黙って待たせないこと。保存先を選ぶ・組み立てる・書き出すで
       十数秒〜数分かかる。何も出ないと「失敗した」と受け取られる。
  */
  const [sendStage, setSendStage] = useState<string | null>(null)
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
      // 🔴 1枚に入れる文字数は設定から。決め打ちにしない
      store.applyAnalysis(result, settings.telopMaxChars)
      setStep('cut')
    } catch (e) {
      setAnalyzeError(String(e))
    }
  }

  const send = async () => {
    if (!store.state) return
    setSending(true)
    setMessage(null)
    setSendStage('保存先を選んでください')
    try {
      const res = await sendToFCP(
        {
          cuts: store.approvedCuts,
          telops: store.state.telops,
          styles: store.state.styles,
          /*
            🔴 動画のパスを必ず渡すこと。
               渡さないと、書き出した XML に**映像が入らない**（テロップだけ）。
               Final Cut は文句を言わずに読み込むので、開くまで気づけない。
          */
          mediaPath: video?.path ?? null,
          // 🔴 素材の本当の長さ。無いと書き出し側が見積もることになり、
          //    Final Cut が読み込みを拒む
          durationSec: store.state.durationSec,
          // 🔴 素材と同じ大きさで組む。無いと縦動画が横向きに収まる
          width: store.state.width,
          height: store.state.height,
          // host は FCP から読んだ生の値なので、数のときだけ渡す
          /*
            🔴 コマ数は素材のものを先に使うこと。
               FCP のプロジェクト側の値を優先すると、素材と違うコマ数で組まれ、
               カットの切れ目が半コマずれる。
          */
          fps:
            store.state.fps ??
            (typeof store.state.host?.fps === 'number' ? store.state.host.fps : undefined),
          /*
            🔴 何で作ったかを一緒に渡すこと。
               書き出した XML に1行残るので、後からそれだけで
               版・設定・件数が追える。困ったときに送ってもらうのは
               XML なので、そこに書いておくのが一番確実。
          */
          meta: {
            build: __PAC_BUILD__,
            cutPreset: store.state.report?.cutPreset ?? settings.cutPreset,
            detectAside: store.state.report?.detectAside ?? settings.detectAside,
            telopMaxChars: settings.telopMaxChars,
          },
        },
        (stage) => setSendStage(stage),
      )
      setMessage(res.message)
    } catch (e) {
      setMessage(`失敗しました: ${String(e)}`)
    } finally {
      setSending(false)
      setSendStage(null)
    }
  }

  return (
    <div className="app">
      <div className="toolbar">
        <span className="brand">PAC</span>
        {/*
          🔴 版を必ず出すこと。
             出していないと、直したものを渡しても「本当にそれが動いているのか」が
             キャプチャから分からない。実際に古い版のまま何度も試してもらった。
        */}
        <span className="build" title="この画面の版（不具合を伝えるときは一緒に教えてください）">
          {__PAC_BUILD__}
        </span>
        {/*
          🔴 素材の大きさとコマ数を必ず出すこと。
             書き出すプロジェクトはこの値で組む。読めないと 1920x1080 に倒れ、
             縦の素材が枠の 0.316 倍で真ん中に小さく出る。
             出していなかったため、3回の配布で誰も気づけなかった（2026-08-31）。
        */}
        {store.state && <MediaBadge state={store.state} />}
        {/*
          🔴 エンジンが実際に使った設定を出すこと。
             選んだものが途中で落ちても、候補が少ないとしか見えない。
             選んだ側と使った側を突き合わせて、食い違いをその場で見せる。
        */}
        {store.state && <CutSettingBadge state={store.state} asked={settings} />}

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

        {/* 🔴 途中経過を出すこと。黙って待たせると「失敗した」と受け取られる */}
        {sendStage && (
          <span style={{ color: 'var(--text-dim)' }}>書き出し: {sendStage}</span>
        )}
        {!sendStage && message && (
          <span style={{ color: 'var(--text-dim)' }}>{message}</span>
        )}
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

      {step === 'cut' && <CutScreen store={store} onNext={() => setStep('telop')} />}
      {step === 'telop' && <TelopScreen store={store} />}
    </div>
  )
}
