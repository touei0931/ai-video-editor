/**
 * 語の途中で割れているテロップを、つなぎ直せるか。
 *
 * 🔴 エンジンは単語の時刻と文字数でしか区切れない。句読点も間も無いまま
 *    喋り続けると 40文字の保険上限に当たり、そこで機械的に切れる。
 *    実機の書き出しで「…しづらさを減 / らすこともあります」と割れた
 *    （2026-08-31、テスト.fcpxml）。
 *
 * 🔴 「つなげること」より「つなぎ過ぎないこと」を先に確かめる。
 *    切れ目として正しい所までつなぐと、1枚が読み切れない長さになる。
 */

import { joinBrokenTelops, splitTelops, DEFAULT_TELOP_MAX_CHARS } from '../src/lib/splitTelop.ts'

let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    console.log(`✅ ${label}`)
  } else {
    console.error(`❌ ${label}${detail ? `  → ${detail}` : ''}`)
    failed++
  }
}

/** 本文から、1文字ずつの語の時刻を作る */
function withWords(text, start, end) {
  const step = (end - start) / text.length
  return [...text].map((ch, i) => ({
    text: ch,
    srcStart: Number((start + i * step).toFixed(3)),
    srcEnd: Number((start + (i + 1) * step).toFixed(3)),
  }))
}

const telop = (id, text, start, end, style = 'normal') => ({
  id, text, start, end, style, words: withWords(text, start, end),
})

/* ------------------------------------------------ 実機で割れた組 */

{
  // テスト.fcpxml に出たそのまま。40文字の上限にちょうど当たって割れた
  const src = [
    telop('t1', '減らすことで群れやケアのしづらさを減', 27.1, 30.37),
    telop('t2', 'らすこともあります', 30.4, 31.37),
  ]
  const joined = joinBrokenTelops(src, DEFAULT_TELOP_MAX_CHARS)
  check('語の途中で割れていたらつなぐ', joined.length === 1,
        joined.map((t) => t.text).join(' / '))
  check('つないだ本文が元どおり',
        joined[0]?.text === '減らすことで群れやケアのしづらさを減らすこともあります', joined[0]?.text)
  check('時刻は最初と最後をつなぐ',
        joined[0]?.start === 27.1 && joined[0]?.end === 31.37,
        `${joined[0]?.start}-${joined[0]?.end}`)
  check('語の時刻も合わせて持つ',
        (joined[0]?.words?.length ?? 0) === src[0].words.length + src[1].words.length)
}

{
  // つないだあと割り直すと、「減」で切れないこと
  const out = splitTelops([
    telop('t1', '減らすことで群れやケアのしづらさを減', 27.1, 30.37),
    telop('t2', 'らすこともあります', 30.4, 31.37),
  ])
  const texts = out.map((t) => t.text)
  check('割り直しても「減」で切れない',
        !texts.some((t) => t.endsWith('を減')) && !texts.some((t) => t.startsWith('らす')),
        texts.join(' / '))
  check('本文はつながったまま',
        texts.join('') === '減らすことで群れやケアのしづらさを減らすこともあります', texts.join(''))
  check('前後が重ならない',
        !out.some((t, i) => i > 0 && out[i - 1].end > t.start),
        out.map((t) => `${t.start}-${t.end}`).join(' '))
}

/* ------------------------------------------------ つなぎ過ぎない */

{
  // つなぎ目が文節の切れ目なら、そのままにする
  const src = [
    telop('t1', '今日は暑いですね。', 0, 2),
    telop('t2', 'ところで話は変わりますが', 2.05, 4),
  ]
  const joined = joinBrokenTelops(src, DEFAULT_TELOP_MAX_CHARS)
  check('切れ目として正しければつながない', joined.length === 2,
        joined.map((t) => t.text).join(' / '))
}

{
  // 間が空いていれば、別の発言としてつながない
  const src = [
    telop('t1', 'ケアのしづらさを減', 0, 2),
    telop('t2', 'らすこともあります', 2.6, 4),
  ]
  const joined = joinBrokenTelops(src, DEFAULT_TELOP_MAX_CHARS)
  check('間が空いていればつながない（0.6秒）', joined.length === 2,
        joined.map((t) => t.text).join(' / '))
}

{
  // 見た目が違うものはつながない（通常と強調が1枚になると意図が壊れる）
  const a = telop('t1', 'ケアのしづらさを減', 0, 2)
  const b = { ...telop('t2', 'らすこともあります', 2.05, 4), style: 'emphasis' }
  const joined = joinBrokenTelops([a, b], DEFAULT_TELOP_MAX_CHARS)
  check('見た目が違えばつながない', joined.length === 2,
        joined.map((t) => `${t.text}(${t.style})`).join(' / '))
}

