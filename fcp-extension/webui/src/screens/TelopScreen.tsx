// ⑤ テロップ画面。左にプレビュー、右に生成テロップの一覧。
//
// タイムラインではテロップを掴んで動かせる。端を掴めば表示時間を変えられる。
// 一覧は再生中のものを目立たせ、隠れたら自動で追いかける。
// （長い素材ではテロップが数百枚になるので、探す作業が発生しないようにする）

import { useEffect, useMemo, useRef, useState } from 'react'
import { Preview } from '../components/Preview'
import { Timeline } from '../components/Timeline'
import type { Clip } from '../components/Timeline'
import { StylePanel } from '../components/StylePanel'
import { usePlayback } from '../lib/store'
import type { Store } from '../lib/store'
import { STYLE_LABEL } from '../lib/types'
import type { StyleName, Telop, TelopStyle } from '../lib/types'
import { fmtTime } from '../lib/format'
import { applySpan, clampSpans, clearSpan, spanAt } from '../lib/spans'

/**
 * 新しいテロップの ID を作る。
 *
 * 🔴 モジュール変数の連番だけで作ってはいけない。画面が作り直されると
 *    カウンタが戻り、**既に居るテロップと同じ ID** が生まれる。
 *    そうなると「再生中の行」が複数光り、選択も取り違える。
 */
let telopSeq = 0
function newTelopId(): string {
  const rand = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10)
  return `t${Date.now().toString(36)}${(telopSeq++).toString(36)}${rand}`
}

