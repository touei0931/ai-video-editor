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

import { useEffect, useRef, useState } from 'react'
import { stepFor } from '../lib/filmstripStep'

interface Props {
  videoUrl: string | null
  /** 1秒あたりの画素数 */
  scale: number
  /** 見えている範囲（秒） */
  from: number
  to: number
  height: number
  duration: number
  /**
   * 素材の縦横比（幅 ÷ 高さ）。
   *
   * 🔴 16:9 で決め打ちにしないこと。
   *    縦の素材（2160x3840 など）を横長の枠に押し込むことになり、
   *    **コマが横に伸びて**何が写っているか分からなくなる（実機で指摘された）。
   */
  aspect?: number
  /** 素材のコマ数。これより細かい刻みには意味が無い（同じ絵が並ぶだけ） */
  fps?: number
}

export function Filmstrip({
  videoUrl,
  scale,
  from,
  to,
  height,
  duration,
  aspect = 16 / 9,
  fps = 30,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /* 動画が知っている形。分かった時点で描き直す */
  const [natural, setNatural] = useState(0)
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
    v.addEventListener(
      'loadedmetadata',
      () => {
        if (v.videoWidth > 0 && v.videoHeight > 0) setNatural(v.videoWidth / v.videoHeight)
      },
      { once: true },
    )
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

    /*
      🔴 素材の形で作ること。16:9 に押し込むと縦の素材が横に伸びる。
      🔴 動画自身が知っているならそちらを使うこと。
         渡ってくる値は解析が返さないと空になるが、動画は必ず自分の形を知っている
         （回転の情報も適用済み）。「届かなければ決め打ち」を残さない。
    */
    const v = videoRef.current
    const natural =
      v && v.videoWidth > 0 && v.videoHeight > 0 ? v.videoWidth / v.videoHeight : 0
    const useAspect = natural || aspect
    const thumbW = Math.max(4, Math.round(height * useAspect))
    const step = stepFor(scale, thumbW, fps)
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

      // 動画が無いときに箱だけ並べると、何の帯なのか分からない縞模様になる。
      // 素材が来ていないことをそのまま書く。
      if (!videoUrl) {
        ctx.fillStyle = '#5a5a5a'
        ctx.font = '11px -apple-system, "Hiragino Sans", sans-serif'
        ctx.textBaseline = 'middle'
        ctx.fillText('映像のコマ（動画を読み込むと表示されます）', 10, height / 2)
        return
      }

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

    /** 目的の時刻へ飛ぶ。返ってこないまま止まらないよう時間切れを設ける */
    const seekTo = (sec: number) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup()
          reject(new Error('seek が返ってこない'))
        }, 8000)
        const cleanup = () => {
          clearTimeout(timer)
          video.removeEventListener('seeked', onSeeked)
          video.removeEventListener('error', onError)
        }
        const onSeeked = () => {
          cleanup()
          resolve()
        }
        const onError = () => {
          cleanup()
          reject(new Error('seek 失敗'))
        }
        video.addEventListener('seeked', onSeeked)
        video.addEventListener('error', onError)
        video.currentTime = sec
      })

    const grab = async () => {
      // 🔴 読み込みが終わる前に currentTime を入れても seeked は来ない。
      //    そこで待たずに進むと、1枚も取り出せないまま黙って止まる
      //    （エラーも出ないので、原因が分からない形で壊れる）。
      if (video.readyState < 1) {
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('読み込みが終わらない')), 15000)
            video.addEventListener('loadedmetadata', () => { clearTimeout(timer); resolve() }, { once: true })
            video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('読み込み失敗')) }, { once: true })
          })
        } catch {
          running.current = false
          return
        }
      }
      if (cancelled) {
        running.current = false
        return
      }

      for (const t of wanted) {
        if (cancelled) break
        try {
          await seekTo(Math.min(t, Math.max(0, duration - 0.05)))
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
  }, [videoUrl, scale, from, to, height, duration, aspect, fps, natural])

  return (
    <canvas
      ref={canvasRef}
      className="lane-canvas"
      style={{ height, width: Math.max(1, (to - from) * scale) }}
    />
  )
}
