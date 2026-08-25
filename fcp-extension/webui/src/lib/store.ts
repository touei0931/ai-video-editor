// 画面の状態と、それを変える操作をまとめたところ。
// UI コンポーネントはここから受け取った関数を呼ぶだけにして、
// Swift とのやり取り（bridge.ts）に直接触らせない。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clearTitleTemplate, loadProject, loadTitleTemplate } from './bridge'
import type { CutCandidate, Decision, ProjectState, StyleName, Telop, TelopStyle } from './types'

export interface Store {
  state: ProjectState | null
  /** カットの承認/却下 */
  decideCut: (id: string, decision: Decision) => void
  decideAllCuts: (decision: Decision) => void
  /** テロップの編集 */
  updateTelop: (id: string, patch: Partial<Telop>) => void
  addTelop: (telop: Telop) => void
  removeTelop: (id: string) => void
  /** 既定スタイルの編集 */
  updateStyle: (name: StyleName, patch: Partial<TelopStyle>) => void
  /** 承認済みのカットだけ */
  approvedCuts: CutCandidate[]
  /** テロップの見本を取り込む / 外す */
  pickTemplate: () => Promise<string | null>
  dropTemplate: () => Promise<void>
}

export function useStore(): Store {
  const [state, setState] = useState<ProjectState | null>(null)

  useEffect(() => {
    let alive = true
    loadProject().then((p) => {
      if (alive) setState(p)
    })
    return () => {
      alive = false
    }
  }, [])

  const decideCut = useCallback((id: string, decision: Decision) => {
    setState((s) =>
      s ? { ...s, cuts: s.cuts.map((c) => (c.id === id ? { ...c, decision } : c)) } : s,
    )
  }, [])

  const decideAllCuts = useCallback((decision: Decision) => {
    setState((s) => (s ? { ...s, cuts: s.cuts.map((c) => ({ ...c, decision })) } : s))
  }, [])

  const updateTelop = useCallback((id: string, patch: Partial<Telop>) => {
    setState((s) =>
      s ? { ...s, telops: s.telops.map((t) => (t.id === id ? { ...t, ...patch } : t)) } : s,
    )
  }, [])

  const addTelop = useCallback((telop: Telop) => {
    setState((s) =>
      s ? { ...s, telops: [...s.telops, telop].sort((a, b) => a.start - b.start) } : s,
    )
  }, [])

  const removeTelop = useCallback((id: string) => {
    setState((s) => (s ? { ...s, telops: s.telops.filter((t) => t.id !== id) } : s))
  }, [])

  const updateStyle = useCallback((name: StyleName, patch: Partial<TelopStyle>) => {
    setState((s) =>
      s ? { ...s, styles: { ...s.styles, [name]: { ...s.styles[name], ...patch } } } : s,
    )
  }, [])

  /** 見本を取り込むと、既定スタイルも見本の見た目に合わせる（通常はそのまま、強調は色だけ変える） */
  const pickTemplate = useCallback(async () => {
    try {
      const t = await loadTitleTemplate()
      setState((s) => {
        if (!s) return s
        const face = t.fontFace ? `${t.font} ${t.fontFace}` : t.font
        return {
          ...s,
          template: t,
          styles: {
            normal: { ...s.styles.normal, fontFamily: face, fontSize: t.fontSize, bold: t.bold, color: '#ffffff' },
            emphasis: { ...s.styles.emphasis, fontFamily: face, fontSize: t.fontSize, bold: t.bold },
          },
        }
      })
      return t.effectName
    } catch (e) {
      return null
    }
  }, [])

  const dropTemplate = useCallback(async () => {
    await clearTitleTemplate()
    setState((s) => (s ? { ...s, template: null } : s))
  }, [])

  const approvedCuts = useMemo(
    () => (state ? state.cuts.filter((c) => c.decision === 'approved') : []),
    [state],
  )

  return {
    state,
    decideCut,
    decideAllCuts,
    updateTelop,
    addTelop,
    removeTelop,
    updateStyle,
    approvedCuts,
    pickTemplate,
    dropTemplate,
  }
}

/**
 * 再生位置の管理。
 * 動画がある時は video 要素が時計、無い時（開発中）は requestAnimationFrame が時計。
 * どちらでも同じように playhead が動くようにしておく。
 */
export function usePlayback(durationSec: number, videoEl: HTMLVideoElement | null) {
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const raf = useRef<number | null>(null)
  const last = useRef<number>(0)

  // 動画がある場合は video 要素に追従する
  useEffect(() => {
    if (!videoEl) return
    const onTime = () => setTime(videoEl.currentTime)
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    videoEl.addEventListener('timeupdate', onTime)
    videoEl.addEventListener('play', onPlay)
    videoEl.addEventListener('pause', onPause)
    return () => {
      videoEl.removeEventListener('timeupdate', onTime)
      videoEl.removeEventListener('play', onPlay)
      videoEl.removeEventListener('pause', onPause)
    }
  }, [videoEl])

  // 動画が無い場合は自前で時間を進める
  useEffect(() => {
    if (videoEl || !playing) return
    last.current = performance.now()
    const tick = (now: number) => {
      // パネルが隠れている間 requestAnimationFrame は止まる。
      // 復帰したときに「隠れていた時間」がまるごと加算されて
      // 再生位置が飛ぶので、1フレーム分の上限をかける。
      const dt = Math.min(0.25, (now - last.current) / 1000)
      last.current = now
      setTime((t) => {
        const next = t + dt
        if (next >= durationSec) {
          setPlaying(false)
          return durationSec
        }
        return next
      })
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current)
    }
  }, [playing, durationSec, videoEl])

  const seek = useCallback(
    (t: number) => {
      const clamped = Math.max(0, Math.min(durationSec, t))
      setTime(clamped)
      if (videoEl) videoEl.currentTime = clamped
    },
    [durationSec, videoEl],
  )

  const toggle = useCallback(() => {
    if (videoEl) {
      videoEl.paused ? void videoEl.play() : videoEl.pause()
    } else {
      setPlaying((p) => !p)
    }
  }, [videoEl])

  return { time, playing, seek, toggle }
}
