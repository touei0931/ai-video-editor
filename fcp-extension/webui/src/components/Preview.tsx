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

/** 音量の覚え先。画面を移っても戻らないようにする */
const VOLUME_KEY = 'pac.preview.volume'
const MUTED_KEY = 'pac.preview.muted'

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
  /* 動画が読めなかった理由。真っ黒のままにしないための控え */
  const [loadError, setLoadError] = useState<string | null>(null)
  /*
    音量。
    🔴 覚えておくこと。画面を移るたびに戻ると、そのたびに下げ直すことになる。
       カットとテロップを行き来しながら何十回も再生する画面なので、
       ここが戻ると作業のたびに耳を驚かせる。
  */
  const [volume, setVolume] = useState(() => {
    /*
      🔴 覚えていないとき（null）を 0 にしないこと。
         Number(null) は 0 なので、そのまま通すと**初回が無音**になる。
         「音が出ない」の問い合わせは原因が分かりにくい。
    */
    const raw = localStorage.getItem(VOLUME_KEY)
    if (raw === null) return 1
    const saved = Number(raw)
    return Number.isFinite(saved) && saved >= 0 && saved <= 1 ? saved : 1
  })
  const [muted, setMuted] = useState(() => localStorage.getItem(MUTED_KEY) === '1')
  /* 音量を当てるために、こちらでも <video> を控えておく */
  const selfRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    const el = selfRef.current
    if (el) {
      el.volume = volume
      el.muted = muted
    }
    try {
      localStorage.setItem(VOLUME_KEY, String(volume))
      localStorage.setItem(MUTED_KEY, muted ? '1' : '0')
    } catch {
      /* 覚えられなくても再生は続く */
    }
  }, [volume, muted])
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
      // 画面の外にも少しはみ出せるようにしておく（端で切れるテロップも作れる）
      const left = Math.max(-15, Math.min(115, d.left + ((e.clientX - d.startX) / box.width) * 100))
      const bottom = Math.max(-10, Math.min(95, d.bottom - ((e.clientY - d.startY) / box.height) * 100))
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

  /**
   * 自動改行するときの折り返し幅。
   *
   * テロップは置いた位置を中心に描くので、端に寄せるほど画面に収まる幅は狭くなる。
   * ここを画面幅で固定すると、右に寄せたテロップが画面からはみ出す。
   * （はみ出させたいときは自動改行を切る）
   */
  const leftPercent = style?.leftPercent ?? 50
  const wrapWidth = Math.max(
    stageWidth * 0.08,
    Math.min(stageWidth * 0.96, stageWidth * 2 * (Math.min(leftPercent, 100 - leftPercent) / 100)),
  )

  return (
    <div className="preview-wrap">
      <div className="stage" ref={stageRef}>
        {videoUrl ? (
          <video
            ref={(el) => {
              // 🔴 受け取り側にも必ず渡すこと。渡さないと再生そのものが動かない
              videoRef(el)
              selfRef.current = el
              if (el) {
                el.volume = volume
                el.muted = muted
              }
            }}
            src={videoUrl}
            playsInline
            /*
              🔴 読めなかった理由を画面に出すこと。
                 出さないと真っ黒なままで、「動画が無い」のか
                 「読めなかった」のかが利用者にも作った側にも分からない。
                 パネルの中では file:// が許可の関係で読めないことがある。
            */
            onError={(e) => {
              // videoRef は「受け取るだけ」の関数なので、出来事から辿る
              const err = (e.currentTarget as HTMLVideoElement).error
              setLoadError(
                err ? `動画を読めませんでした（${err.code}: ${err.message || '理由不明'}）` : '動画を読めませんでした',
              )
            }}
            onLoadedMetadata={() => setLoadError(null)}
          />
        ) : (
          <div className="stage-placeholder">動画が読み込まれていません</div>
        )}

        {loadError && (
          <div className="stage-placeholder">
            {loadError}
            <br />
            <span style={{ opacity: 0.7, fontSize: '0.85em', wordBreak: 'break-all' }}>
              {videoUrl}
            </span>
          </div>
        )}

        <div className="telop-layer">
          {telop && style && (
            <div
              className={`telop-text ${movable ? 'movable' : ''}`}
              style={{
                bottom: `${style.bottomPercent}%`,
                left: `${style.leftPercent ?? 50}%`,
                // 🔴 幅は内容基準にすること。
                //    left だけ指定した絶対配置は「右端までの残り幅」に合わせて
                //    箱が勝手に縮むので、右に動かすほど早く折り返してしまう。
                //    折り返すかどうかは max-width だけで決める。
                width: 'max-content',
                maxWidth: (style.autoWrap ?? true) ? `${wrapWidth}px` : 'none',
                whiteSpace: (style.autoWrap ?? true) ? 'pre-wrap' : 'pre',
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

        {/*
          音量。
          🔴 消音の入り切りを別に置くこと。
             つまみを0にして戻す操作では、元の大きさに戻すのに勘が要る。
             押して切って、押して戻せるようにする。
        */}
        <button
          className="mute"
          onClick={() => setMuted((m) => !m)}
          title={muted ? '音を出す' : '消音にする'}
          aria-pressed={muted}
        >
          {muted || volume === 0 ? '🔇' : volume < 0.5 ? '🔈' : '🔊'}
        </button>
        <input
          className="volume"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={muted ? 0 : volume}
          onChange={(e) => {
            const v = Number(e.target.value)
            setVolume(v)
            // つまみを動かしたら消音は解く（動かしたのに鳴らないと壊れて見える）
            if (v > 0) setMuted(false)
          }}
          title={`音量 ${Math.round((muted ? 0 : volume) * 100)}%`}
          aria-label="音量"
        />
      </div>
    </div>
  )
}
