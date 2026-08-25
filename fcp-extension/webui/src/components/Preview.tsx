// プレビュー。動画の上にテロップを重ねて表示する。
//
// テロップは掴んで動かせる（位置の手動調整）。
// 一部の文字だけ見た目を変えている場合は、その範囲だけ別の見た目で描く。
//
// ⚠ ここに出るテロップは近似。実際の見た目は FCP のテロップテンプレが描画するので、
//   縁取りや行間には差が出る。

import { useEffect, useRef, useState } from 'react'
import type { Telop, TelopSpan, TelopStyle } from '../lib/types'
import { fmtTimecode } from '../lib/format'

interface Props {
  videoUrl: string | null
  durationSec: number
  time: number
  playing: boolean
  onSeek: (t: number) => void
  onToggle: () => void
  /** いま画面に出ているテロップ（無ければ null） */
  telop: Telop | null
  style: TelopStyle | null
  videoRef: (el: HTMLVideoElement | null) => void
  /** テロップを掴んで動かしたとき。位置は % で返す */
  onMoveTelop?: (id: string, leftPercent: number, bottomPercent: number) => void
}

/** 本文を、見た目が変わる範囲ごとに切り分ける */
function splitBySpans(text: string, spans: TelopSpan[] | undefined) {
  if (!spans || !spans.length) return [{ text, span: undefined as TelopSpan | undefined }]
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  const out: { text: string; span?: TelopSpan }[] = []
  let cursor = 0
  for (const s of sorted) {
    const start = Math.max(cursor, Math.min(s.start, text.length))
    const end = Math.max(start, Math.min(s.end, text.length))
    if (start > cursor) out.push({ text: text.slice(cursor, start) })
    if (end > start) out.push({ text: text.slice(start, end), span: s })
    cursor = end
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor) })
  return out.filter((p) => p.text.length)
}

export function Preview({
  videoUrl,
  durationSec,
  time,
  playing,
  onSeek,
  onToggle,
  telop,
  style,
  videoRef,
  onMoveTelop,
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageWidth, setStageWidth] = useState(640)
  const drag = useRef<{ id: string; startX: number; startY: number; left: number; bottom: number } | null>(null)

  // テロップのサイズは 1920x1080 基準で持っているので、表示幅に合わせて縮める
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setStageWidth(el.clientWidth))
    ro.observe(el)
    setStageWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const scale = stageWidth / 1920
  const movable = !!(onMoveTelop && telop)

  useEffect(() => {
    if (!movable) return
    const move = (e: PointerEvent) => {
      const d = drag.current
      const stage = stageRef.current
      if (!d || !stage) return
      const box = stage.getBoundingClientRect()
      const left = Math.max(2, Math.min(98, d.left + ((e.clientX - d.startX) / box.width) * 100))
      const bottom = Math.max(0, Math.min(90, d.bottom - ((e.clientY - d.startY) / box.height) * 100))
      onMoveTelop?.(d.id, Math.round(left * 10) / 10, Math.round(bottom * 10) / 10)
    }
    const up = () => {
      drag.current = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [movable, onMoveTelop])

  const parts = telop ? splitBySpans(telop.text, telop.spans) : []

  return (
    <div className="preview-wrap">
      <div className="stage" ref={stageRef}>
        {videoUrl ? (
          <video ref={videoRef} src={videoUrl} playsInline />
        ) : (
          <div className="stage-placeholder">
            動画が読み込まれていません
            <br />
            （開発モード：テロップの見た目とタイミングだけ確認できます）
          </div>
        )}

        <div className="telop-layer">
          {telop && style && (
            <div
              className={`telop-text ${movable ? 'movable' : ''}`}
              style={{
                bottom: `${style.bottomPercent}%`,
                left: `${style.leftPercent ?? 50}%`,
                fontFamily: `"${style.fontFamily}", sans-serif`,
                fontSize: `${Math.max(8, style.fontSize * scale)}px`,
                fontWeight: style.bold ? 700 : 400,
                color: style.color,
                WebkitTextStrokeWidth: `${Math.max(0, style.strokeWidth * scale)}px`,
                WebkitTextStrokeColor: style.strokeColor,
                paintOrder: 'stroke fill',
                textShadow: style.shadow ? `0 ${2 * scale}px ${6 * scale}px rgba(0,0,0,0.8)` : 'none',
              }}
              onPointerDown={(e) => {
                if (!movable) return
                e.preventDefault()
                drag.current = {
                  id: telop.id,
                  startX: e.clientX,
                  startY: e.clientY,
                  left: style.leftPercent ?? 50,
                  bottom: style.bottomPercent,
                }
              }}
              title={movable ? '掴んで動かせます' : undefined}
            >
              {parts.map((p, i) => (
                <span
                  key={i}
                  style={
                    p.span
                      ? {
                          fontSize: p.span.fontSize
                            ? `${Math.max(8, p.span.fontSize * scale)}px`
                            : undefined,
                          color: p.span.color,
                          fontWeight: p.span.bold ? 700 : undefined,
                        }
                      : undefined
                  }
                >
                  {p.text}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="transport">
        <button onClick={onToggle} title="スペースキーでも再生/停止">
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="tc">{fmtTimecode(time)}</span>
        <input
          className="scrub"
          type="range"
          min={0}
          max={durationSec}
          step={0.01}
          value={time}
          onChange={(e) => onSeek(Number(e.target.value))}
        />
        <span className="tc">{fmtTimecode(durationSec)}</span>
      </div>
    </div>
  )
}
