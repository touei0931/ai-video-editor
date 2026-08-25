// カット画面。左に映像とタイムライン、右にカット候補の一覧。
// 友達のペインは「1本30〜60分のカット作業」なので、
// 見て押すだけで進むこと（レビュー速度）を最優先にしている。

import { useEffect, useRef, useState } from 'react'
import { Preview } from '../components/Preview'
import { Timeline } from '../components/Timeline'
import { usePlayback } from '../lib/store'
import { CUT_LABEL } from '../lib/types'
import type { Store } from '../lib/store'
import { fmtTime } from '../lib/format'

export function CutScreen({ store }: { store: Store }) {
  const { state, decideCut, decideAllCuts } = store
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const duration = state?.durationSec ?? 0
  const { time, playing, seek, toggle } = usePlayback(duration, videoEl)

  // キーボードで流れ作業ができるようにする
  useEffect(() => {
    if (!state) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return

      const idx = state.cuts.findIndex((c) => c.id === selectedId)
      if (e.code === 'Space') {
        e.preventDefault()
        toggle()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        const next = state.cuts[Math.min(state.cuts.length - 1, idx + 1)]
        if (next) {
          setSelectedId(next.id)
          seek(next.start)
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const prev = state.cuts[Math.max(0, idx - 1)]
        if (prev) {
          setSelectedId(prev.id)
          seek(prev.start)
        }
      } else if (e.key === 'Enter' && selectedId) {
        e.preventDefault()
        decideCut(selectedId, 'approved')
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && selectedId) {
        e.preventDefault()
        decideCut(selectedId, 'rejected')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, selectedId, toggle, seek, decideCut])

  if (!state) return <div className="empty">読み込み中…</div>

  const approved = state.cuts.filter((c) => c.decision === 'approved').length
  const rejected = state.cuts.filter((c) => c.decision === 'rejected').length
  const pending = state.cuts.length - approved - rejected
  const removedSec = state.cuts
    .filter((c) => c.decision === 'approved')
    .reduce((a, c) => a + (c.end - c.start), 0)

  return (
    <div className="body">
      <div className="panel" style={{ flex: 1 }}>
        <div className="panel-title">プレビュー</div>
        <Preview
          videoUrl={state.videoUrl}
          durationSec={duration}
          time={time}
          playing={playing}
          onSeek={seek}
          onToggle={toggle}
          telop={null}
          style={null}
          videoRef={setVideoEl}
        />
        <div style={{ padding: '0 8px 8px' }}>
          <Timeline
            durationSec={duration}
            waveform={state.waveform}
            cuts={state.cuts}
            telops={state.telops}
            time={time}
            onSeek={seek}
            selectedCutId={selectedId}
            onSelectCut={setSelectedId}
            showTelopTrack={false}
          />
        </div>
        <div className="hint">
          スペース = 再生/停止 ・ ↑↓ = 候補を移動 ・ Enter = 承認 ・ Delete = 却下
        </div>
      </div>

      <div className="panel" style={{ width: 360, flex: '0 0 360px' }}>
        <div className="panel-title">
          <span>カット候補 {state.cuts.length} 件</span>
          <span className="spacer" />
          <button className="tiny ok" onClick={() => decideAllCuts('approved')}>
            全部承認
          </button>
          <button className="tiny ng" onClick={() => decideAllCuts('rejected')}>
            全部却下
          </button>
        </div>

        <div className="list" ref={listRef}>
          {state.cuts.map((c) => (
            <div
              key={c.id}
              className={[
                'row',
                selectedId === c.id ? 'selected' : '',
                c.decision === 'rejected' ? 'rejected' : '',
              ].join(' ')}
              onClick={() => {
                setSelectedId(c.id)
                seek(c.start)
              }}
            >
              <span className={`badge ${c.kind}`}>{CUT_LABEL[c.kind]}</span>
              <span className="row-time">{fmtTime(c.start)}</span>
              <span className="row-text">
                {c.text || <span style={{ color: 'var(--text-faint)' }}>（無音 {(c.end - c.start).toFixed(1)}秒）</span>}
              </span>
              <span className="row-actions">
                <button
                  className={`tiny ${c.decision === 'approved' ? 'primary' : 'ok'}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    decideCut(c.id, c.decision === 'approved' ? 'pending' : 'approved')
                  }}
                  title="このカットを実行する"
                >
                  切る
                </button>
                <button
                  className="tiny ng"
                  onClick={(e) => {
                    e.stopPropagation()
                    decideCut(c.id, c.decision === 'rejected' ? 'pending' : 'rejected')
                  }}
                  title="残す"
                >
                  残す
                </button>
              </span>
            </div>
          ))}
        </div>

        <div className="hint">
          切る {approved} ・ 残す {rejected} ・ 未判断 {pending}
          <br />
          短くなる長さ： 約 {removedSec.toFixed(1)} 秒
        </div>
      </div>
    </div>
  )
}
