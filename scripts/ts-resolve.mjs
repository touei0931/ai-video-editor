/**
 * テストから .ts をそのまま読むための、拡張子の補い係。
 *
 * Node 24 は .ts を実行できる（型を落として走らせる）が、
 * `./project` のように**拡張子を省いた書き方は解決できない**。
 * TypeScript と Vite では省くのが普通なので、そこだけ埋める。
 *
 * 🔴 本体のコードを Node の都合に合わせないこと。
 *    import に .ts を書いて回ると、tsconfig の設定を1つ増やすことになり、
 *    「テストのために本体の書き方を変えた」状態が残る。
 *    合わせるのはテスト側でよい。
 */

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const HOOK = `
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\\.[cm]?[jt]sx?$/.test(specifier)) {
    for (const ext of ['.ts', '.tsx']) {
      try {
        const url = new URL(specifier + ext, context.parentURL);
        if (existsSync(fileURLToPath(url))) {
          return { url: url.href, format: 'module-typescript', shortCircuit: true };
        }
      } catch {
        // 組み立てられない指定はそのまま次へ渡す
      }
    }
  }
  return next(specifier, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(HOOK)}`, pathToFileURL('./'));
