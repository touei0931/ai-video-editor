// ② 設定画面。文字起こしを始める前に、言語・モデル・テロップの見本を決める。
//
// モデルの選択は「初回だけ大きなダウンロードが走る」ことを必ず見せる。
// 何分も無反応に見えると、壊れたと思って強制終了されるため。

import { useEffect, useState } from 'react'
import type {
  AnalyzeSettings, CutMemorySummary, CutPreset, ModelName, TitleTemplateSummary,
} from '../lib/types'
import { forgetCutMemory, loadCutMemory } from '../lib/bridge'
import { CUT_PRESETS, LANGUAGES, MODELS } from '../lib/types'
import { DEFAULT_TELOP_MAX_CHARS, TELOP_MAX_CHARS_RANGE } from '../lib/splitTelop'

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
  const pace = CUT_PRESETS.find((p) => p.name === settings.cutPreset)

  /*
    覚えた「間の好み」。
    🔴 必ず根拠と一緒に見せること。候補が減る仕組みなので、
       理由が見えないと不具合と区別がつかない。
  */
  const [memory, setMemory] = useState<CutMemorySummary | null>(null)
  useEffect(() => {
    void loadCutMemory().then(setMemory)
  }, [])

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

            {/* カットの詰め具合 */}
            <section className="settings-card">
              <h3>カットの詰め具合</h3>
              <select
                value={settings.cutPreset}
                onChange={(e) => onChange({ cutPreset: e.target.value as CutPreset })}
              >
                {CUT_PRESETS.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.label}
                  </option>
                ))}
              </select>
              {pace && <p className="settings-note">{pace.description}</p>}
              <p className="settings-note">
                ここで決まるのは「どこを候補に挙げるか」だけです。切るかどうかは
                「④ カット」で1件ずつ選べます。
                <br />
                <span className="settings-sub">※ 変えた分は次の「解析」から効きます</span>
              </p>
            </section>

            {/* 独り言 */}
            <section className="settings-card">
              <h3>独り言も候補にする</h3>
              <label className="inline">
                <input
                  type="checkbox"
                  checked={settings.detectAside}
                  onChange={(e) => onChange({ detectAside: e.target.checked })}
                />
                <span>話が繋がっていない所を探す</span>
              </label>
              <p className="settings-note">
                「あれ、止まってない？」「もう一回」のような、話の本筋と繋がっていない
                ひとりごとを候補に挙げます。無音でもフィラーでもないので、今までどれにも
                引っかかりませんでした。
                <br />
                見ているのは<strong>前後と同じ話題の語を使っているか</strong>・
                <strong>ぽつんと孤立しているか</strong>・
                <strong>撮り直しの言い回しか</strong>の3つで、話の意味そのものは読んでいません。
                外すこともあるので、切るかどうかは必ず「④ カット」で1件ずつ決めてください
                （勝手に切ることはありません）。
              </p>
            </section>

            {/* 覚えた間の好み */}
            <section className="settings-card">
              <h3>覚えた間の好み</h3>
              {memory && memory.minGain ? (
                <>
                  <div className="settings-value">
                    {memory.minGain}秒 より短い間は候補にしません
                  </div>
                  <p className="settings-note">
                    「④ カット」で下した判断 <strong>{memory.samples}件</strong>から決めました
                    （記録との一致 {Math.round((memory.agreement ?? 0) * 100)}%）。
                    書き出すたびに更新されます。
                  </p>
                </>
              ) : (
                <>
                  <div className="settings-value settings-sub">まだ覚えていません</div>
                  <p className="settings-note">
                    無音の判断が <strong>{memory?.silences ?? 0} / {memory?.minSamples ?? 30}件</strong>。
                    これだけ溜まると、あなたが残している短い間を候補から外します。
                    <br />
                    いつも切る・いつも残す、のように判断が片方に寄っている間は覚えません
                    （線を引く意味がないため）。
                  </p>
                </>
              )}

              {memory && memory.fillerSuggestions.length > 0 && (
                <p className="settings-note">
                  よく切っている言葉：
                  <strong>{memory.fillerSuggestions.join('・')}</strong>
                  <br />
                  <button
                    className="tiny"
                    onClick={() =>
                      onChange({
                        extraFillers: [settings.extraFillers, ...memory.fillerSuggestions]
                          .filter(Boolean)
                          .join('、'),
                      })
                    }
                  >
                    口ぐせに足す
                  </button>
                </p>
              )}

              <p className="settings-note">
                <span className="settings-sub">
                  ※ 判断の記録だけです。学習も送信もしていません（この Mac の中で完結）
                </span>
                <br />
                <button className="tiny" onClick={() => void forgetCutMemory().then(setMemory)}>
                  覚えたことを忘れる
                </button>
              </p>
            </section>

            {/* 口ぐせ */}
            <section className="settings-card">
              <h3>自分の口ぐせ</h3>
              <textarea
                rows={2}
                value={settings.extraFillers}
                placeholder="ですね、まあまあ、なんていうか"
                onChange={(e) => onChange({ extraFillers: e.target.value })}
              />
              <p className="settings-note">
                ここに書いた言葉も「フィラー」として候補に挙げます。
                読点・空白・改行のどれで区切ってもかまいません。
                <br />
                「えー」「あのー」「えっと」「なんか」などは<strong>最初から入っています</strong>ので、
                それ以外の自分の癖だけ書いてください。
                <br />
                <span className="settings-sub">※ 変えた分は次の「解析」から効きます</span>
              </p>
            </section>

            {/* 書き出す速度 */}
            <section className="settings-card">
              <h3>書き出す再生速度</h3>
              <div className="inline">
                <input
                  type="number"
                  min={25}
                  max={400}
                  step={5}
                  value={Math.round(settings.exportSpeed * 100)}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    if (!Number.isFinite(n)) return
                    onChange({ exportSpeed: n / 100 })
                  }}
                  onBlur={(e) => {
                    const n = Number(e.target.value)
                    const fixed = Number.isFinite(n) ? Math.min(400, Math.max(25, n)) : 100
                    onChange({ exportSpeed: fixed / 100 })
                  }}
                  style={{ width: 90 }}
                />
                <span className="settings-sub">％（100 で等倍）</span>
              </div>
              <p className="settings-note">
                <strong>あとで Final Cut 側で速度を変えると、テロップの位置がずれます。</strong>
                ここで指定しておけば、テロップも一緒に付いてきます。
                <br />
                120 なら 1.2倍速。素材そのものには手を加えず、書き出す
                プロジェクトの速度だけが変わります。
                <br />
                <span className="settings-sub">※ これは書き出しにだけ効きます（解析はやり直し不要）</span>
              </p>
            </section>

            {/* テロップ1枚の長さ */}
            <section className="settings-card">
              <h3>テロップ1枚の文字数</h3>
              <div className="inline">
                <input
                  type="number"
                  min={TELOP_MAX_CHARS_RANGE.min}
                  max={TELOP_MAX_CHARS_RANGE.max}
                  step={1}
                  value={settings.telopMaxChars}
                  onChange={(e) => {
                    /*
                      🔴 範囲で縛ること。0 や 500 を入れられると、
                         1文字ずつのテロップや、画面から溢れるテロップになる。
                      🔴 打ちかけの空欄で弾かないこと。
                         「1」を消して「20」に打ち直す途中で戻されると入力できない。
                    */
                    const n = Number(e.target.value)
                    if (!Number.isFinite(n)) return
                    onChange({ telopMaxChars: n })
                  }}
                  onBlur={(e) => {
                    const n = Number(e.target.value)
                    const fixed = Number.isFinite(n)
                      ? Math.min(TELOP_MAX_CHARS_RANGE.max, Math.max(TELOP_MAX_CHARS_RANGE.min, Math.round(n)))
                      : DEFAULT_TELOP_MAX_CHARS
                    if (fixed !== settings.telopMaxChars) onChange({ telopMaxChars: fixed })
                  }}
                  style={{ width: 90 }}
                />
                <span className="settings-sub">文字（全角換算）</span>
              </div>
              <p className="settings-note">
                これを超えるところで、文節の切れ目を選んで次の1枚に送ります。
                長くすると1枚が読み切れなくなり、短くすると枚数が増えて目が追えません。
                迷ったら {DEFAULT_TELOP_MAX_CHARS} のままで大丈夫です。
                <br />
                <span className="settings-sub">
                  ※ 変えた分は次の「解析」から効きます
                </span>
              </p>
            </section>

            {/* テロップの見本 */}
            <section className="settings-card">
              <h3>テロップの見た目</h3>
              {template ? (
                <div className="settings-value">
                  {template.effectName}
                  {template.hasStyle === false ? (
                    /*
                      🔴 見本に文字が入っていないと、書式が1つも写せない。
                         黙って既定の見た目になり、「テロップが小さい」の形でしか
                         現れないので、ここではっきり知らせる（2026-09-02）。
                    */
                    <span className="settings-sub warn">
                      文字の書式は写せていません（見本に文字が入っていないため）
                    </span>
                  ) : (
                    <span className="settings-sub">
                      {template.font} {template.fontFace} / {template.fontSize}px
                    </span>
                  )}
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
              {template?.hasStyle === false && (
                <p className="settings-note warn">
                  見本のテロップに<strong>文字を入れた状態</strong>で書き出し直してください。
                  文字が空のまま書き出すと、Final Cut は書体や大きさを XML に書きません。
                  写せるものが無いので、書体と大きさは下の既定値（素材の高さに合わせた大きさ）になります。
                </p>
              )}
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
