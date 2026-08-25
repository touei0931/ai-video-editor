// 映像のコマを並べるレーン。「どのあたりに何が映っているか」を目で探すためのもの。
//
// 🔴 見えている範囲だけ作ること。
//    素材全体のコマを一度に取り出すと、長い素材では数百枚になって画面が固まる。
// 🔴 取り出しは1枚ずつ順番に。
//    <video> は同時に複数の位置へは飛べない。並行にやると seek が潰し合って
//    同じコマばかりになる。
//
// 作り方は「隠した video を目的の時刻へ飛ばして canvas に写す」。
// ffmpeg を呼ばずに済むので、パネル側に余計な仕組みが要らない。

import { useEffect, useRef } from 'react'

interface Props {
  videoUrl: string | null
  /** 1秒あたりの画素数 */
  scale: number
  /** 見えている範囲（秒） */
  from: number
  to: number
  height: number
  duration: number
}

/** その拡大率で何秒ごとにコマを置くか。半端な刻みだと拡大のたびに作り直しになる */
function stepFor(scale: number, thumbWidth: number): number {
  const sec = thumbWidth / scale
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]
  return steps.find((s) => s >= sec) ?? steps[steps.length - 1]
}

export function Filmstrip({ videoUrl, scale, from, to, height, duration }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const cache = useRef<Map<number, HTMLCanvasElement>>(new Map())
  const running = useRef(false)

  // 取り出し用の隠した video。1つだけ使い回す
  useEffect(() => {
    if (!videoUrl) {
      videoRef.current = null
      return
    }
    const v = document.createElement('video')
    v.src = videoUrl
    v.muted = true
    v.preload = 'auto'
    v.crossOrigin = 'anonymous'
    videoRef.current = v
    cache.current.clear()
    return () => {
      v.src = ''
      videoRef.current = null
    }
  }, [videoUrl])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const thumbW = Math.round((height * 16) / 9)
    const step = stepFor(scale, thumbW)
    const dpr = window.devicePixelRatio || 1
    const widthPx = Math.max(1, (to - from) * scale)

    canvas.width = widthPx * dpr
    canvas.height = height * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)

    const paint = () => {
      ctx.clearRect(0, 0, widthPx, height)
      ctx.fillStyle = '#141414'
      ctx.fillRect(0, 0, widthPx, height)

      const first = Math.floor(from / step) * step
      for (let t = first; t < to; t += step) {
        const x = (t - from) * scale
        const shot = cache.current.get(Math.round(t * 100))
        if (shot) {
          ctx.drawImage(shot, x, 0, thumbW, height)
        } else {
          // まだ取り出せていないところは、素材があることだけ分かる色で埋める
          ctx.fillStyle = '#22262b'
          ctx.fillRect(x, 0, thumbW - 1, height)
        }
        ctx.strokeStyle = 'rgba(0,0,0,0.5)'
        ctx.beginPath()
        ctx.moveTo(x + thumbW - 0.5, 0)
        ctx.lineTo(x + thumbW - 0.5, height)
        ctx.stroke()
      }
    }

    paint()

    const video = videoRef.current
    if (!video || running.current) return

    // 見えている範囲のコマを、1枚ずつ順番に取り出す
    const wanted: number[] = []
    const first = Math.floor(from / step) * step
    for (let t = first; t < to && t < duration; t += step) {
      const key = Math.round(t * 100)
      if (!cache.current.has(key)) wanted.push(t)
    }
    if (!wanted.length) return

    let cancelled = false
    running.current = true

    const grab = async () => {
      for (const t of wanted) {
        if (cancelled) break
        try {
          await new Promise<void>((resolve, reject) => {
            const onSeeked = () => {
              video.removeEventListener('seeked', onSeeked)
              resolve()
            }
            const onError = () => {
              video.removeEventListener('error', onError)
              reject(new Error('seek 失敗'))
            }
            video.addEventListener('seeked', onSeeked, { once: true })
            video.addEventListener('error', onError, { once: true })
            video.currentTime = Math.min(t, Math.max(0, duration - 0.05))
          })
          const off = document.createElement('canvas')
          off.width = thumbW
          off.height = height
          const octx = off.getContext('2d')
          if (octx) {
            octx.drawImage(video, 0, 0, thumbW, height)
            cache.current.set(Math.round(t * 100), off)
            paint()
          }
        } catch {
          break
        }
      }
      running.current = false
    }
    void grab()

    return () => {
      cancelled = true
      running.current = false
    }
  }, [videoUrl, scale, from, to, height, duration])

  return (
    <canvas
      ref={canvasRef}
      className="lane-canvas"
      style={{ height, width: Math.max(1, (to - from) * scale) }}
    />
  )
}
