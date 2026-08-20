/**
 * キーボード操作の一覧（F1）。
 *
 * 画面ごとにフッターへ出してはいるが、
 * 「あれ何のキーだっけ」を探すのに画面を切り替えたくないので、
 * どこからでも同じ内容を開けるようにする。
 */
import './shortcuts.css';

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: 'カットの確認',
    items: [
      ['Y', 'この候補をカットする'],
      ['N', 'この候補は残す'],
      ['S', '保留にする（あとで見直す）'],
      ['U', '直前の判定を取り消す'],
      ['[ ]', '前の候補 / 次の候補へ'],
      ['← →', 'カットの始まりを1コマ動かす'],
      ['Shift + ← →', 'カットの終わりを1コマ動かす'],
      ['Space', '再生 / 一時停止'],
      ['R', '繋ぎ目から再生し直す'],
      ['Enter', '残りをまとめてカットする'],
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
      ['Ctrl + Z', '取り消す'],
      ['Space', '再生 / 一時停止'],
      ['ドラッグ', 'プレビュー上でテロップを動かす'],
    ],
  },
  {
    title: '全体',
    items: [
      ['Ctrl + O', '動画を読み込む'],
      ['Ctrl + S', '作業内容を保存'],
      ['Ctrl + E', '書き出す'],
      ['Ctrl + T', 'テロップを追加'],
      ['F1', 'この一覧'],
    ],
  },
];

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
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
                {g.items.map(([k, label]) => (
                  <div key={k}>
                    <dt>
                      {k.split(' ').map((part, i) =>
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
