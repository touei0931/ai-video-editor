// ② 設定画面。文字起こしを始める前に、言語・モデル・テロップの見本を決める。
//
// モデルの選択は「初回だけ大きなダウンロードが走る」ことを必ず見せる。
// 何分も無反応に見えると、壊れたと思って強制終了されるため。

import type { AnalyzeSettings, ModelName, TitleTemplateSummary } from '../lib/types'
import { LANGUAGES, MODELS } from '../lib/types'

interface Props {
  video: { path: string; name: string } | null
  settings: AnalyzeSettings
  template: TitleTemplateSummary | null | undefined
  onChange: (patch: Partial<AnalyzeSettings>) => void
  onPickTemplate: () => void
  onDropTemplate: () => void
  onBack: () => void
  onStart: () => void
}

export function SettingsScreen({
  video,
  settings,
  template,
  onChange,
  onPickTemplate,
  onDropTemplate,
  onBack,
  onStart,
}: Props) {
  const model = MODELS.find((m) => m.name === settings.model)

  return (
    <div className="body">
      <div className="panel" style={{ flex: 1 }}>
        <div className="panel-title">② 設定</div>

        <div className="step-body">
          <div className="settings-grid">
            {/* 素材 */}
            <section className="settings-card">
              <h3>素材</h3>
              <div className="settings-value">{video ? video.name : '未選択'}</div>
            </section>

            {/* 言語 */}
            <section className="settings-card">
              <h3>話している言語</h3>
              <select
                value={settings.language}
                onChange={(e) => onChange({ language: e.target.value })}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
              <p className="settings-note">
                決め打ちにしたほうが精度が上がります。迷ったら「日本語」のままで大丈夫です。
              </p>
            </section>

            {/* モデル */}
            <section className="settings-card">
              <h3>文字起こしの精度</h3>
              <select
                value={settings.model}
                onChange={(e) => onChange({ model: e.target.value as ModelName })}
              >
                {MODELS.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.label}
                  </option>
                ))}
              </select>
              {model && (
                <p className="settings-note">
                  {model.description}
                  <br />
                  <span className="warn">
                    初回のみ約 {model.downloadSize} のダウンロードが走ります（2回目以降はありません）
                  </span>
                </p>
              )}
            </section>

            {/* テロップの見本 */}
            <section className="settings-card">
              <h3>テロップの見た目</h3>
              {template ? (
                <div className="settings-value">
                  {template.effectName}
                  <span className="settings-sub">
                    {template.font} {template.fontFace} / {template.fontSize}px
                  </span>
                </div>
              ) : (
                <div className="settings-value warn">未設定（標準のタイトルになります）</div>
              )}
              <div className="inline" style={{ marginTop: 6 }}>
                <button onClick={onPickTemplate}>見本を読み込む</button>
                {template && <button onClick={onDropTemplate}>外す</button>}
              </div>
              <p className="settings-note">
                いつも使っているテロップを1つ置いた状態で FCP から XML を書き出し、それを選んでください。
                見た目をそのまま写すので、仕上がりが完全に一致します。
              </p>
            </section>
          </div>
        </div>

        <div className="step-footer">
          <button onClick={onBack}>戻る</button>
          <span className="spacer" />
          <button className="primary big" disabled={!video} onClick={onStart}>
            テロップ作成開始
          </button>
        </div>
      </div>
    </div>
  )
}
