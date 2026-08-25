// タイムライン。編集ソフトで言うところの「下の帯」。
//
// この部品がある理由は「端をドラッグして伸縮できること」。
// ボタンでしか調整できないと、素材のどこを触っているのか画面から分からない。
//
// 守る約束（PAC 本体のタイムラインと同じ）:
//   - 秒と画素の換算は pxPerSec ただ一つを通す。ここを分けると必ずずれる
//   - ドラッグ中は確定させない。確定は指を離した一度だけ
//   - フレームに吸着させる。素材の fps 未満の精度で切っても意味がない
//   - 掴んでいる間、動かした量をその場に数値で出す（戻せなくなるため）

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Filmstrip } from './Filmstrip'

export type ClipKind = 'silence' | 'filler' | 'restate' | 'telop'

export interface Clip {
  id: string
  start: number
  end: number
  kind: ClipKind
  label?: string
  /** 却下したカットなど、薄く見せるもの */
  dim?: boolean
}

interface Props {
  duration: number
  fps: number
  time: number
  onSeek: (t: number) => void
  waveform: number[]
  videoUrl: string | null
  clips: Clip[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** 端をドラッグし終えたときに一度だけ呼ばれる */
  onTrim?: (id: string, start: number, end: number) => void
  /** クリップごと動かせるか（テロップは可、カットは不可） */
  movable?: boolean
  laneLabel: string
}

const CLIP_COLOR: Record<ClipKind, string> = {
  silence: 'var(--cut-silence)',
  filler: 'var(--cut-filler)',
  restate: 'var(--cut-restate)',
  telop: 'var(--clip-title)',
}

/** 掴める最低幅（px）。これを下回ると左右のつまみが重なってどちらも掴めない */
const GRABBABLE = 44
const MIN_LEN = 0.04

const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]
function chooseStep(pxPerSec: number): number {
  const wanted = 70 / pxPerSec
  return STEPS.find((s) => s >= wanted) ?? STEPS[STEPS.length - 1]
}