{
  /*
    🔴 つなぎ過ぎの歯止め。
       語の時刻が無いものをつなぐと、上限を超えても割り直せず、
       読み切れない長さのテロップが1枚残る。
  */
  const long = 'あ'.repeat(40)
  const src = [
    { id: 't1', text: long, start: 0, end: 2, style: 'normal' },
    { id: 't2', text: long, start: 2.05, end: 4, style: 'normal' },
  ]
  const joined = joinBrokenTelops(src, DEFAULT_TELOP_MAX_CHARS)
  check('割り直せないものは長くしない', joined.length === 2, `${joined.length} 枚`)
}

{
  check('空でも落ちない', joinBrokenTelops([], DEFAULT_TELOP_MAX_CHARS).length === 0)
  check('1枚でも落ちない',
        joinBrokenTelops([telop('t1', 'ひとつだけ', 0, 1)], DEFAULT_TELOP_MAX_CHARS).length === 1)
}

/* ------------------------------------------------ 実機の並びを通す */

{
  // テスト.fcpxml の順番そのまま（時刻も実物）
  const 実データ = [
    ['夏になると金玉か', 11.57, 13.47],
    ['ゆくなりません', 13.47, 14.24],
    ['汗かいて群れてかゆいの', 14.77, 17.03],
    ['エンドレス一旦良くなっても', 17.03, 19.43],
    ['毛が多いと汗や湿気が', 19.43, 22.17],
    ['こもりやすい', 22.17, 23.23],
    ['もちろんかゆめの原因は', 23.63, 24.77],
    ['いろいろあるけど毛量を', 24.77, 27.1],
    ['減らすことで群れやケアの', 27.1, 29.3],
    ['しづらさを減', 29.3, 30.37],
    ['らすこともあります', 30.4, 31.37],
  ].map(([t, a, b], i) => telop(`t${i}`, t, a, b))

  const out = splitTelops(実データ)
  const texts = out.map((t) => t.text)

  check('本文は全部残る',
        texts.join('') === 実データ.map((t) => t.text).join(''), texts.join(''))
  check('「減」で終わる枚が無くなる',
        !texts.some((t) => t.endsWith('を減')), texts.join(' / '))
  check('枚数が増えていない', out.length <= 実データ.length,
        `${out.length} 枚（元 ${実データ.length} 枚）`)
  check('時刻が前後しない',
        out.every((t, i) => i === 0 || out[i - 1].start <= t.start))
  console.log('   →', texts.join(' / '))
}

/* ------------------------------------------------ 実機の設定で通す

  🔴 既定の 26文字だけで確かめないこと。
     友達は「1枚 13文字」で使っていた。つなぎ上限を 1枚ぶんの倍数に
     していたため、13文字だと上限 32文字となり、エンジンが 40文字で
     切った組が**ちょうど弾かれて**つなぎ直しが働かなかった
     （2026-08-31、PAC (2).fcpxml でそのまま残っていた）。
*/

{
  // エンジンが 40文字ちょうどで切った、そのままの組
  const A = 'もちろんかゆめの原因はいろいろあるけど毛量を減らすことで群れやケアのしづらさを減'
  const B = 'らすこともあります'
  const src = [telop('t1', A, 23.63, 30.37), telop('t2', B, 30.4, 31.37)]

  for (const maxChars of [13, 20, 26]) {
    const out = splitTelops(src, maxChars)
    const texts = out.map((t) => t.text)
    check(`1枚 ${maxChars}文字でも「減」で切れない`,
          !texts.some((t) => t.endsWith('を減')) && !texts.some((t) => t.startsWith('らす')),
          texts.join(' / '))
    check(`1枚 ${maxChars}文字でも本文が残る`, texts.join('') === A + B)
    check(`1枚 ${maxChars}文字で1枚が長くなりすぎない`,
          texts.every((t) => t.length <= maxChars + 2),
          texts.map((t) => `${t}(${t.length})`).join(' / '))
  }
  console.log('   1枚13文字 →', splitTelops(src, 13).map((t) => t.text).join(' / '))
}

if (failed > 0) {
  console.error(`\n🚫 join-telop: ${failed} 件`)
  process.exit(1)
}
console.log('\n🎉 join-telop: すべて通過')
