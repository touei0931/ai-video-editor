// コマの刻みの決め方だけを切り出したもの。
//
// 🔴 画面の部品（.tsx）に置かないこと。JSX があると検査から読めず、
//    「見て確かめる」以外に検める手が無くなる。

/**
 * その拡大率で何秒ごとにコマを置くか。
 * 半端な刻みだと拡大のたびに作り直しになるので、決まった段階に丸める。
 *
 * 🔴 「必要な幅**以下**」でいちばん大きい刻みを選ぶこと。
 *    「以上」で選ぶと、コマとコマの間が絵1枚ぶん近く空いて飛び飛びに見える。
 *    以下で選べば隙間なく並び、はみ出す分は次の絵が上に重なるだけで済む。
 *    PAC 本体でも同じ間違いをして直した（src/timeline/frames.ts）。
 *
 * 🔴 素材のコマ数より細かくしないこと。同じ絵が並ぶだけで、
 *    取り出しの手間だけが増える。
 */
export function stepFor(scale: number, thumbWidth: number, fps = 30): number {
  const sec = thumbWidth / scale
  const finest = 1 / Math.max(1, fps)
  const steps = [
    finest, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300,
  ].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b)

  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i] <= sec) return steps[i]
  }
  return steps[0]
}
