/**
 * テロップの割り直しを検める。
 *
 * 🔴 ここが抜けると「40文字・25秒のテロップが5枚だけ」になる。
 *    読めないし、文節の途中で切れる。実機で
 *    「…しづらさを減 / らすこともあります」と割れた（2026-08-31）。
 *
 * 🔴 実際に出た文で試すこと。作り物の短い文では、
 *    上限に当たらないので何も検めていないのと同じになる。
 */

import { chunkByPhrase, splitTelops, DEFAULT_MAX_CHARS } from '../src/lib/splitTelop.ts'

let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    console.log(`✅ ${label}`)
  } else {
    console.error(`❌ ${label}${detail ? `  → ${detail}` : ''}`)
    failed++
  }
}

/* ------------------------------------------------ 実機で出た文 */

// 友達の素材から実際に出たもの（書き出した fcpxml より）
const 実例 = 'もちろんかゆめの原因はいろいろあるけど毛量を減らすことで群れやケアのしづらさを減らすこともあります'

{
  const chunks = chunkByPhrase(実例, DEFAULT_MAX_CHARS)
  check('長い文が複数枚に割れる', chunks.length >= 2, `${chunks.length} 枚`)
  check(
    '1枚が長くなりすぎない',
    chunks.every((c) => c.length <= DEFAULT_MAX_CHARS + 2),
    chunks.map((c) => `${c}(${c.length})`).join(' / '),
  )
  // 🔴 これが本題。文節の途中で切れていないこと
  check(
    '「減らす」が割れない',
    !chunks.some((c) => c.endsWith('減')) && !chunks.some((c) => c.startsWith('らす')),
    chunks.join(' / '),
  )
  check('つなげると元に戻る', chunks.join('') === 実例, chunks.join(''))
}

/* ------------------------------------------------ 時刻の割り当て */

// 語ごとの時刻。1文字 0.1 秒で並べる
const words = [...実例].map((ch, i) => ({
  text: ch,
  srcStart: Number((i * 0.1).toFixed(3)),
  srcEnd: Number(((i + 1) * 0.1).toFixed(3)),
}))

{
  const src = [
    { id: 't1', start: 0, end: 9.8, text: 実例, style: 'normal', words },
  ]
  const out = splitTelops(src)

  check('割った数だけテロップになる', out.length >= 2, `${out.length} 件`)
  check('最初は元の始まりから', out[0].start === 0, String(out[0].start))
  check('最後は元の終わりまで', out[out.length - 1].end === 9.8, String(out[out.length - 1].end))

  // 🔴 重なると FCP で2枚同時に出る
  const overlapped = out.some((t, i) => i > 0 && out[i - 1].end > t.start)
  check('前後が重ならない', !overlapped, out.map((t) => `${t.start}-${t.end}`).join(' '))

  check('順番が時刻どおり', out.every((t, i) => i === 0 || out[i - 1].start <= t.start))
  check('id が別々になる', new Set(out.map((t) => t.id)).size === out.length)
  check('本文がつながる', out.map((t) => t.text).join('') === 実例)

  // 🔴 割った先の時刻は語の時刻から。長さの按分だと早口の所でずれる
  const 二枚目 = out[1]
  const 期待 = words[out[0].text.length].srcStart
  check('2枚目は語の時刻から始まる', Math.abs(二枚目.start - 期待) < 0.2,
        `${二枚目.start} / 期待 ${期待}`)
}

/* ------------------------------------------------ 割らない場合 */

{
  // 語の時刻が無いものは割らない（出どころの無い時刻をでっち上げない）
  const out = splitTelops([{ id: 't1', start: 0, end: 9, text: 実例, style: 'normal' }])
  check('時刻の裏づけが無ければ割らない', out.length === 1, `${out.length} 件`)
}

{
  const 短い = 'ここは短い'
  const out = splitTelops([{ id: 't1', start: 0, end: 2, text: 短い, style: 'normal', words: [] }])
  check('短い文はそのまま', out.length === 1 && out[0].text === 短い)
}

{
  check('空でも落ちない', splitTelops([]).length === 0)
  check('空文字でも落ちない', chunkByPhrase('', DEFAULT_MAX_CHARS).length >= 0)
}

/* ------------------------------------------------ 半角 */

{
  // 半角は 0.5 文字ぶん。英数字ばかりの文で早々に割れないこと
  const 英数 = 'VIO' .repeat(20)
  const chunks = chunkByPhrase(英数, DEFAULT_MAX_CHARS)
  check('半角は半分に数える', chunks.some((c) => c.length > DEFAULT_MAX_CHARS),
        chunks.map((c) => c.length).join(','))
}

if (failed > 0) {
  console.error(`\n🚫 split-telop: ${failed} 件`)
  process.exit(1)
}
console.log('\n🎉 split-telop: すべて通過')
