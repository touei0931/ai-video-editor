// タイムライン。FCP のように、上に目盛り、下に波形とクリップを並べる。
// 波形は canvas。カット候補は種類ごとの色、テロップは FCP のタイトルと同じ紫。

import { useEffect, useRef } from 'react'
import type { CutCandidate, Telop } from '../lib/types'

interface Props {
  durationSec: number
  waveform: number[]
  cuts: CutCandidate[]
  telops: Telop[]
  time: number
  onSeek: (t: number) => void
  selectedCutId?: string | null
  onSelectCut?: (id: string) => void
  selectedTelopId?: string | null
  onSelectTelop?: (id: string) => void
  showTelopTrack?: boolean
}

const CUT_COLOR: Record<CutCandidate['kind'], string> = {
  silence: 'var(--cut-silence)',
  filler: 'var(--cut-filler)',
  restate: 'var(--cut-restate)',
}

export function Timeline({
  durationSec,
  waveform,
  cuts,
  telops,
  time,
  onSeek,
  selectedCutId,
  onSelectCut,
  selectedTelopId,
  onSelectTelop,
  showTelopTrack = true,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // 波形を描く
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const draw = () => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      const dpr = window.devicePixelRatio || 1
      canvas.width = w * dpr
      canvas.height = h * dpr
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, w, h)

      ctx.fillStyle = '#1f2b21'
      ctx.fillRect(0, 0, w, h)

      ctx.fillStyle = '#4c9a5e'
      const mid = h / 2
      for (let x = 0; x < w; x++) {
        const i = Math.floor((x / w) * waveform.length)
        const v = waveform[i] ?? 0
        const half = Math.max(0.5, (v * h) / 2)
        ctx.fillRect(x, mid - half, 1, half * 2)
      }
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [waveform])

  const pct = (sec: number) => `${(sec / durationSec) * 100}%`

  const seekFromEvent = (e: React.MouseEvent) => {
    const el = wrapRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const ratio = (e.clientX - rect.left) / rect.width
    onSeek(Math.max(0, Math.min(durationSec, ratio * durationSec)))
  }

  // 目盛り（10秒ごと）
  const ticks: number[] = []
  const step = durationSec > 120 ? 30 : durationSec > 40 ? 10 : 5
  for (let t = 0; t <= durationSec; t += step) ticks.push(t)

  return (
    <div className="timeline" ref={wrapRef}>
      <div className="ruler" onMouseDown={seekFromEvent}>
        {ticks.map((t) => (
          <div key={t} className="ruler-tick" style={{ left: pct(t) }}>
            {Math.floor(t / 60)}:{String(Math.floor(t % 60)).padStart(2, '0')}
          </div>
        ))}
      </div>

      <div className="track" onMouseDown={seekFromEvent}>
        <canvas className="wave" ref={canvasRef} />
        {cuts.map((c) => (
          <div
            key={c.id}
            className={[
              'cut-block',
              c.decision === 'rejected' ? 'rejected' : '',
              selectedCutId === c.id ? 'selected' : '',
            ].join(' ')}
            style={{
              left: pct(c.start),
              width: pct(c.end - c.start),
              background: CUT_COLOR[c.kind],
            }}
            title={`${c.kind} ${c.start.toFixed(1)}s - ${c.end.toFixed(1)}s`}
            onMouseDown={(e) => {
              e.stopPropagation()
              onSelectCut?.(c.id)
              onSeek(c.start)
            }}
          />
        ))}
      </div>

      {showTelopTrack && (
        <div className="track-title" onMouseDown={seekFromEvent}>
          {telops.map((t) => (
            <div
              key={t.id}
              className={['telop-block', selectedTelopId === t.id ? 'selected' : ''].join(' ')}
              style={{ left: pct(t.start), width: pct(Math.max(0.4, t.end - t.start)) }}
              title={t.text}
              onMouseDown={(e) => {
                e.stopPropagation()
                onSelectTelop?.(t.id)
                onSeek(t.start)
              }}
            >
              {t.text}
            </div>
          ))}
        </div>
      )}

      <div className="playhead" style={{ left: pct(time) }} />
    </div>
  )
}
