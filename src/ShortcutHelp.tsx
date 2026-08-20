/**
 * キーボード操作の一覧（F1）。
 *
 * 画面ごとにフッターへ出してはいるが、
 * 「あれ何のキーだっけ」を探すのに画面を切り替えたくないので、
 * どこからでも同じ内容を開けるようにする。
 */
import { useEffect, useState } from 'react';
import './shortcuts.css';

/** MOD は実行中のOSに合わせて置き換える（Mac は ⌘） */
const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: 'カットの確認',
    items: [
      ['Y', 'この候補をカットする'],
      ['N', 'この候補は残す'],
      ['S', 'あとで見る（保留）'],
      ['U', '直前の判定を取り消す'],
      ['[ ]', '前の候補 / 次の候補へ'],
      ['← →', 'カットの始まりを1コマ動かす'],
      ['Shift + ← →', 'カットの終わりを1コマ動かす'],
      ['Space', '再生 / 一時停止'],
      ['R', '繋ぎ目から再生し直す'],
      ['Enter', '残りをまとめてカットする（確認あり）'],
    ],
  },
  {
    title: 'テロップの確認',
    items: [
      ['↑ ↓', '前後のテロップへ'],
      ['Tab', '次の「要確認」へ飛ぶ'],
      ['E', '文言を直す'],
      ['1 / 2 / 3', '通常 / 補足 / 強調に変える'],
      ['P', '表示位置を変える（上・中央・下）'],
      ['Del', 'このテロップを削除'],
      ['MOD + Z', '取り消す'],
      ['Space', '再生 / 一時停止'],
      ['ドラッグ', 'プレビュー上でテロップを動かす'],
    ],
  },
  {
    title: '通しで確認するとき',
    items: [
      ['← →', '前後のカットへ'],
      ['Enter', 'そのカットを切る / 戻す'],
      ['I', 'ここからカットする（範囲の始まり）'],
      ['O', 'ここまでカットする（範囲の終わり）'],
      ['Space', '再生 / 一時停止'],
      ['Esc', '確認を終える'],
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
      ['MOD + T', 'テロップを追加'],
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
