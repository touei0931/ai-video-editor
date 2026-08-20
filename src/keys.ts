/**
 * キー操作の共通の門番。
 *
 * 🔴 画面ぜんたいで keydown を拾うアプリでは、これが無いと文字が打てなくなる。
 *
 *    実際に起きていたこと（テロップ確認画面）:
 *      「強調する語」の入力欄で
 *        Backspace → 文字が消えず、**テロップそのものが削除される**
 *        1 / 2 / 3  → スタイルが切り替わる
 *        p          → 表示位置が変わる
 *        Space      → 再生が止まり、空白が入らない
 *      しかも最後に無条件で preventDefault しているので、
 *      打った文字はどこにも残らずに消える。
 *
 *    カット確認の完了画面でも同じ形で、チェックボックスが Space で切り替わらず、
 *    ボタンに focus して Enter を押しても押せない（代わりに一括承認が走る）。
 */

/** 文字を打つ場所にフォーカスがあるか */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable === true;
}

/**
 * 画面ぜんたいのキー操作を無視すべきか。
 *
 * 文字入力中に加えて、ボタンやチェックボックスに focus しているときの
 * Space / Enter も渡さない。そこはブラウザ既定の「押す」に任せる。
 */
export function shouldIgnoreKey(e: KeyboardEvent): boolean {
  if (isTyping(e.target)) return true;

  const el = e.target as HTMLElement | null;
  const tag = el?.tagName?.toUpperCase();
  if ((tag === 'BUTTON' || tag === 'A') && (e.key === ' ' || e.key === 'Enter')) return true;

  // 修飾キー付きはブラウザ/OS の操作。奪わない。
  if (e.ctrlKey || e.metaKey || e.altKey) return true;

  return false;
}
