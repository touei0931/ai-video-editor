// 画面の状態と、それを変える操作をまとめたところ。
// UI コンポーネントはここから受け取った関数を呼ぶだけにして、
// Swift とのやり取り（bridge.ts）に直接触らせない。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { splitTelops } from './splitTelop'
import { clearTitleTemplate, loadProject, loadTitleTemplate } from './bridge'
import type { CutCandidate, Decision, ProjectState, StyleName, Telop, TelopStyle } from './types'

export interface Store {
  state: ProjectState | null
  /** カットの承認/却下 */
  decideCut: (id: string, decision: Decision) => void
  decideAllCuts: (decision: Decision) => void
  /** カットの区間を直す（タイムラインで端を掴んだとき） */
  updateCut: (id: string, patch: Partial<CutCandidate>) => void
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
  /** 解析の結果で中身を入れ替える（スタイル・フォント・見本は保つ） */
  applyAnalysis: (result: Partial<ProjectState>, telopMaxChars?: number) => void
  /** ひとつ前に戻す（Cmd+Z） */
  undo: () => void
  canUndo: boolean
}

export function useStore(): Store {
  const [state, setState] = useState<ProjectState | null>(null)

  /**
   * ひとつ前に戻すための控え。
   *
   * 直前の状態だけでなく少し遡れるようにしておく。テロップの手直しは
   * 「色を変えて、位置も動かして、やっぱり戻したい」と続くことが多い。
   */
  const history = useRef<ProjectState[]>([])
  const [canUndo, setCanUndo] = useState(false)

  /** 変更を加える前に、いまの状態を控えておく */
  const edit = useCallback((fn: (s: ProjectState) => ProjectState) => {
    setState((s) => {
      if (!s) return s
      history.current = [...history.current.slice(-49), s]
      setCanUndo(true)
      return fn(s)
    })
  }, [])

  const undo = useCallback(() => {
    setState((s) => {
      const prev = history.current.pop()
      if (!prev) return s
      setCanUndo(history.current.length > 0)
      return prev
    })
  }, [])

  useEffect(() => {
    let alive = true
    loadProject().then((p) => {
      if (alive) setState(p)
    })
    return () => {
      alive = false
    }
  }, [])

  const decideCut = useCallback(
    (id: string, decision: Decision) => {
      edit((s) => ({ ...s, cuts: s.cuts.map((c) => (c.id === id ? { ...c, decision } : c)) }))
    },
    [edit],
  )

  const decideAllCuts = useCallback(
    (decision: Decision) => {
      edit((s) => ({ ...s, cuts: s.cuts.map((c) => ({ ...c, decision })) }))
    },
    [edit],
  )

  const updateCut = useCallback(
    (id: string, patch: Partial<CutCandidate>) => {
      edit((s) => ({ ...s, cuts: s.cuts.map((c) => (c.id === id ? { ...c, ...patch } : c)) }))
    },
    [edit],
  )

  const updateTelop = useCallback(
    (id: string, patch: Partial<Telop>) => {
      edit((s) => ({ ...s, telops: s.telops.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
    },
    [edit],
  )

  const addTelop = useCallback(
    (telop: Telop) => {
      edit((s) => ({ ...s, telops: [...s.telops, telop].sort((a, b) => a.start - b.start) }))
    },
    [edit],
  )

  const removeTelop = useCallback(
    (id: string) => {
      edit((s) => ({ ...s, telops: s.telops.filter((t) => t.id !== id) }))
    },
    [edit],
  )

  const updateStyle = useCallback(
    (name: StyleName, patch: Partial<TelopStyle>) => {
      edit((s) => ({ ...s, styles: { ...s.styles, [name]: { ...s.styles[name], ...patch } } }))
    },
    [edit],
  )

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

  const applyAnalysis = useCallback((result: Partial<ProjectState>, telopMaxChars?: number) => {
    setState((s) => {
      // 解析が返すのは素材そのものの情報だけ。
      // 見た目の設定と見本は利用者が決めたものなので上書きしない。
      const base = s ?? null
      /*
        🔴 エンジンが返すのは「文のまとまり」で、1画面に出す量ではない。
           そのまま並べると 40文字・25秒のテロップになり、文節の途中でも切れる。
           ここで1画面ぶんに割り直す（splitTelop.ts）。
      */
      const telops = splitTelops(result.telops ?? [], telopMaxChars)
      if (!base) return { ...(result as ProjectState), telops }
      return {
        ...base,
        videoUrl: result.videoUrl ?? base.videoUrl,
        // 🔴 素材の大きさとコマ数を落とさないこと。落とすと書き出しが決め打ちに戻る
        width: result.width ?? base.width,
        height: result.height ?? base.height,
        fps: result.fps ?? base.fps,
        durationSec: result.durationSec ?? base.durationSec,
        waveform: result.waveform ?? base.waveform,
        cuts: result.cuts ?? [],
        telops,
      }
    })
  }, [])

  const approvedCuts = useMemo(
    () => (state ? state.cuts.filter((c) => c.decision === 'approved') : []),
    [state],
  )

  return {
    state,
    decideCut,
    decideAllCuts,
    updateCut,
    updateTelop,
    addTelop,
    removeTelop,
    updateStyle,
    approvedCuts,
    pickTemplate,
    dropTemplate,
    applyAnalysis,
    undo,
    canUndo,
  }
}

/**
 * 再生位置の管理。
 * 動画がある時は video 要素が時計、無い時（開発中）は requestAnimationFrame が時計。
 * どちらでも同じように playhead が動くようにしておく。
 */
export function usePlayback(
  durationSec: number,
  videoEl: HTMLVideoElement | null,
  /** 承認したカット。再生中はここを飛ばす（切ったあとの繋がりを確かめるため） */
  skips: { start: number; end: number }[] = [],
) {
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

  // 承認したカットに入ったら、その終わりまで飛ばす。
  // 「切ったあとどう繋がるか」を確かめるのがレビューの目的なので、
  // 切ると決めた区間を再生してしまうと確認にならない。
  const skipRef = useRef(skips)
  skipRef.current = skips
  useEffect(() => {
    if (!playing) return
    const hit = skipRef.current.find((c) => time >= c.start && time < c.end - 0.02)
    if (!hit) return
    const to = Math.min(durationSec, hit.end)
    setTime(to)
    if (videoEl) videoEl.currentTime = to
  }, [time, playing, videoEl, durationSec])

  const seek = useCallback(
    (t: number) => {
      const clamped = Math.max(0, Math.min(durationSec, t))
      setTime(clamped)
      if (videoEl) videoEl.currentTime = clamped
    },
    [durationSec, videoEl],
  )

  /** 終わりまで再生し切っていたら、頭から流し直す */
  const rewindIfEnded = useCallback(() => {
    if (time < durationSec - 0.05) return
    setTime(0)
    if (videoEl) videoEl.currentTime = 0
  }, [time, durationSec, videoEl])

  const play = useCallback(() => {
    rewindIfEnded()
    if (videoEl) void videoEl.play()
    else setPlaying(true)
  }, [videoEl, rewindIfEnded])

  const toggle = useCallback(() => {
    if (videoEl) {
      if (videoEl.paused) {
        rewindIfEnded()
        void videoEl.play()
      } else {
        videoEl.pause()
      }
    } else {
      setPlaying((p) => {
        if (!p) rewindIfEnded()
        return !p
      })
    }
  }, [videoEl, rewindIfEnded])

  return { time, playing, seek, toggle, play }
}