export function TelopScreen({
  store,
  speed,
  onSpeedChange,
}: {
  store: Store
  /** 再生速度。書き出しに指定するものと同じ値 */
  speed: number
  onSpeedChange: (speed: number) => void
}) {
  const { state, updateTelop, addTelop, removeTelop, updateStyle, pickTemplate, dropTemplate, undo } =
    store
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingStyle, setEditingStyle] = useState<StyleName>('normal')
  // 既定スタイルは畳んでおく。普段は一覧を広く使いたいので
  const [styleOpen, setStyleOpen] = useState(false)
  const [templateOpen, setTemplateOpen] = useState(false)
  const clipboard = useRef<Telop | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  /** 本文のどこを選んでいるか（一部だけ見た目を変えるのに使う） */
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null)

  const duration = state?.durationSec ?? 0
  // 承認したカットは飛ばして再生する（切ったあとの繋がりを確かめるため）
  const { time, playing, seek, toggle } = usePlayback(duration, videoEl, store.approvedCuts, speed)

  const selected = state?.telops.find((t) => t.id === selectedId) ?? null

  /** いま再生位置にかかっているテロップ */
  const playingTelop = useMemo(
    () => state?.telops.find((t) => time >= t.start && time <= t.end) ?? null,
    [state, time],
  )

  /**
   * プレビューに出すもの。
   *
   * 再生中は「その時刻に出るテロップ」を優先する。選択したものを出し続けると、
   * 再生しても他のテロップが一切出てこなくなる。
   * 止めているときは選択中を優先する（見た目を確かめるため）。
   */
  const shown = playing ? (playingTelop ?? selected) : (selected ?? playingTelop)

  const shownStyle: TelopStyle | null = useMemo(() => {
    if (!state || !shown) return null
    return { ...state.styles[shown.style], ...(shown.overrides ?? {}) }
  }, [state, shown])

  // 再生中のテロップが画面の外に出たら、一覧を追いかけさせる。
  //
  // 位置は getBoundingClientRect で測る。offsetTop は「位置指定された親」からの
  // 距離なので、一覧が position: relative でないと別の場所を指してしまう。
  useEffect(() => {
    if (!playingTelop || !listRef.current) return
    const list = listRef.current
    const row = list.querySelector<HTMLElement>(`[data-telop="${playingTelop.id}"]`)
    if (!row) return

    const listBox = list.getBoundingClientRect()
    const rowBox = row.getBoundingClientRect()
    const above = rowBox.top < listBox.top
    const below = rowBox.bottom > listBox.bottom
    if (!above && !below) return

    // 真ん中に寄せる。scrollTop を直に入れる（滑らかな移動は
    // パネルが隠れている間は動かないことがあるため、確実な方を採る）
    const delta = rowBox.top - listBox.top - (list.clientHeight - rowBox.height) / 2
    list.scrollTop = Math.max(0, list.scrollTop + delta)
  }, [playingTelop])

  useEffect(() => {
    if (!state) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return
      const mod = e.metaKey || e.ctrlKey
      const idx = state.telops.findIndex((t) => t.id === selectedId)

      if (mod && e.key.toLowerCase() === 'z') {
        // 文字入力中の取り消しは、入力欄自身に任せる
        e.preventDefault()
        undo()
      } else if (e.code === 'Space' && !mod) {
        e.preventDefault()
        toggle()
      } else if (mod && e.key.toLowerCase() === 'c' && selected) {
        e.preventDefault()
        clipboard.current = selected
      } else if (mod && e.key.toLowerCase() === 'v' && clipboard.current) {
        e.preventDefault()
        pasteAt(clipboard.current, time)
      } else if (mod && e.key.toLowerCase() === 'd' && selected) {
        e.preventDefault()
        pasteAt(selected, selected.end + 0.2)
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && selected) {
        e.preventDefault()
        removeTelop(selected.id)
        setSelectedId(null)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        const next = state.telops[Math.min(state.telops.length - 1, idx + 1)]
        if (next) {
          setSelectedId(next.id)
          seek(next.start)
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const prev = state.telops[Math.max(0, idx - 1)]
        if (prev) {
          setSelectedId(prev.id)
          seek(prev.start)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, selectedId, selected, time, toggle, seek, removeTelop, undo])

  /** 本文のどこを選んでいるかを読む */
  function readSelection(e: { currentTarget: HTMLTextAreaElement }) {
    const el = e.currentTarget
    setSel(
      el.selectionStart === el.selectionEnd
        ? null
        : { start: el.selectionStart, end: el.selectionEnd },
    )
  }

  /** コピー元の見た目と長さを保ったまま、指定時刻に置く */
  function pasteAt(src: Telop, at: number) {
    const len = src.end - src.start
    const start = Math.max(0, Math.min(duration - len, at))
    const copy: Telop = { ...src, id: newTelopId(), start, end: start + len }
    addTelop(copy)
    setSelectedId(copy.id)
  }

  if (!state) return <div className="empty">読み込み中…</div>

  const clips: Clip[] = state.telops.map((t) => ({
    id: t.id,
    start: t.start,
    end: t.end,
    kind: 'telop',
    label: t.text,
  }))

  return (
    <div className="body">
      {/* 左：プレビュー */}
      <div className="panel" style={{ flex: 1 }}>
        <div className="panel-title">
          プレビュー
          <span className="spacer" />
          <span className="warn">
            {state.template
              ? `※ 見本「${state.template.effectName}」を使用。プレビューは近似です`
              : '※ 実際の見た目は FCP のテンプレが描画するため細部が異なります'}
          </span>
        </div>
        <Preview
          videoUrl={state.videoUrl}
          durationSec={duration}
          time={time}
          playing={playing}
          onSeek={seek}
          onToggle={toggle}
          telop={shown}
          style={shownStyle}
          videoRef={setVideoEl}
          speed={speed}
          onSpeedChange={onSpeedChange}
          onMoveTelop={(id, leftPercent, bottomPercent) => {
            const t = state.telops.find((x) => x.id === id)
            if (!t) return
            updateTelop(id, { overrides: { ...(t.overrides ?? {}), leftPercent, bottomPercent } })
          }}
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
            onTrim={(id, start, end) => updateTelop(id, { start, end })}
            movable
            laneLabel="テロップ"
          />
        </div>
        <div className="hint">
          クリップを掴むと移動、端を掴むと表示時間の変更 ・ スペース = 再生/停止 ・ ↑↓ = 移動
          <br />
          Cmd+C / Cmd+V = コピー・貼り付け ・ Cmd+D = 複製 ・ Delete = 削除 ・ Cmd+Z = ひとつ戻す
        </div>
      </div>

      {/* 右：一覧と設定 */}
      <div className="panel" style={{ width: 380, flex: '0 0 380px' }}>
        <div className="panel-title">
          <span>テロップ {state.telops.length} 件</span>
          <span className="spacer" />
          <button
            className="tiny"
            disabled={!selected}
            onClick={() => selected && (clipboard.current = selected)}
          >
            コピー
          </button>
          <button
            className="tiny"
            disabled={!clipboard.current}
            onClick={() => clipboard.current && pasteAt(clipboard.current, time)}
          >
            貼り付け
          </button>
          <button
            className="tiny"
            disabled={!selected}
            onClick={() => selected && pasteAt(selected, selected.end + 0.2)}
          >
            複製
          </button>
        </div>

        <div className="list" ref={listRef}>
          {state.telops.map((t) => (
            <div
              key={t.id}
              data-telop={t.id}
              className={[
                'row',
                selectedId === t.id ? 'selected' : '',
                playingTelop?.id === t.id ? 'playing' : '',
              ].join(' ')}
              onClick={() => {
                setSelectedId(t.id)
                seek(t.start)
              }}
            >
              <span className={`badge ${t.style}`}>{STYLE_LABEL[t.style]}</span>
              <span className="row-time">{fmtTime(t.start)}</span>
              <span className="row-text">{t.text}</span>
            </div>
          ))}
        </div>

        {/* 選択中のテロップの編集 */}
        {selected && (
          <div className="section">
            <div className="panel-title">
              選択中のテロップ
              <span className="spacer" />
              <span style={{ color: 'var(--text-faint)' }}>本文の一部を選ぶとそこだけ変えられます</span>
            </div>
            <div className="form">
              <label>本文</label>
              <textarea
                ref={textRef}
                rows={2}
                value={selected.text}
                onChange={(e) => {
                  const text = e.target.value
                  updateTelop(selected.id, { text, spans: clampSpans(selected.spans, text.length) })
                }}
                // 選択の取り方は1つに頼らない。onSelect だけだと
                // 環境によってキーボード操作での選択を取りこぼす
                onSelect={readSelection}
                onKeyUp={readSelection}
                onMouseUp={readSelection}
                onFocus={readSelection}
              />

              <label>スタイル</label>
              <select
                value={selected.style}
                onChange={(e) => updateTelop(selected.id, { style: e.target.value as StyleName })}
              >
                <option value="normal">{STYLE_LABEL.normal}</option>
                <option value="emphasis">{STYLE_LABEL.emphasis}</option>
              </select>

              <label>時間</label>
              <div className="inline">
                <input
                  type="number"
                  step={0.1}
                  value={Number(selected.start.toFixed(1))}
                  onChange={(e) => updateTelop(selected.id, { start: Number(e.target.value) })}
                />
                <span style={{ color: 'var(--text-faint)' }}>〜</span>
                <input
                  type="number"
                  step={0.1}
                  value={Number(selected.end.toFixed(1))}
                  onChange={(e) => updateTelop(selected.id, { end: Number(e.target.value) })}
                />
              </div>

              <label>位置</label>
              <div className="inline">
                <span style={{ color: 'var(--text-faint)' }}>左</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={Math.round(shownStyle?.leftPercent ?? 50)}
                  onChange={(e) =>
                    updateTelop(selected.id, {
                      overrides: {
                        ...(selected.overrides ?? {}),
                        leftPercent: Number(e.target.value),
                      },
                    })
                  }
                />
                <span style={{ color: 'var(--text-faint)' }}>下</span>
                <input
                  type="number"
                  min={0}
                  max={90}
                  value={Math.round(shownStyle?.bottomPercent ?? 12)}
                  onChange={(e) =>
                    updateTelop(selected.id, {
                      overrides: {
                        ...(selected.overrides ?? {}),
                        bottomPercent: Number(e.target.value),
                      },
                    })
                  }
                />
                <span style={{ color: 'var(--text-faint)' }}>%（プレビューで掴んでも動かせます）</span>
              </div>

              <label>自動改行</label>
              <div className="inline">
                <input
                  type="checkbox"
                  checked={shownStyle?.autoWrap ?? true}
                  onChange={(e) =>
                    updateTelop(selected.id, {
                      overrides: { ...(selected.overrides ?? {}), autoWrap: e.target.checked },
                    })
                  }
                />
                <span style={{ color: 'var(--text-faint)' }}>
                  切ると画面からはみ出せます。手で入れた改行は常に効きます
                  <br />
                  （FCP 側の折り返し幅はテンプレートが決めるため、ここはプレビューの確認用）
                </span>
              </div>
            </div>

            {/* 選んだ文字だけの見た目 */}
            <div className="span-editor">
              {sel ? (
                <>
                  <div className="span-target">「{selected.text.slice(sel.start, sel.end)}」だけ変える</div>
                  <div className="inline">
                    <span style={{ color: 'var(--text-faint)' }}>大きさ</span>
                    <input
                      type="number"
                      style={{ width: 70 }}
                      value={
                        spanAt(selected.spans, sel.start, sel.end)?.fontSize ??
                        Math.round(shownStyle?.fontSize ?? 48)
                      }
                      onChange={(e) =>
                        updateTelop(selected.id, {
                          spans: applySpan(selected.spans, sel.start, sel.end, {
                            ...spanAt(selected.spans, sel.start, sel.end),
                            fontSize: Number(e.target.value),
                          }),
                        })
                      }
                    />
                    <input
                      type="color"
                      value={
                        spanAt(selected.spans, sel.start, sel.end)?.color ??
                        shownStyle?.color ??
                        '#ffffff'
                      }
                      onChange={(e) =>
                        updateTelop(selected.id, {
                          spans: applySpan(selected.spans, sel.start, sel.end, {
                            ...spanAt(selected.spans, sel.start, sel.end),
                            color: e.target.value,
                          }),
                        })
                      }
                    />
                    <label style={{ color: 'var(--text-faint)' }}>
                      <input
                        type="checkbox"
                        checked={spanAt(selected.spans, sel.start, sel.end)?.bold ?? false}
                        onChange={(e) =>
                          updateTelop(selected.id, {
                            spans: applySpan(selected.spans, sel.start, sel.end, {
                              ...spanAt(selected.spans, sel.start, sel.end),
                              bold: e.target.checked,
                            }),
                          })
                        }
                      />
                      太字
                    </label>
                    <button
                      className="tiny"
                      onClick={() =>
                        updateTelop(selected.id, {
                          spans: clearSpan(selected.spans, sel.start, sel.end),
                        })
                      }
                    >
                      解除
                    </button>
                  </div>
                </>
              ) : (
                <div className="span-hint">
                  本文の中で文字を選ぶと、そこだけ大きさ・色・太さを変えられます
                  {selected.spans?.length ? `（設定済み ${selected.spans.length} か所）` : ''}
                </div>
              )}
            </div>
          </div>
        )}

        {/* テロップの見本（畳んでおく） */}
        <div className="section">
          <button className="disclosure" onClick={() => setTemplateOpen((v) => !v)}>
            <span className="disclosure-arrow">{templateOpen ? '▾' : '▸'}</span>
            テロップの見本
            <span className="spacer" />
            <span className="disclosure-value">
              {state.template ? state.template.effectName : '未設定'}
            </span>
          </button>
          {templateOpen && (
            <>
              <div className="form">
                <label>いまの見た目</label>
                <div className="inline">
                  {state.template ? (
                    <span>
                      {state.template.font} {state.template.fontFace} / {state.template.fontSize}px
                    </span>
                  ) : (
                    <span className="warn">標準のタイトルになります</span>
                  )}
                </div>
                <label />
                <div className="inline">
                  <button className="tiny" onClick={() => void pickTemplate()}>
                    見本を読み込む
                  </button>
                  {state.template && (
                    <button className="tiny" onClick={() => void dropTemplate()}>
                      外す
                    </button>
                  )}
                </div>
              </div>
              <div className="hint">
                いつも使っているテロップを1つ置いた状態で FCP から XML を書き出し、それを読み込んでください。
              </div>
            </>
          )}
        </div>

        {/* 既定スタイル（畳んでおく） */}
        <div className="section">
          <button className="disclosure" onClick={() => setStyleOpen((v) => !v)}>
            <span className="disclosure-arrow">{styleOpen ? '▾' : '▸'}</span>
            既定のスタイル
            <span className="spacer" />
            <span className="disclosure-value">
              {state.styles.normal.fontFamily} / {state.styles.normal.fontSize}px
            </span>
          </button>
          {styleOpen && (
            <>
              <div className="tabs" style={{ margin: '8px 10px 0' }}>
                <button
                  className={`tab ${editingStyle === 'normal' ? 'active' : ''}`}
                  onClick={() => setEditingStyle('normal')}
                >
                  通常
                </button>
                <button
                  className={`tab ${editingStyle === 'emphasis' ? 'active' : ''}`}
                  onClick={() => setEditingStyle('emphasis')}
                >
                  強調
                </button>
              </div>
              <StylePanel
                name={editingStyle}
                style={state.styles[editingStyle]}
                fonts={state.fonts}
                onChange={(patch) => updateStyle(editingStyle, patch)}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
