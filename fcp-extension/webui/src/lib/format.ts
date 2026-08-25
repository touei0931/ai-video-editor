/** 秒 → 0:12.3 のような表示 */
export function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

/** 秒 → FCP のタイムコード風 00:00:12:07 (30fps 前提の表示用) */
export function fmtTimecode(sec: number, fps = 30): string {
  const total = Math.max(0, Math.round(sec * fps))
  const f = total % fps
  const s = Math.floor(total / fps) % 60
  const m = Math.floor(total / (fps * 60)) % 60
  const h = Math.floor(total / (fps * 3600))
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(h)}:${p(m)}:${p(s)}:${p(f)}`
}
