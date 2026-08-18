/**
 * T2: BudouX による文節改行の検証（Phase 0 §16）。
 *
 * 成功条件:
 *   - 文節途中で切れる率 ≤ 10%
 *   - ライセンスが Apache-2.0 か MIT（budoux 0.9.0 は Apache-2.0 で確認済み）
 *
 * 参考画像のテロップ「お前顔映ってもいいな」が
 * 文節の途中（…もい / いな）で切れていたのを直せるかが出発点。
 */
import { useEffect, useRef, useState } from 'react';
import { fitJapanese, wrapJapanese, wrapJapaneseByWidth } from '../telop/wrap';
import { DEFAULT_STYLES } from '../telop/style';

/** ショート動画の話し言葉を想定したコーパス */
const CORPUS = [
  'お前顔映ってもいいな',
  '今日はこのバイクのカスタムを紹介していきます',
  'まずはここのボルトを外していくんですけど',
  'これがめちゃくちゃ固くて全然回らないんですよ',
  'で、ここでインパクトレンチの出番です',
  'はい、一瞬で外れました',
  'ちょっと待って、これヤバくないですか',
  '正直これは想像以上でした',
  'この工具、二千円くらいで買えるので超おすすめです',
  'あー、やってしまった',
  'ネジ山なめちゃったんで、これはもう詰みですね',
  '皆さんは同じ失敗しないように気をつけてください',
  'ということで今回はここまでです',
  'チャンネル登録よろしくお願いします',
  'このパーツはメルカリで五千円で買いました',
  '結論から言うと、買って正解でした',
  'エンジンかけてみますね',
  'いい音してるでしょ',
  '実はちょっと不安だったんですけど',
  '思ったより静かで驚きました',
  'ここのクリアランスがギリギリなんですよ',
  '一ミリでもズレると入りません',
  'そういうときはヒートガンで温めます',
  '無理やり押し込むと割れるので注意です',
  'はい、きれいに収まりました',
  '見た目もかなり良くなったと思います',
  '次回はマフラーを交換していきます',
  'コメントで質問もらえれば答えます',
  'それでは、また次の動画で',
  'お疲れ様でした',
];

const MAX_CHARS = 9;

export function T2Budoux() {
  const [log, setLog] = useState<string[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    (async () => {
      try {
        // 実測幅での折り返しも試すため、本番と同じフォントを載せる
        const face = new FontFace('ZenKakuGothicNew', 'url(./fonts/ZenKakuGothicNew-Black.ttf)');
        await face.load();
        document.fonts.add(face);
        await document.fonts.ready;

        const canvas = canvasRef.current!;
        const ctx = canvas.getContext('2d')!;
        const style = DEFAULT_STYLES.normal;
        const frameWidth = 1080;
        const fontSize = Math.round(frameWidth * style.fontSizeRatio);
        ctx.font = `${fontSize}px "${style.fontFamily}"`;
        const measure = (t: string) => ctx.measureText(t).width;
        const maxWidth = frameWidth * (1 - 0.08 * 2);

        // 縮小あり（本番で使う経路）はサイズを変えて測り直す必要がある
        const measureAt = (t: string, scale: number) => {
          ctx.font = `${Math.round(fontSize * scale)}px "${style.fontFamily}"`;
          const w = ctx.measureText(t).width;
          ctx.font = `${fontSize}px "${style.fontFamily}"`;
          return w;
        };

        const cases = CORPUS.map((text) => {
          const byChars = wrapJapanese(text, MAX_CHARS);
          const byWidth = wrapJapaneseByWidth(measure, text, maxWidth);
          const fitted = fitJapanese(measureAt, text, maxWidth);
          return {
            text,
            phrases: byChars.phrases,
            byChars: {
              lines: byChars.lines,
              forcedBreaks: byChars.forcedBreaks,
              totalBreaks: byChars.totalBreaks,
            },
            byWidth: {
              lines: byWidth.lines,
              forcedBreaks: byWidth.forcedBreaks,
              totalBreaks: byWidth.totalBreaks,
            },
            fitted: {
              lines: fitted.lines,
              forcedBreaks: fitted.forcedBreaks,
              totalBreaks: fitted.totalBreaks,
              fontScale: fitted.fontScale,
            },
          };
        });

        const sum = (f: (c: (typeof cases)[number]) => number) => cases.reduce((s, c) => s + f(c), 0);
        const ratio = (forced: number, total: number) => (total === 0 ? 0 : forced / total);

        const naive = {
          totalBreaks: sum((c) => c.byChars.totalBreaks),
          forcedBreaks: sum((c) => c.byChars.forcedBreaks),
        };
        const fitted = {
          totalBreaks: sum((c) => c.fitted.totalBreaks),
          forcedBreaks: sum((c) => c.fitted.forcedBreaks),
          shrunk: cases.filter((c) => c.fitted.fontScale < 1).length,
          minScale: Math.min(...cases.map((c) => c.fitted.fontScale)),
        };

        const forcedRatio = ratio(fitted.forcedBreaks, fitted.totalBreaks);

        setLog([
          `文数: ${cases.length}`,
          `縮小なし: ${naive.forcedBreaks}/${naive.totalBreaks} = ${(ratio(naive.forcedBreaks, naive.totalBreaks) * 100).toFixed(1)}%`,
          `縮小あり: ${fitted.forcedBreaks}/${fitted.totalBreaks} = ${(forcedRatio * 100).toFixed(1)}%`,
          `縮小された文: ${fitted.shrunk} 件（最小 ${fitted.minScale} 倍）`,
          `参考文: ${JSON.stringify(cases[0].fitted.lines)}`,
        ]);

        await window.t2.submit({
          maxChars: MAX_CHARS,
          naive,
          fitted,
          totalBreaks: fitted.totalBreaks,
          forcedBreaks: fitted.forcedBreaks,
          forcedRatio: Number(forcedRatio.toFixed(4)),
          cases,
        });
      } catch (e) {
        setLog([`エラー: ${(e as Error).message}`]);
        await window.t2.submit({ error: (e as Error).message });
      }
    })();
  }, []);

  return (
    <main>
      <h1>T2: BudouX 文節改行の検証</h1>
      <pre>{log.join('\n')}</pre>
      <canvas ref={canvasRef} width={100} height={40} style={{ display: 'none' }} />
    </main>
  );
}
