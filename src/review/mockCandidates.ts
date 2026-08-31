/**
 * カット候補の型と、操作感の確認用のモックデータ。
 *
 * 型（CutCandidate / CutKind / KIND_LABEL）は本番でも使う。
 * generateMockCandidates は `?mode=review-demo` 専用で、本番の経路では呼ばれない。
 */

/**
 * カットの種類。
 * manual は人が範囲を指定して足したもので、AIが出した候補ではない。
 */
export type CutKind = 'silence' | 'filler' | 'restate' | 'aside' | 'manual';

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
  /** クリップ先頭から何秒の位置が繋ぎ目か */
  clipJoinAt?: number;
  clipDuration?: number;
}

/** 確信度による3分割の境目。既定値は sidecar/cut.py の REVIEW_BAND と同じ。 */
export interface ReviewBand {
  low: number;
  high: number;
}

export const DEFAULT_BAND: ReviewBand = { low: 0.6, high: 0.9 };

export const KIND_LABEL: Record<CutKind, string> = {
  silence: '無音',
  filler: 'フィラー',
  restate: '言い直し',
  /**
   * 話の本筋と繋がっていないひとりごと（「あれ、止まってない？」など）。
   * 🔴 意味を読んでいるわけではないので、必ず人が1件ずつ見る側に入る。
   *    sidecar/cut.py の確信度をレビュー帯に収めてある。
   */
  aside: '独り言',
  manual: '手動',
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
