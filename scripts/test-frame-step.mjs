/**
 * コマの刻みの選び方を検める。
 *
 * 🔴 ここを間違えると「拡大するほどコマがぼやける」になる。
 *    1枚あたりの枠が絵より広いと、絵を引き伸ばして埋めることになり、
 *    寄れば寄るほど何のコマなのか分からなくなる（実機で指摘された）。
 *    エラーは出ないので、見た目でしか気づけない。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { stepFor } = await import(pathToFileURL(join(root, 'src/timeline/frames.ts')).href);

let failed = 0;
const check = (label, ok, detail = '') => {
  if (!ok) {
    console.error(`  NG ${label}${detail ? `\n     ${detail}` : ''}`);
    failed++;
  }
};

/*
  絵の幅は「段の高さ × 縦横比」で決まる。段が 36px、16:9 なら 64px ほど。
  拡大率（1秒あたりの画素数）を変えながら、
  1枚あたりの枠（刻み × 拡大率）が絵の幅を超えないことを見る。
*/
const THUMB = 64;

/** いちばん細かい刻み。これ以上は細かくできない */
const FINEST = stepFor(1e9, THUMB);

for (const scale of [5, 12, 25, 40, 60, 100, 160, 250, 400, 700, 1200, 2400]) {
  const step = stepFor(scale, THUMB);
  const slot = step * scale;

  /*
    🔴 これが要点。枠が絵より広いと引き伸ばしになる。

    ただし、いちばん細かい刻みに当たっているときは別。
    30fps の素材に 1/30 秒より細かいコマは無いので、
    そこまで寄ったら引き伸ばすしかない（同じ絵を並べても意味が無い）。
  */
  if (step > FINEST) {
    check(
      `拡大率 ${scale}: 枠が絵をはみ出さない`,
      slot <= THUMB + 0.001,
      `枠 ${slot.toFixed(1)}px / 絵 ${THUMB}px（刻み ${step}秒）`,
    );

    /*
      🔴 細かすぎても困る。枠が絵の半分より狭いと、
         同じ場所に絵が2枚以上並ぶことになり、取り出しが無駄に増える。
    */
    check(
      `拡大率 ${scale}: 細かくしすぎない`,
      slot >= THUMB / 2,
      `枠 ${slot.toFixed(1)}px / 絵 ${THUMB}px（刻み ${step}秒）`,
    );
  }
}

// 🔴 いちばん細かい刻みは、素材のコマより細かくしないこと
check('いちばん細かい刻みは 1/30 秒', Math.abs(FINEST - 1 / 30) < 1e-6, String(FINEST));

// 縮めるほど刻みは粗くなる（同じか粗い）
let prev = 0;
for (const scale of [2400, 1200, 700, 400, 250, 160, 100, 60, 40, 25, 12, 5]) {
  const step = stepFor(scale, THUMB);
  check(`縮めるほど粗くなる（拡大率 ${scale}）`, step >= prev, `前 ${prev} / 今 ${step}`);
  prev = step;
}

// 極端な値でも数を返すこと（画面が真っ白にならない）
for (const [label, scale, thumb] of [
  ['拡大率0', 0, 64],
  ['絵の幅0', 100, 0],
  ['とても細い絵', 100, 1],
]) {
  const step = stepFor(scale, thumb);
  check(`${label}: 数を返す`, Number.isFinite(step) && step > 0, String(step));
}

/* ================================================ 画面ごとの写し間違い

  🔴 同じ仕組みを画面ごとに書き写さないこと。

     刻みの決め方は、もともと並べる画面と子画面（下ごしらえ）の
     **2か所に同じものが書かれていた**。並べる画面だけ直した結果、
     子画面は拡大するほどコマがぼやけるまま取り残された。
     どちらの画面も同じ体験にするには、決まりを1か所に置くしかない。

     ここでは「コマを出す所は、必ず frames.ts の決まりを使っているか」を見る。
*/
const FILMSTRIPS = ['src/shell/Filmstrip.tsx', 'src/timeline/ClipFilmstrip.tsx'];

for (const rel of FILMSTRIPS) {
  const src = readFileSync(join(root, rel), 'utf8');

  // 自前の刻みの決め方を持っていないこと
  check(
    `${rel}: 刻みを自前で決めていない`,
    !/function\s+stepFor/.test(src),
    'frames.ts の stepFor を使うこと',
  );

  // 決まりは共通のものから取ること
  check(
    `${rel}: 共通の決まりを使っている`,
    /from '(\.\.\/timeline\/frames|\.\/frames)'/.test(src),
    'frames.ts から取り込むこと',
  );

  /*
    自分でコマを描いているなら、取り出す大きさを画面の細かさに合わせること。
    （並べる画面は frames.ts に任せているので、ここは通らない）
  */
  if (/drawImage/.test(src)) {
    check(
      `${rel}: 取り出す大きさを画面に合わせている`,
      /captureScale\(\)/.test(src),
      '等倍で取ると高精細画面でぼやける',
    );
  }

  // 生の devicePixelRatio を各画面で持ち出さないこと（上限の付け忘れが起きる）
  check(
    `${rel}: devicePixelRatio を直接見ていない`,
    !/devicePixelRatio/.test(src),
    'captureScale 越しに使うこと',
  );
}

if (failed > 0) {
  console.error(`\ntest-frame-step: NG ${failed} 件`);
  process.exit(1);
}
console.log('test-frame-step: OK');
