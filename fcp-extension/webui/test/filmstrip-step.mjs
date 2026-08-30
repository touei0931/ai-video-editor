/**
 * コマの刻みの選び方を検める。
 *
 * 🔴 「必要な幅**以上**」で選ぶと、コマとコマの間が絵1枚ぶん近く空き、
 *    飛び飛びに見える。PAC 本体でも同じ間違いをして直した。
 * 🔴 素材のコマ数より細かくしても、同じ絵が並ぶだけで手間が増える。
 */

import { stepFor } from '../src/lib/filmstripStep.ts'

let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) console.log(`✅ ${label}`)
  else {
    console.error(`❌ ${label}${detail ? `  → ${detail}` : ''}`)
    failed++
  }
}

const THUMB = 71 // 高さ40の 16:9

for (const scale of [5, 20, 60, 150, 400, 1200, 4000]) {
  const step = stepFor(scale, THUMB, 30)
  const slot = step * scale
  // 🔴 枠が絵より広いと隙間が空く（飛び飛びに見える）
  if (step > 1 / 30) {
    check(`拡大率 ${scale}: 隙間が空かない`, slot <= THUMB + 0.001,
          `枠 ${slot.toFixed(1)}px / 絵 ${THUMB}px`)
  }
  check(`拡大率 ${scale}: 数を返す`, Number.isFinite(step) && step > 0, String(step))
}

// 素材のコマ数より細かくしない
check('30fps ならいちばん細かくて 1/30 秒',
      Math.abs(stepFor(1e9, THUMB, 30) - 1 / 30) < 1e-9, String(stepFor(1e9, THUMB, 30)))
check('60fps ならいちばん細かくて 1/60 秒',
      Math.abs(stepFor(1e9, THUMB, 60) - 1 / 60) < 1e-9, String(stepFor(1e9, THUMB, 60)))

// 縮めるほど粗くなる
let prev = 0
for (const scale of [4000, 1200, 400, 150, 60, 20, 5]) {
  const step = stepFor(scale, THUMB, 30)
  check(`縮めるほど粗くなる（${scale}）`, step >= prev, `前 ${prev} / 今 ${step}`)
  prev = step
}

// 極端な値でも壊れない
for (const [label, scale, thumb, fps] of [
  ['拡大率0', 0, THUMB, 30],
  ['絵の幅0', 100, 0, 30],
  ['fps0', 100, THUMB, 0],
]) {
  const step = stepFor(scale, thumb, fps)
  check(`${label}: 数を返す`, Number.isFinite(step) && step > 0, String(step))
}

if (failed > 0) {
  console.error(`\n🚫 filmstrip-step: ${failed} 件`)
  process.exit(1)
}
console.log('\n🎉 filmstrip-step: すべて通過')
