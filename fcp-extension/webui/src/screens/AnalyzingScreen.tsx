// ③ 解析中の画面。
//
// 文字起こしとカット候補は同じ1回の解析で作る。
// フィラー（「えー」）と言い直しは「何と言ったか」が分からないと判定できないので、
// カットだけ先に出すことはできない。

interface Props {
  stage: string
  ratio: number
  error: string | null
  onCancel: () => void
}

export function AnalyzingScreen({ stage, ratio, error, onCancel }: Props) {
  const percent = Math.round(Math.max(0, Math.min(1, ratio)) * 100)

  return (
    <div className="body">
      <div className="panel" style={{ flex: 1 }}>
        <div className="panel-title">③ 解析中</div>

        <div className="step-body center">
          {error ? (
            <div className="analyze-box">
              <div className="analyze-stage warn">うまくいきませんでした</div>
              <div className="settings-note">{error}</div>
              <button onClick={onCancel}>設定に戻る</button>
            </div>
          ) : (
            <div className="analyze-box">
              <div className="analyze-stage">{stage}</div>
              <div className="progress">
                <div className="progress-bar" style={{ width: `${percent}%` }} />
              </div>
              <div className="analyze-percent">{percent}%</div>
              <p className="settings-note">
                初回はモデルのダウンロードが走るので、しばらく進みません。
                そのまま待っていて大丈夫です。
              </p>
              <button onClick={onCancel}>中止する</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
