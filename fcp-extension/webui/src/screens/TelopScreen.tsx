// テロップ画面。左にプレビュー、右に生成テロップの一覧。
// 一覧で選ぶとプレビューがその時刻に飛び、テロップが乗った状態で見える。
// FCP と同じ感覚で Cmd+C / Cmd+V / Cmd+D / Delete が効く。

import { useEffect, useMemo, useRef, useState } from 'react'
import { Preview } from '../components/Preview'
import { Timeline } from '../components/Timeline'
import { StylePanel } from '../components/StylePanel'
import { usePlayback } from '../lib/store'
import type { Store } from '../lib/store'
import { STYLE_LABEL } from '../lib/types'
import type { StyleName, Telop, TelopStyle } from '../lib/types'
import { fmtTime } from '../lib/format'

let telopSeq = 1000

export function TelopScreen({ store }: { store: Store }) {
  const { state, updateTelop, addTelop, removeTelop, updateStyle } = store
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingStyle, setEditingStyle] = useState<StyleName>('normal')
  const clipboard = useRef<Telop | null>(null)

  const duration = state?.durationSec ?? 0
  const { time, playing, seek, toggle } = usePlayback(duration, videoEl)

  const selected = state?.telops.find((t) => t.id === selectedId) ?? null

  /** いまプレビューに出すべきテロップ。
   *  選択中のものがあればそれを優先する（一覧で選んで見た目を確認するため）。 */
  const shown = useMemo(() => {
    if (!state) return null
    if (selected) return selected
    return state.telops.find((t) => time >= t.start && time <= t.end) ?? null
  }, [state, selected, time])

  const shownStyle: TelopStyle | null = useMemo(() => {
    if (!state || !shown) return null
    return { ...state.styles[shown.style], ...(shown.overrides ?? {}) }
  }, [state, shown])

  useEffect(() => {
    if (!state) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return
      const mod = e.metaKey || e.ctrlKey
      const idx = state.telops.findIndex((t) => t.id === selectedId)

      if (e.code === 'Space' && !mod) {
        e.preventDefault()
        toggle()
      } else if (mod && e.key.toLowerCase() === 'c' && selected) {
        e.preventDefault()
        clipboard.current = selected
      } else if (mod && e.key.toLowerCase() === 'v' && clipboard.current) {
        e.preventDefault()
        pasteAt(clipboard.current, time)
      } else if (mod && e.key.toLowerCase() === 'd' && selected) {
        e.preventDefault()
        pasteAt(selected, selected.end + 0.2)
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && selected) {
        e.preventDefault()
        removeTelop(selected.id)
        setSelectedId(null)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        const next = state.telops[Math.min(state.telops.length - 1, idx + 1)]
        if (next) {
          setSelectedId(next.id)
          seek(next.start)
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const prev = state.telops[Math.max(0, idx - 1)]
        if (prev) {
          setSelectedId(prev.id)
          seek(prev.start)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, selectedId, selected, time, toggle, seek, removeTelop])

  /** コピー元の見た目と長さを保ったまま、指定時刻に置く */
  function pasteAt(src: Telop, at: number) {
    const len = src.end - src.start
    const start = Math.max(0, Math.min(duration - len, at))
    const copy: Telop = {
      ...src,
      id: `t${++telopSeq}`,
      start,
      end: start + len,
    }
    addTelop(copy)
    setSelectedId(copy.id)
  }

  if (!state) return <div className="empty">読み込み中…</div>

  return (
    <div className="body">
      {/* 左：プレビュー */}
      <div className="panel" style={{ flex: 1 }}>
        <div className="panel-title">
          プレビュー
          <span className="spacer" />
          <span className="warn">※ 実際の見た目は FCP のテンプレが描画するため細部が異なります</span>
        </div>
        <Preview
          videoUrl={state.videoUrl}
          durationSec={duration}
          time={time}
          playing={playing}
          onSeek={seek}
          onToggle={toggle}
          telop={shown}
          style={shownStyle}
          videoRef={setVideoEl}
        />
        <div style={{ padding: '0 8px 8px' }}>
          <Timeline
            durationSec={duration}
            waveform={state.waveform}
            cuts={[]}
            telops={state.telops}
            time={time}
            onSeek={seek}
            selectedTelopId={selectedId}
            onSelectTelop={setSelectedId}
          />
        </div>
        <div className="hint">
          スペース = 再生/停止 ・ ↑↓ = 移動 ・ Cmd+C / Cmd+V = コピー・貼り付け ・ Cmd+D = 複製 ・ Delete = 削除
        </div>
      </div>

      {/* 右：一覧と設定 */}
      <div className="panel" style={{ width: 380, flex: '0 0 380px' }}>
        <div className="panel-title">
          <span>テロップ {state.telops.length} 件</span>
          <span className="spacer" />
          <button
            className="tiny"
            disabled={!selected}
            onClick={() => selected && (clipboard.current = selected)}
          >
            コピー
          </button>
          <button
            className="tiny"
            disabled={!clipboard.current}
            onClick={() => clipboard.current && pasteAt(clipboard.current, time)}
          >
            貼り付け
          </button>
          <button className="tiny" disabled={!selected} onClick={() => selected && pasteAt(selected, selected.end + 0.2)}>
            複製
          </button>
        </div>

        <div className="list">
          {state.telops.map((t) => (
            <div
              key={t.id}
              className={['row', selectedId === t.id ? 'selected' : ''].join(' ')}
              onClick={() => {
                setSelectedId(t.id)
                seek(t.start)
              }}
            >
              <span className={`badge ${t.style}`}>{STYLE_LABEL[t.style]}</span>
              <span className="row-time">{fmtTime(t.start)}</span>
              <span className="row-text">{t.text}</span>
            </div>
          ))}
        </div>

        {/* 選択中のテロップの編集 */}
        {selected && (
          <div style={{ borderTop: '1px solid var(--line)' }}>
            <div className="panel-title">選択中のテロップ</div>
            <div className="form">
              <label>本文</label>
              <input
                type="text"
                value={selected.text}
                onChange={(e) => updateTelop(selected.id, { text: e.target.value })}
              />

              <label>スタイル</label>
              <select
                value={selected.style}
                onChange={(e) => updateTelop(selected.id, { style: e.target.value as StyleName })}
              >
                <option value="normal">{STYLE_LABEL.normal}</option>
                <option value="emphasis">{STYLE_LABEL.emphasis}</option>
              </select>

              <label>時間</label>
              <div className="inline">
                <input
                  type="number"
                  step={0.1}
                  value={Number(selected.start.toFixed(1))}
                  onChange={(e) => updateTelop(selected.id, { start: Number(e.target.value) })}
                />
                <span style={{ color: 'var(--text-faint)' }}>〜</span>
                <input
                  type="number"
                  step={0.1}
                  value={Number(selected.end.toFixed(1))}
                  onChange={(e) => updateTelop(selected.id, { end: Number(e.target.value) })}
                />
              </div>
            </div>
          </div>
        )}

        {/* 既定スタイル */}
        <div style={{ borderTop: '1px solid var(--line)' }}>
          <div className="tabs" style={{ margin: '8px 10px 0' }}>
            <button
              className={`tab ${editingStyle === 'normal' ? 'active' : ''}`}
              onClick={() => setEditingStyle('normal')}
            >
              通常
            </button>
            <button
              className={`tab ${editingStyle === 'emphasis' ? 'active' : ''}`}
              onClick={() => setEditingStyle('emphasis')}
            >
              強調
            </button>
          </div>
          <StylePanel
            name={editingStyle}
            style={state.styles[editingStyle]}
            fonts={state.fonts}
            onChange={(patch) => updateStyle(editingStyle, patch)}
          />
        </div>
      </div>
    </div>
  )
}
