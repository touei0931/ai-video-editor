// 「通常」「強調」の既定スタイル設定。
// ここで決めた値が FCP のテロップテンプレに渡る。

import type { StyleName, TelopStyle } from '../lib/types'
import { STYLE_LABEL } from '../lib/types'

interface Props {
  name: StyleName
  style: TelopStyle
  fonts: string[]
  onChange: (patch: Partial<TelopStyle>) => void
}

export function StylePanel({ name, style, fonts, onChange }: Props) {
  return (
    <div>
      <div className="panel-title">{STYLE_LABEL[name]}スタイルの既定値</div>
      <div className="form">
        <label>フォント</label>
        <select value={style.fontFamily} onChange={(e) => onChange({ fontFamily: e.target.value })}>
          {fonts.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>

        <label>大きさ</label>
        <div className="inline">
          <input
            type="number"
            min={12}
            max={200}
            value={style.fontSize}
            onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
          />
          <span style={{ color: 'var(--text-faint)' }}>px</span>
          <label style={{ marginLeft: 6 }}>
            <input
              type="checkbox"
              checked={style.bold}
              onChange={(e) => onChange({ bold: e.target.checked })}
            />
            太字
          </label>
        </div>

        <label>文字色</label>
        <div className="inline">
          <input type="color" value={style.color} onChange={(e) => onChange({ color: e.target.value })} />
          <span style={{ color: 'var(--text-faint)' }}>{style.color}</span>
        </div>

        <label>縁取り</label>
        <div className="inline">
          <input
            type="color"
            value={style.strokeColor}
            onChange={(e) => onChange({ strokeColor: e.target.value })}
          />
          <input
            type="number"
            min={0}
            max={30}
            value={style.strokeWidth}
            onChange={(e) => onChange({ strokeWidth: Number(e.target.value) })}
          />
          <span style={{ color: 'var(--text-faint)' }}>px</span>
        </div>

        <label>影</label>
        <div className="inline">
          <input
            type="checkbox"
            checked={style.shadow}
            onChange={(e) => onChange({ shadow: e.target.checked })}
          />
          <span style={{ color: 'var(--text-faint)' }}>つける</span>
        </div>

        <label>自動改行</label>
        <div className="inline">
          <input
            type="checkbox"
            checked={style.autoWrap ?? true}
            onChange={(e) => onChange({ autoWrap: e.target.checked })}
          />
          <span style={{ color: 'var(--text-faint)' }}>画面端で折り返す</span>
        </div>

        <label>下からの位置</label>
        <div className="inline">
          <input
            type="range"
            min={0}
            max={80}
            value={style.bottomPercent}
            onChange={(e) => onChange({ bottomPercent: Number(e.target.value) })}
          />
          <span style={{ color: 'var(--text-faint)', minWidth: 30 }}>{style.bottomPercent}%</span>
        </div>
      </div>
    </div>
  )
}
