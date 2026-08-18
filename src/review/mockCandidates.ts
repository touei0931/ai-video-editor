/**
 * カット候補のモックデータ（操作感の確認用）。
 *
 * 解析パイプラインはまだ繋がっていないので、20分素材を想定した
 * それらしい分布を手で作ってある。実装が進んだら analysis.json に置き換える。
 */

export type CutKind = 'silence' | 'filler' | 'restate';

export interface CutCandidate {
  id: string;
  kind: CutKind;
  /** 元素材上の秒数 */
  srcStart: number;
  srcEnd: number;
  confidence: number;
  /** 前後の文脈（レビュー時に表示する） */
  before: string;
  after: string;
  /** フィラーや言い直しの場合、その語 */
  word?: string;
  /**
   * レビュー用の短尺クリップ。「切って繋いだ結果」が入っている。
   * これをループ再生して「繋ぎが自然か」を判断する（§3.3.3）。
   */
  clipPath?: string | null;
}

export const KIND_LABEL: Record<CutKind, string> = {
  silence: '無音',
  filler: 'フィラー',
  restate: '言い直し',
};

const FILLERS = ['えー', 'あの', 'えーと', 'まぁ', 'そのー', 'なんか'];

const CONTEXTS: [string, string][] = [
  ['今日はこのバイクのカスタムを', '紹介していきます'],
  ['まずはここのボルトを', '外していくんですけど'],
  ['これがめちゃくちゃ固くて', '全然回らないんですよ'],
  ['そういうときは', 'インパクトレンチを使います'],
  ['はい、一瞬で', '外れました'],
  ['この工具、二千円くらいで', '買えるのでおすすめです'],
  ['ネジ山なめちゃったんで', 'これはもう詰みですね'],
  ['皆さんは同じ失敗しないように', '気をつけてください'],
  ['エンジンかけてみますね', 'いい音してるでしょ'],
  ['ここのクリアランスが', 'ギリギリなんですよ'],
  ['一ミリでもズレると', '入りません'],
  ['無理やり押し込むと', '割れるので注意です'],
  ['見た目もかなり', '良くなったと思います'],
  ['次回はマフラーを', '交換していきます'],
];

/** 決定論的な擬似乱数（同じ画面を再現できるように） */
function makeRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

export function generateMockCandidates(count = 118): CutCandidate[] {
  const rand = makeRandom(20260818);
  const out: CutCandidate[] = [];
  let t = 3;

  for (let i = 0; i < count; i++) {
    const r = rand();
    // 実際の分布に近づける: 無音が多く、フィラーが次、言い直しは少なめ
    const kind: CutKind = r < 0.52 ? 'silence' : r < 0.87 ? 'filler' : 'restate';

    // 確信度は種別で偏らせる（無音は判定しやすく、言い直しは難しい）
    const base = kind === 'silence' ? 0.72 : kind === 'filler' ? 0.68 : 0.45;
    const confidence = Math.min(0.99, Math.max(0.3, base + rand() * 0.35));

    const duration =
      kind === 'silence' ? 0.35 + rand() * 1.6 : kind === 'filler' ? 0.25 + rand() * 0.4 : 0.5 + rand() * 1.1;

    const [before, after] = CONTEXTS[Math.floor(rand() * CONTEXTS.length)];

    out.push({
      id: `c${String(i).padStart(4, '0')}`,
      kind,
      srcStart: Number(t.toFixed(2)),
      srcEnd: Number((t + duration).toFixed(2)),
      confidence: Number(confidence.toFixed(2)),
      before,
      after,
      word: kind === 'filler' ? FILLERS[Math.floor(rand() * FILLERS.length)] : undefined,
    });

    t += duration + 4 + rand() * 8;
  }

  return out;
}