function tick(sec: number): string {
  const m = Math.floor(sec / 60)
  return `${m}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
}

interface Dragging {
  id: string
  edge: 'start' | 'end' | 'move'
  originStart: number
  originEnd: number
  originX: number
  start: number
  end: number
}

export function Timeline({
  duration,
  fps,
  time,
  onSeek,
  waveform,
  videoUrl,
  clips,
  selectedId,
  onSelect,
  onTrim,
  movable = false,
  laneLabel,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const waveRef = useRef<HTMLCanvasElement>(null)
  const [pxPerSec, setPxPerSec] = useState(0)
  const [view, setView] = useState({ from: 0, to: 0, width: 0 })
  const [drag, setDrag] = useState<Dragging | null>(null)

  const frame = 1 / Math.max(1, fps)

  // 初期倍率は「尺全体が収まる」
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !duration) return
    if (pxPerSec === 0) {
      const fit = el.clientWidth / duration
      setPxPerSec(fit)
      setView({ from: 0, to: duration, width: el.clientWidth })
    }
  }, [duration, pxPerSec])

  const updateView = useCallback(() => {
    const el = scrollRef.current
    if (!el || !pxPerSec) return
    const from = el.scrollLeft / pxPerSec
    const to = (el.scrollLeft + el.clientWidth) / pxPerSec
    setView({ from, to: Math.min(duration, to), width: el.clientWidth })
  }, [pxPerSec, duration])

  useEffect(() => {
    updateView()
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(updateView)
    ro.observe(el)
    return () => ro.disconnect()
  }, [updateView])

  const totalWidth = Math.max(1, duration * pxPerSec)

  // 波形。見えている範囲だけ描く
  useEffect(() => {
    const canvas = waveRef.current
    if (!canvas || !pxPerSec) return
    const w = Math.max(1, (view.to - view.from) * pxPerSec)
    const h = 46
    const dpr = window.devicePixelRatio || 1
    canvas.width = w * dpr
    canvas.height = h * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.fillStyle = '#1a241c'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#4c9a5e'
    const mid = h / 2
    for (let x = 0; x < w; x++) {
      const t = view.from + x / pxPerSec
      const i = Math.floor((t / Math.max(0.001, duration)) * waveform.length)
      const v = waveform[i] ?? 0
      const half = Math.max(0.5, (v * h) / 2)
      ctx.fillRect(x, mid - half, 1, half * 2)
    }
  }, [view, pxPerSec, waveform, duration])

  const snap = (t: number) => Math.round(t / frame) * frame
  const clamp = (t: number) => Math.max(0, Math.min(duration, t))

  const seekFromEvent = (e: React.MouseEvent) => {
    const el = scrollRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const t = (e.clientX - rect.left + el.scrollLeft) / pxPerSec
    onSeek(clamp(t))
  }

  // ── ドラッグ（端の伸縮 / 移動）──────────────────────
  const startDrag = (e: React.PointerEvent, clip: Clip, edge: Dragging['edge']) => {
    e.stopPropagation()
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    onSelect(clip.id)
    setDrag({
      id: clip.id,
      edge,
      originStart: clip.start,
      originEnd: clip.end,
      originX: e.clientX,
      start: clip.start,
      end: clip.end,
    })
  }

  useEffect(() => {
    if (!drag) return

    const move = (e: PointerEvent) => {
      const dt = (e.clientX - drag.originX) / pxPerSec
      setDrag((d) => {
        if (!d) return d
        if (d.edge === 'move') {
          const len = d.originEnd - d.originStart
          const start = clamp(snap(d.originStart + dt))
          return { ...d, start, end: Math.min(duration, start + len) }
        }
        if (d.edge === 'start') {
          const start = clamp(snap(Math.min(d.originStart + dt, d.originEnd - MIN_LEN)))
          return { ...d, start }
        }
        const end = clamp(snap(Math.max(d.originEnd + dt, d.originStart + MIN_LEN)))
        return { ...d, end }
      })
    }

    const up = () => {
      setDrag((d) => {
        if (d) onTrim?.(d.id, d.start, d.end)
        return null
      })
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.id, drag?.edge, pxPerSec, duration])

  const shown = useMemo(
    () =>
      clips.map((c) =>
        drag && drag.id === c.id ? { ...c, start: drag.start, end: drag.end } : c,
      ),
    [clips, drag],
  )

  const step = pxPerSec ? chooseStep(pxPerSec) : 5
  const ticks: number[] = []
  for (let t = Math.floor(view.from / step) * step; t <= view.to; t += step) {
    if (t >= 0) ticks.push(t)
  }

  const zoom = (factor: number) => {
    const el = scrollRef.current
    if (!el) return
    const center = (el.scrollLeft + el.clientWidth / 2) / pxPerSec
    const next = Math.max(el.clientWidth / duration, Math.min(400, pxPerSec * factor))
    setPxPerSec(next)
    requestAnimationFrame(() => {
      el.scrollLeft = center * next - el.clientWidth / 2
      updateView()
    })
  }

  const fit = () => {
    const el = scrollRef.current
    if (!el) return
    setPxPerSec(el.clientWidth / duration)
    requestAnimationFrame(() => {
      el.scrollLeft = 0
      updateView()
    })
  }

  /** 選択中のクリップが見えていなければ、そこへ寄せる */
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !selectedId || !pxPerSec || drag) return
    const clip = clips.find((c) => c.id === selectedId)
    if (!clip) return
    const left = clip.start * pxPerSec
    const right = clip.end * pxPerSec
    if (left < el.scrollLeft || right > el.scrollLeft + el.clientWidth) {
      el.scrollLeft = Math.max(0, left - el.clientWidth / 3)
      updateView()
    }
    // 掴めない細さなら、掴める倍率まで自動で寄る
    if ((clip.end - clip.start) * pxPerSec < GRABBABLE) {
      const need = GRABBABLE / Math.max(MIN_LEN, clip.end - clip.start)
      setPxPerSec(Math.min(400, need))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  const dragged = drag ? drag.end - drag.start - (drag.originEnd - drag.originStart) : 0
  const movedBy = drag && drag.edge === 'move' ? drag.start - drag.originStart : dragged

  return (
    <div className="timeline2">
      <div className="tl-controls">
        <span className="tl-label">{laneLabel}</span>
        <span className="spacer" />
        {drag && (
          <span className="tl-readout">
            {movedBy >= 0 ? '+' : ''}
            {movedBy.toFixed(2)} 秒（{Math.round(Math.abs(movedBy) * fps)} コマ）
          </span>
        )}
        <button className="tiny" onClick={() => zoom(1 / 1.6)} title="縮小">
          −
        </button>
        <button className="tiny" onClick={fit} title="全体を表示">
          全体
        </button>
        <button className="tiny" onClick={() => zoom(1.6)} title="拡大">
          ＋
        </button>
      </div>

      <div className="tl-scroll" ref={scrollRef} onScroll={updateView}>
        <div className="tl-inner" style={{ width: totalWidth }}>
          {/* 目盛り */}
          <div className="tl-ruler" onMouseDown={seekFromEvent}>
            {ticks.map((t) => (
              <div key={t} className="ruler-tick" style={{ left: t * pxPerSec }}>
                {tick(t)}
              </div>
            ))}
          </div>

          {/* 映像のコマ */}
          <div className="tl-lane" style={{ height: 40 }} onMouseDown={seekFromEvent}>
            <div className="lane-shift" style={{ transform: `translateX(${view.from * pxPerSec}px)` }}>
              <Filmstrip
                videoUrl={videoUrl}
                scale={pxPerSec}
                from={view.from}
                to={view.to}
                height={40}
                duration={duration}
              />
            </div>
          </div>

          {/* 音の波 */}
          <div className="tl-lane" style={{ height: 46 }} onMouseDown={seekFromEvent}>
            <div className="lane-shift" style={{ transform: `translateX(${view.from * pxPerSec}px)` }}>
              <canvas ref={waveRef} className="lane-canvas" style={{ height: 46 }} />
            </div>
          </div>

          {/* クリップ */}
          <div className="tl-lane tl-clips" style={{ height: 30 }} onMouseDown={seekFromEvent}>
            {shown.map((c) => {
              const left = c.start * pxPerSec
              const width = Math.max(2, (c.end - c.start) * pxPerSec)
              const selected = selectedId === c.id
              return (
                <div
                  key={c.id}
                  className={`tl-clip ${c.dim ? 'dim' : ''} ${selected ? 'selected' : ''}`}
                  style={{ left, width, background: CLIP_COLOR[c.kind] }}
                  title={c.label}
                  onMouseDown={(e) => e.stopPropagation()}
                  onPointerDown={(e) => {
                    if (movable) startDrag(e, c, 'move')
                    else {
                      onSelect(c.id)
                      onSeek(c.start)
                    }
                  }}
                >
                  <span
                    className="tl-handle left"
                    onPointerDown={(e) => startDrag(e, c, 'start')}
                  />
                  <span className="tl-clip-label">{c.label}</span>
                  <span className="tl-handle right" onPointerDown={(e) => startDrag(e, c, 'end')} />
                </div>
              )
            })}
          </div>

          <div className="playhead" style={{ left: time * pxPerSec }} />
        </div>
      </div>
    </div>
  )
}
