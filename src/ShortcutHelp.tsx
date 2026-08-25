/**
 * キーボード操作の一覧（F1）。
 *
 * 画面ごとにフッターへ出してはいるが、
 * 「あれ何のキーだっけ」を探すのに画面を切り替えたくないので、
 * どこからでも同じ内容を開けるようにする。
 */
import { useEffect, useState } from 'react';
import { SHORTCUT_HELP } from './shell/shortcuts';
import './shortcuts.css';

/**
 * MOD は実行中のOSに合わせて置き換える（Mac は ⌘）。
 *
 * 🔴 タイムラインの操作は SHORTCUT_HELP から作ること。
 *    ここに同じ一覧を書き写していたせいで、画面を作り直したあとも
 *    **F1 が古い操作（Y / N / E など）を教え続けていた**。
 *    覚え直す気で押した人ほど間違える。持ち主は shortcuts.ts ひとつにする。
 */
const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: 'カット・テロップ共通（タイムライン）',
    items: SHORTCUT_HELP.map((s) => [s.keys, s.label] as [string, string]),
  },
  {
    title: 'テロップの画面',
    items: [
      ['1 〜 9', '雛形（通常・補足・強調…）に変える'],
      ['MOD + C', 'テロップをコピー'],
      ['MOD + V', 'いまの再生位置に貼り付け'],
      ['MOD + D', 'テロップを複製'],
      ['Delete', 'このテロップを消す'],
      ['ドラッグ', 'プレビュー上でテロップを動かす'],
    ],
  },
  {
    title: '要らない場面を丸ごと切る（カットの画面）',
    items: [
      ['I', 'ここから（範囲の始まり）'],
      ['O', 'ここまで（範囲の終わり）'],
      ['Enter', 'その範囲を切る'],
      ['Esc', '選んだ範囲を取り消す'],
    ],
  },
  {
    title: '全体',
    items: [
      ['MOD + O', '動画を読み込む'],
      ['MOD + R', '下書きの続きから'],
      ['MOD + S', '作業内容を保存'],
      ['MOD + W', '編集をやめる'],
      ['MOD + E', '書き出す'],
      ['F1', 'この一覧'],
    ],
  },
];
export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  /*
    🔴 Mac では Ctrl ではなく Command。
       この一覧は「Ctrl + S」と書いていたが、実際の利用者は Mac で、
       メニューは CmdOrCtrl で登録されている。押しても何も起きないキーを
       一覧に載せていた。判定は main 側（paths.ts）に任せる。
  */
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.app?.uiInfo) return;
    void window.app.uiInfo().then((info) => setIsMac(Boolean(info?.isMac)));
  }, []);
  const modKey = isMac ? '⌘' : 'Ctrl';

  /*
    🔴 開いている間、下の画面にキーを届かせない。

    以前は表示するだけだったので、「Yって何だっけ」と F1 を押して一覧を出し、
    閉じようとして Enter を押すと、**裏で「残りをまとめてカット」が走って**
    未判定の候補が全部カットに確定していた。一覧が画面を覆っているので何も見えない。
    Y / N / Delete も同じように素通りしていた。
  */
  useEffect(() => {
    const swallow = (e: KeyboardEvent) => {
      if (e.key === 'F1' || e.key === 'Escape') {
        onClose();
      }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', swallow, true);
    return () => window.removeEventListener('keydown', swallow, true);
  }, [onClose]);

  return (
    <div className="shortcuts-backdrop" onClick={onClose}>
      <div className="shortcuts" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>キーボード操作</h2>
          <button onClick={onClose}>閉じる</button>
        </header>
        <div className="groups">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3>{g.title}</h3>
              <dl>
                {g.items.map(([rawKey, label]) => (
                  <div key={rawKey}>
                    <dt>
                      {rawKey.replace('MOD', modKey).split(' ').map((part, i) =>
                        part === '+' || part === '/' ? (
                          <span key={i} className="sep">
                            {part}
                          </span>
                        ) : (
                          <kbd key={i}>{part}</kbd>
                        ),
                      )}
                    </dt>
                    <dd>{label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <footer>マウスだけでも、上のメニューから同じ操作ができます。</footer>
      </div>
    </div>
  );
}
