/**
 * テロップの区切りが、話し手の区切りに合うか。
 *
 * 🔴 文字数だけで割ると、喋りと関係ない所で切れる。
 *    実際に言われた例（2026-09-02）:
 *      欲しい: 「俺はサイヤ人になりたいんだけど」「やっぱり自信がなくて」
 *      出た  : 「俺はサイヤ人になり」「たいんだけどやっぱり自信がなくて」
 *    誤字が少なくても、直すのに手間がかかる。
 *
 * 🔴 「割れること」より「話し手が区切った所で割れること」を先に確かめる。
 */

import { splitTelops } from '../src/lib/splitTelop.ts'

let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    console.log(`✅ ${label}`)
  } else {
    console.error(`❌ ${label}${detail ? `  → ${detail}` : ''}`)
    failed++
  }
}

/**
 * 喋りを組み立てる。[本文, その後の間] の並びから、語ごとの時刻を作る。
 * 1文字 0.12 秒で喋る想定。
 */
function speech(parts, start = 0) {
  const words = []
  let at = start
  for (const [text, pause] of parts) {
    for (const ch of text) {
      words.push({
        text: ch,
        srcStart: Number(at.toFixed(3)),
        srcEnd: Number((at + 0.12).toFixed(3)),
      })
      at += 0.12
    }
    at += pause
  }
  const body = parts.map(([t]) => t).join('')
  return {
    id: 't1',
    text: body,
    start,
    end: Number(at.toFixed(3)),
    style: 'normal',
    words,
  }
}

/* ------------------------------------------------ 言われた例そのまま */

{
  // 「俺はサイヤ人になりたいんだけど」で 0.35秒 息を継いで「やっぱり自信がなくて」
  const t = speech([
    ['俺はサイヤ人になりたいんだけど', 0.35],
    ['やっぱり自信がなくて', 0],
  ])

  for (const maxChars of [13, 20, 26]) {
    const texts = splitTelops([t], maxChars).map((x) => x.text)
    check(`1枚 ${maxChars}文字：息継ぎで割れる`,
          texts[0] === '俺はサイヤ人になりたいんだけど' || texts.includes('やっぱり自信がなくて'),
          texts.join(' / '))
    // 🔴 これが本題。語の途中で切らない
    check(`1枚 ${maxChars}文字：「なり」で切らない`,
          !texts.some((x) => x.endsWith('になり')) && !texts.some((x) => x.startsWith('たい')),
          texts.join(' / '))
    check(`1枚 ${maxChars}文字：本文は残る`, texts.join('') === t.text, texts.join(''))
  }
  console.log('   1枚13文字 →', splitTelops([t], 13).map((x) => x.text).join(' / '))
}

/* ------------------------------------------------ 間があれば短くても割る */

{
  // 短いが、間ではっきり分かれている2つ
  const t = speech([['はいどうも', 0.5], ['よろしくお願いします', 0]])
  const texts = splitTelops([t], 26).map((x) => x.text)
  check('上限に収まっていても、話し手の区切りでは割る', texts.length === 2, texts.join(' / '))
  check('割った中身が正しい',
        texts[0] === 'はいどうも' && texts[1] === 'よろしくお願いします', texts.join(' / '))
}

/* ------------------------------------------------ 間が無ければ割らない */

{
  // 息継ぎ無しで一気に喋った短い文は、1枚のまま
  const t = speech([['今日はいい天気ですね', 0]])
  const texts = splitTelops([t], 26).map((x) => x.text)
  check('間が無く短ければ1枚のまま', texts.length === 1, texts.join(' / '))
}

{
  /*
    🔴 間が無いのに長い場合だけ、文節の切れ目に頼る。
       ここでも語の途中で切らないこと。
  */
  const t = speech([['もちろんかゆみの原因はいろいろあるけど毛量を減らすことで群れやケアのしづらさを減らせます', 0]])
  const texts = splitTelops([t], 13).map((x) => x.text)
  check('間が無く長いときは文節で割る', texts.length > 1, `${texts.length} 枚`)
  check('文節の途中で切らない',
        !texts.some((x) => x.endsWith('を減')) && !texts.some((x) => x.startsWith('らせ')),
        texts.join(' / '))
  check('本文は残る', texts.join('') === t.text)
}

/* ------------------------------------------------ 小さい間で割りすぎない */

{
  // 0.15秒程度の細かい間は、話し手の区切りとはみなさない
  const t = speech([['えっと', 0.15], ['そうですね', 0.15], ['はい', 0]])
  const texts = splitTelops([t], 26).map((x) => x.text)
  check('細かい間では割らない', texts.length === 1, texts.join(' / '))
}

/* ------------------------------------------------ 時刻 */

{
  const t = speech([['ここまでが前半', 0.4], ['ここからが後半', 0]])
  const out = splitTelops([t], 26)
  check('2枚になる', out.length === 2, `${out.length} 枚`)
  check('前後が重ならない', out[0].end <= out[1].start,
        `${out[0].end} / ${out[1].start}`)
  // 🔴 2枚目は、実際に喋り始めた時刻から
  const 話し始め = t.words[7].srcStart
  check('2枚目は喋り始めから', Math.abs(out[1].start - 話し始め) < 0.05,
        `${out[1].start} / 期待 ${話し始め}`)
  check('最初は元の始まりから', out[0].start === t.start)
  check('最後は元の終わりまで', out[out.length - 1].end === t.end)
}

/* ------------------------------------------------ 壊れた入力 */

{
  check('語の時刻が無くても落ちない',
        splitTelops([{ id: 'x', text: 'あいうえお', start: 0, end: 1, style: 'normal' }], 26).length === 1)
  check('空でも落ちない', splitTelops([], 26).length === 0)
}

if (failed > 0) {
  console.error(`\n🚫 pause-split: ${failed} 件`)
  process.exit(1)
}
console.log('\n🎉 pause-split: すべて通過')
