/**
 * 素材の URL 作りを検める。
 *
 * 🔴 ここを間違えると「今まで開けていた動画が開けない」になる。
 *    <video> は読み込みに失敗しても例外を投げないので、
 *    型検査もテストも通ったまま、絵が出ないだけの状態になる。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { assetUrl } = await import(pathToFileURL(join(root, 'src/timeline/assetUrl.ts')).href);

let failed = 0;
const eq = (label, got, want) => {
  if (got !== want) {
    console.error(`  NG ${label}\n     期待: ${want}\n     実際: ${got}`);
    failed++;
  }
};

/*
  🔴 Windows の絶対パスを URL と見なさないこと。
     `C:\…` は「英字 + コロン」なので、素朴に判定すると URL に見える。
     そのまま <video> に渡すと読み込めず、
     「この素材ではコマを出せません」になる（実際に出した）。
*/
eq(
  'Windows のパスは包む',
  assetUrl('C:\\Users\\touei\\Movies\\a.mp4'),
  'media://local/C%3A%2FUsers%2Ftouei%2FMovies%2Fa.mp4',
);
eq(
  'スラッシュの Windows パスも包む',
  assetUrl('C:/Users/touei/a.mp4'),
  'media://local/C%3A%2FUsers%2Ftouei%2Fa.mp4',
);
eq('mac のパスは包む', assetUrl('/Users/friend/Movies/a.mp4'), 'media://local/%2FUsers%2Ffriend%2FMovies%2Fa.mp4');

// すでに URL のものは触らない
eq('http はそのまま', assetUrl('http://localhost:5174/a.mp4'), 'http://localhost:5174/a.mp4');
eq('https はそのまま', assetUrl('https://x/a.mp4'), 'https://x/a.mp4');
eq('blob はそのまま', assetUrl('blob:http://x/1-2-3'), 'blob:http://x/1-2-3');
eq('media はそのまま', assetUrl('media://local/x'), 'media://local/x');
eq('file はそのまま', assetUrl('file:///Users/a.mp4'), 'file:///Users/a.mp4');

// 大文字小文字は問わない
eq('大文字の HTTP もそのまま', assetUrl('HTTP://x/a.mp4'), 'HTTP://x/a.mp4');

if (failed > 0) {
  console.error(`\ntest-asset-url: NG ${failed} 件`);
  process.exit(1);
}
console.log('test-asset-url: OK');
