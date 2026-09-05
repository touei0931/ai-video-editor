// ④ カット画面。左に映像とタイムライン、右にカット候補の一覧。
//
// 友達のペインは「1本30〜60分のカット作業」なので、
// 見て押すだけで進むこと（レビュー速度）を最優先にしている。
// Enter で承認すると、次の未判断へ飛んで**その少し手前から再生**する。
// 判断に必要なのは「切ったあとどう繋がるか」なので、手前から流して見せる。

import { useEffect, useMemo, useRef, useState } from 'react'
import { Preview } from '../components/Preview'
import { Timeline } from '../components/Timeline'
import type { Clip } from '../components/Timeline'
import { usePlayback } from '../lib/store'
import { CUT_LABEL } from '../lib/types'
import type { Store } from '../lib/store'
import { fmtTime } from '../lib/format'

/** 承認したあと、次の候補の何秒前から再生するか */
const LEAD_IN = 0.5

export function CutScreen({
  store,
  onNext,
  speed,
  onSpeedChange,
}: {
  store: Store
  onNext: () => void
  /** 再生速度。書き出しに指定するものと同じ値 */
  speed: number
  onSpeedChange: (speed: number) => void
}) {
  const { state, decideCut, decideAllCuts, updateCut, undo } = store
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const duration = state?.durationSec ?? 0
  // 承認したカットは飛ばして再生する。切ると決めた区間を流しても確認にならない
  const { time, playing, seek, toggle, play } = usePlayback(duration, videoEl, store.approvedCuts, speed)

  /**
   * いま再生位置がかかっているカット候補。
   *
   * 少し手前から当たりにする。「そろそろ来る」と分かった時点で
   * 手が動かせないと、通り過ぎてから押すことになる。
   */
  const playingCut = useMemo(
    () =>
      state?.cuts.find((c) => time >= c.start - LEAD_IN && time <= c.end) ?? null,
    [state, time],
  )

  // 再生しながら Enter / Delete だけで捌けるように、
  // 通りかかった候補を自動で選ぶ。手で選んだものは、再生していない限り邪魔しない。
  useEffect(() => {
    if (!playing || !playingCut) return
    if (playingCut.id !== selectedId) setSelectedId(playingCut.id)
  }, [playing, playingCut, selectedId])

  // 選ばれている候補が一覧から見えなくなったら追いかける
  useEffect(() => {
    const id = playingCut?.id ?? selectedId
    if (!id || !listRef.current) return
    const list = listRef.current
    const row = list.querySelector<HTMLElement>(`[data-cut="${id}"]`)
    if (!row) return
    const listBox = list.getBoundingClientRect()
    const rowBox = row.getBoundingClientRect()
    if (rowBox.top >= listBox.top && rowBox.bottom <= listBox.bottom) return
    const delta = rowBox.top - listBox.top - (list.clientHeight - rowBox.height) / 2
    list.scrollTop = Math.max(0, list.scrollTop + delta)
  }, [playingCut, selectedId])

  /** 次の「未判断」へ飛んで、その少し手前から流す */
  const goNextPending = (fromId: string | null) => {
    if (!state) return
    const cuts = state.cuts
    const idx = fromId ? cuts.findIndex((c) => c.id === fromId) : -1
    const next =
      cuts.slice(idx + 1).find((c) => c.decision === 'pending') ??
      cuts.find((c) => c.decision === 'pending')
    if (!next) {
      // 全部さばけたら、そのまま次の画面へ進める合図を出す
      setSelectedId(null)
      return
    }
    setSelectedId(next.id)
    seek(Math.max(0, next.start - LEAD_IN))
    play()
  }

  useEffect(() => {
    if (!state) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return

      const idx = state.cuts.findIndex((c) => c.id === selectedId)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
      } else if (e.code === 'Space') {
        e.preventDefault()
        toggle()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        const next = state.cuts[Math.min(state.cuts.length - 1, idx + 1)]
        if (next) {
          setSelectedId(next.id)
          seek(Math.max(0, next.start - LEAD_IN))
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const prev = state.cuts[Math.max(0, idx - 1)]
        if (prev) {
          setSelectedId(prev.id)
          seek(Math.max(0, prev.start - LEAD_IN))
        }
      } else if (e.key === 'Enter' && selectedId) {
        e.preventDefault()
        decideCut(selectedId, 'approved')
        goNextPending(selectedId)
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && selectedId) {
        e.preventDefault()
        decideCut(selectedId, 'rejected')
        goNextPending(selectedId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, selectedId, toggle, seek, decideCut, undo])

  if (!state) return <div className="empty">読み込み中…</div>

  const approved = state.cuts.filter((c) => c.decision === 'approved').length
  const rejected = state.cuts.filter((c) => c.decision === 'rejected').length
  const pending = state.cuts.length - approved - rejected
  const removedSec = state.cuts
    .filter((c) => c.decision === 'approved')
    .reduce((a, c) => a + (c.end - c.start), 0)

  const clips: Clip[] = state.cuts.map((c) => ({
    id: c.id,
    start: c.start,
    end: c.end,
    kind: c.kind,
    label: CUT_LABEL[c.kind],
    dim: c.decision === 'rejected',
  }))

  return (
    <div className="body">
      <div className="panel" style={{ flex: 1 }}>
        <div className="panel-title">
          プレビュー
          <span className="spacer" />
          <span style={{ color: 'var(--text-faint)' }}>
            クリップの端を掴むとカット位置を調整できます
          </span>
        </div>
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
          speed={speed}
          onSpeedChange={onSpeedChange}
        />
        <div style={{ padding: '0 8px 8px' }}>
          <Timeline
            duration={duration}
            /*
              🔴 素材のコマ数を使うこと。30 決め打ちだと、
                 60fps の素材で切れ目が半コマずれ、コマ割りも粗いままになる。
            */
            fps={state.fps ?? 30}
            /* 🔴 素材の形。渡さないと縦の素材でコマが横に伸びる */
            aspect={state.width && state.height ? state.width / state.height : undefined}
            time={time}
            onSeek={seek}
            waveform={state.waveform}
            videoUrl={state.videoUrl}
            clips={clips}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onTrim={(id, start, end) => updateCut(id, { start, end })}
            laneLabel="カット"
          />
        </div>
        {/*
          🔴 キーの一覧はここに置かないこと（候補の一覧側に移した）。
             左下は映像から遠く、捌いている間ずっと目に入らない場所だった。
             実際「ショートカットが欲しい」と言われた（もう在ったのに）。
        */}
        <div className="hint">
          再生しておけば、通りかかった候補が自動で選ばれます。そのまま Enter か Delete で捌けます。
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

        {/*
          🔴 キーの割り当ては画面に出すこと。
             実装してあっても書いていなければ、使う人には無いのと同じ。
             カットは1本で数百件あるので、マウスだけで捌くと現実的な時間で終わらない。
        */}
        <div className="keyhints">
          <span><kbd>Space</kbd> 再生 / 停止</span>
          <span><kbd>↑</kbd><kbd>↓</kbd> 候補を移動</span>
          <span><kbd>Enter</kbd> 切る</span>
          <span><kbd>Delete</kbd> 残す</span>
          <span><kbd>⌘Z</kbd> ひとつ戻す</span>
        </div>

        <div className="list" ref={listRef}>
          {state.cuts.map((c) => (
            <div
              key={c.id}
              data-cut={c.id}
              className={[
                'row',
                selectedId === c.id ? 'selected' : '',
                playingCut?.id === c.id ? 'playing' : '',
                c.decision === 'rejected' ? 'rejected' : '',
              ].join(' ')}
              onClick={() => {
                setSelectedId(c.id)
                seek(Math.max(0, c.start - LEAD_IN))
              }}
            >
              <span className={`badge ${c.kind}`}>{CUT_LABEL[c.kind]}</span>
              <span className="row-time">{fmtTime(c.start)}</span>
              <span className="row-text">
                {c.text || (
                  <span style={{ color: 'var(--text-faint)' }}>
                    （無音 {(c.end - c.start).toFixed(1)}秒）
                  </span>
                )}
              </span>
              <span className="row-actions">
                <button
                  className={`tiny ${c.decision === 'approved' ? 'primary' : 'ok'}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    const next = c.decision === 'approved' ? 'pending' : 'approved'
                    decideCut(c.id, next)
                    if (next === 'approved') goNextPending(c.id)
                  }}
                  title="このカットを実行する"
                >
                  切る
                </button>
                <button
                  className="tiny ng"
                  onClick={(e) => {
                    e.stopPropagation()
                    const next = c.decision === 'rejected' ? 'pending' : 'rejected'
                    decideCut(c.id, next)
                    if (next === 'rejected') goNextPending(c.id)
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

        <div className="step-footer">
          <span className="spacer" />
          <button className="primary" onClick={onNext}>
            次へ（テロップ）
          </button>
        </div>
      </div>
    </div>
  )
}
