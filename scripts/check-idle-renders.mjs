/**
 * 何もしていないときに画面が回り続けていないかを検める。
 *
 *     node scripts/check-idle-renders.mjs <CDPのポート>
 *
 * 🔴 これは2回踏んだ不具合。
 *
 *    1回目: TelopScreen の useEffect に onEditsChange（毎描画で新しくなる関数）が
 *           入っていて、CPU 107%、自動保存が一度も走らなかった。
 *    2回目: useEditedPlayer の useEffect に cuts（毎描画で新しくなる配列）が
 *           入っていて、**何もしない2秒間に DOM の書き換えが 50,991 回**。
 *           画面は生きて見えるのにボタンが効かず、再生位置も動かない。
 *
 *    どちらも例外は出ない。型検査もテストも通る。目でも気づけない
 *    （「なんとなく重い」で済ませてしまう）。だから機械で測る。
 *
 * 使い方: アプリを --remote-debugging-port=9333 付きで起動し、
 *         編集画面に入れてから走らせる。
 */

const port = process.argv[2] || '9333';
/** 2秒間に許す DOM 書き換え回数。正常時は数十回で収まる */
const LIMIT = Number(process.argv[3] || 400);

const targets = await (await fetch(`http://localhost:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
if (!page) {
  console.error('レンダラが見つかりません。アプリを --remote-debugging-port 付きで起動してください。');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

const expr = `(async () => {
  const root = document.querySelector('.fcp') || document.body;
  let n = 0;
  const mo = new MutationObserver((list) => { n += list.length; });
  mo.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  await new Promise((r) => setTimeout(r, 2000));
  mo.disconnect();
  return JSON.stringify({ mutations: n, screen: document.querySelector('.fcp') ? '編集画面' : 'その他' });
})()`;

const result = await new Promise((resolve, reject) => {
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== 1) return;
    if (msg.result?.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails)));
    else resolve(msg.result.result.value);
  };
  ws.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: expr, awaitPromise: true, returnByValue: true },
    }),
  );
});
ws.close();

const { mutations, screen } = JSON.parse(result);
console.log(`画面: ${screen}`);
console.log(`何もしない2秒間の DOM 書き換え: ${mutations} 回（上限 ${LIMIT}）`);

if (mutations > LIMIT) {
  console.error(`
NG 何もしていないのに画面が回り続けています。

  useEffect / useMemo の依存に、毎描画で作り直される値
  （配列リテラル・オブジェクトリテラル・インラインの関数）が
  入っていないか確認してください。

  症状: ボタンを押しても効かない / 再生位置が動かない / 自動保存が走らない。
       例外は出ないので、測らないと気づけません。`);
  process.exit(1);
}
console.log('OK 画面は落ち着いています');
