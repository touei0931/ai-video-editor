/**
 * 話者（喋っている人）ごとの色の書き込み。
 *
 * 🔴 ここで守りたいこと:
 *    - 色は「1枚ごとの上書き」に入り、スタイル（通常/強調）は触られない
 *      （強調の見た目のまま、その人の色で出るようにするため。2026-09-11）
 *    - 人が決めたもの（manualSpeaker）は、見分け直しても動かない
 *    - 当たらなかったものに色を付けない。前回自動で付けた色は外す
 *      （間違った色が付くのは、色が付かないより悪い）
 *    - 色を変えたら、その人のテロップが塗り直される
 *
 * 実行: node --experimental-strip-types test/speakers.mjs
 */

import {
  applyIdentification,
  assignSpeaker,
  countsBySpeaker,
  nextColor,
  recolor,
  unitsOf,
  visibleVoices,
  withoutSpeakerColor,
  withSpeakerColor,
} from '../src/lib/speakers.ts'

let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    console.log(`✅ ${label}`)
  } else {
    console.error(`❌ ${label}${detail ? `  → ${detail}` : ''}`)
    failed++
  }
}

const フブキ = { id: 'spk1', name: 'フブキ', color: '#7ec8ff', samples: 4 }
const おかゆ = { id: 'spk2', name: 'おかゆ', color: '#c59bff', samples: 3 }

const telop = (id, extra = {}) => ({
  id,
  start: 0,
  end: 2,
  text: 'あいうえお',
  style: 'normal',
  ...extra,
})

/* ── 色の付け外し ───────────────────────────────── */
{
  const out = withSpeakerColor({ fontSize: 120 }, フブキ)
  check('色を足しても他の上書きは残る', out.fontSize === 120 && out.color === '#7ec8ff', JSON.stringify(out))

  const stroked = withSpeakerColor({}, { ...フブキ, strokeColor: '#102030' })
  check('縁取りの色は登録があれば写す', stroked.strokeColor === '#102030')
  check('登録に無ければ縁取りは触らない', withSpeakerColor({ strokeColor: '#ffffff' }, フブキ).strokeColor === undefined)

  const rest = withoutSpeakerColor({ fontSize: 120, color: '#7ec8ff' })
  check('色を外しても大きさは残る', rest.fontSize === 120 && rest.color === undefined, JSON.stringify(rest))
  check('色だけだった上書きは消える', withoutSpeakerColor({ color: '#7ec8ff' }) === undefined)
}

/* ── 見分けた結果の書き込み ───────────────────────── */
{
  const cards = [
    telop('t1', { style: 'emphasis' }),
    telop('t2'),
    telop('t3', { speaker: 'spk1', overrides: { color: '#7ec8ff' } }),
  ]
  const result = {
    units: [
      { id: 't1', speaker: 'spk1', score: 0.7, voice: null },
      { id: 't2', speaker: null, score: 0.3, voice: 'v1' },
      { id: 't3', speaker: null, score: 0.2, voice: 'v2' },
    ],
    voices: [],
    speakers: [フブキ],
    matched: 1,
    unknown: 2,
    tooShort: 0,
  }
  const out = applyIdentification(cards, result, [フブキ])

  check('当たった人の色が上書きに入る', out[0].overrides?.color === '#7ec8ff', JSON.stringify(out[0]))
  check('🔴 スタイルは触らない（強調のまま、その人の色）', out[0].style === 'emphasis')
  check('当たらなかったものに色は付かない', out[1].overrides === undefined, JSON.stringify(out[1]))
  check('当たらなかったものは「声n」が付く', out[1].voice === 'v1')
  check('🔴 前回自動で付いた色は外れる', out[2].overrides === undefined && out[2].speaker === null, JSON.stringify(out[2]))
}

/* ── 人が決めたものは動かさない ─────────────────────── */
{
  const cards = [telop('t1', { speaker: 'spk2', manualSpeaker: true, overrides: { color: '#c59bff' } })]
  const result = {
    units: [{ id: 't1', speaker: 'spk1', score: 0.9, voice: null }],
    voices: [],
    speakers: [フブキ, おかゆ],
    matched: 1,
    unknown: 0,
    tooShort: 0,
  }
  const out = applyIdentification(cards, result, [フブキ, おかゆ])
  check(
    '🔴 人が決めた話者は、見分け直しても上書きされない',
    out[0].speaker === 'spk2' && out[0].overrides?.color === '#c59bff',
    JSON.stringify(out[0]),
  )
}

/* ── 手で付ける・外す ───────────────────────────── */
{
  const cards = [telop('t1'), telop('t2')]
  const assigned = assignSpeaker(cards, ['t2'], おかゆ)
  check('選んだ1枚だけ色が付く', assigned[1].overrides?.color === '#c59bff' && assigned[0].overrides === undefined)
  check('人が決めた印が立つ', assigned[1].manualSpeaker === true)

  const cleared = assignSpeaker(assigned, ['t2'], null)
  check('「指定しない」に戻すと色が外れる', cleared[1].speaker === null && cleared[1].overrides === undefined)
}

/* ── 色を変える・登録を消す ─────────────────────── */
{
  const cards = [telop('t1', { speaker: 'spk1', overrides: { color: '#7ec8ff', fontSize: 100 } })]
  const 塗り直し = recolor(cards, [{ ...フブキ, color: '#ff0000' }])
  check('色を変えると塗り直される', 塗り直し[0].overrides?.color === '#ff0000')
  check('大きさの上書きは残る', 塗り直し[0].overrides?.fontSize === 100)

  const 消した = recolor(cards, [])
  check('登録を消すと色が外れ、自動の判定に戻る',
    消した[0].speaker === null && 消した[0].overrides?.color === undefined, JSON.stringify(消した[0]))

  check('変わらなければ同じ配列を返す', recolor(cards, [フブキ]) === cards)
}

/* ── 画面に出すもの ───────────────────────────── */
{
  const voices = [
    { id: 'v1', count: 5, seconds: 9, sample: null, unitIds: [] },
    { id: 'v2', count: 1, seconds: 2.0, sample: null, unitIds: [] },
    { id: 'v3', count: 1, seconds: 0.8, sample: null, unitIds: [] },
  ]
  const { shown, others } = visibleVoices(voices)
  check('1枚でも長ければ並べる', shown.map((v) => v.id).join(',') === 'v1,v2', shown.map((v) => v.id).join(','))
  check('短い1枚は「その他」に寄せる', others === 1)

  const counts = countsBySpeaker([telop('a', { speaker: 'spk1' }), telop('b', { speaker: 'spk1' }), telop('c')])
  check('人ごとの枚数が数えられる', counts.spk1 === 2 && counts.spk2 === undefined)

  check('使っていない色を選ぶ', nextColor([フブキ]) !== '#7ec8ff')

  const units = unitsOf([{ ...telop('t1'), start: 1.5, end: 3.25 }])
  check('見分けに渡す区間は素材の時刻', units[0].src_start === 1.5 && units[0].src_end === 3.25)
}

console.log()
if (failed === 0) {
  console.log('🎉 speakers: すべて通過')
} else {
  console.error(`💥 speakers: ${failed} 件失敗`)
  process.exit(1)
}
