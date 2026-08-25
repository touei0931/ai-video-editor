// 開発用のダミーデータ。Mac が無くても Windows のブラウザで UI を確認するために使う。
import type { ProjectState } from './types'

function makeWaveform(n: number): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const t = i / n
    // 喋り→無音→喋り、が分かる形にしておく
    const speech = Math.abs(Math.sin(t * 40)) * (0.4 + 0.6 * Math.abs(Math.sin(t * 6)))
    const gap = t > 0.28 && t < 0.34 ? 0.02 : 1
    const gap2 = t > 0.62 && t < 0.66 ? 0.02 : 1
    out.push(Math.min(1, speech * gap * gap2))
  }
  return out
}

export const MOCK: ProjectState = {
  videoUrl: null,
  durationSec: 62,
  waveform: makeWaveform(600),
  cuts: [
    { id: 'c1', start: 3.2, end: 4.9, kind: 'silence', text: '', confidence: 0.96, decision: 'pending' },
    { id: 'c2', start: 8.4, end: 8.9, kind: 'filler', text: 'えー', confidence: 0.88, decision: 'pending' },
    { id: 'c3', start: 14.1, end: 16.3, kind: 'restate', text: 'これは、これはですね', confidence: 0.71, decision: 'pending' },
    { id: 'c4', start: 21.0, end: 23.4, kind: 'silence', text: '', confidence: 0.93, decision: 'pending' },
    { id: 'c5', start: 30.6, end: 31.1, kind: 'filler', text: 'あのー', confidence: 0.84, decision: 'pending' },
    { id: 'c6', start: 38.9, end: 41.2, kind: 'silence', text: '', confidence: 0.9, decision: 'pending' },
    { id: 'c7', start: 47.3, end: 48.0, kind: 'filler', text: 'まあ', confidence: 0.66, decision: 'pending' },
    { id: 'c8', start: 53.2, end: 55.6, kind: 'restate', text: 'つまり、つまり何が言いたいかというと', confidence: 0.79, decision: 'pending' },
  ],
  telops: [
    { id: 't1', start: 1.0, end: 4.0, text: '今日は自動カットの話をします', style: 'normal' },
    { id: 't2', start: 5.2, end: 8.2, text: 'ここが一番大事', style: 'emphasis' },
    { id: 't3', start: 9.5, end: 13.0, text: '編集時間が30分から3分になりました', style: 'normal' },
    { id: 't4', start: 17.0, end: 20.5, text: '無音とフィラーを自動で見つけます', style: 'normal' },
    { id: 't5', start: 24.0, end: 27.5, text: '言い直しも検出できる', style: 'emphasis' },
    { id: 't6', start: 32.0, end: 36.0, text: 'あとは承認していくだけ', style: 'normal' },
    { id: 't7', start: 42.0, end: 46.0, text: 'テロップも同時に作ります', style: 'normal' },
    { id: 't8', start: 49.0, end: 52.5, text: 'スタイルは2種類から選べます', style: 'normal' },
    { id: 't9', start: 56.0, end: 60.0, text: 'ぜひ使ってみてください', style: 'emphasis' },
  ],
  styles: {
    normal: {
      fontFamily: 'ヒラギノ角ゴシック W6',
      fontSize: 48,
      color: '#ffffff',
      strokeColor: '#000000',
      strokeWidth: 6,
      shadow: true,
      bold: false,
      bottomPercent: 12,
      leftPercent: 50,
    },
    emphasis: {
      fontFamily: 'ヒラギノ角ゴシック W8',
      fontSize: 60,
      color: '#ffe14d',
      strokeColor: '#000000',
      strokeWidth: 8,
      shadow: true,
      bold: true,
      bottomPercent: 12,
      leftPercent: 50,
    },
  },
  fonts: [
    'ヒラギノ角ゴシック W3',
    'ヒラギノ角ゴシック W6',
    'ヒラギノ角ゴシック W8',
    'ヒラギノ丸ゴ ProN W4',
    'ヒラギノ明朝 ProN W6',
    'Noto Sans JP',
    'Osaka',
    'Helvetica Neue',
    'Avenir Next',
  ],
}
