// プレビュー。動画の上にテロップを重ねて表示する。
//
// ⚠ ここに出るテロップは近似。実際の見た目は FCP のテロップテンプレ
//   「基本01_10」が描画するので、縁取りや行間には差が出る。

import { useEffect, useRef, useState } from 'react'
import type { Telop, TelopStyle } from '../lib/types'
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
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageWidth, setStageWidth] = useState(640)

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
              className="telop-text"
              style={{
                bottom: `${style.bottomPercent}%`,
                fontFamily: `"${style.fontFamily}", sans-serif`,
                fontSize: `${Math.max(8, style.fontSize * scale)}px`,
                fontWeight: style.bold ? 700 : 400,
                color: style.color,
                WebkitTextStrokeWidth: `${Math.max(0, style.strokeWidth * scale)}px`,
                WebkitTextStrokeColor: style.strokeColor,
                paintOrder: 'stroke fill',
                textShadow: style.shadow ? `0 ${2 * scale}px ${6 * scale}px rgba(0,0,0,0.8)` : 'none',
              }}
            >
              {telop.text}
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
