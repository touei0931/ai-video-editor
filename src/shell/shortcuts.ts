/**
 * キー割り当て。Final Cut Pro に合わせる。
 *
 * 🔴 割り当てを画面ごとに散らさないこと。
 *    段階ごとに違うキーだと覚えられない。ここ1箇所で決める。
 *
 * 🔴 文字入力中は奪わないこと。
 *    テロップの文言を打っているときに L で再生が始まると、
 *    何が起きたか分からないまま文字が消える。
 *
 * Final Cut Pro の割り当て（このアプリで意味を持つものだけ）:
 *
 *   Space      再生 / 一時停止
 *   J K L      逆送り / 停止 / 送り（続けて押すと倍速）
 *   ← →        1コマ戻る / 進む
 *   ⇧← ⇧→      10コマ戻る / 進む
 *   Home End   先頭 / 末尾
 *   I O        範囲の始点 / 終点
 *   ⌘Z         元に戻す
 *   ⇧Z         全体を表示
 *   ⌘+ ⌘-      拡大 / 縮小
 *   N          吸着の切り替え
 *   Delete     選んだものを消す
 */

export type ShortcutAction =
  | 'playPause'
  | 'shuttleBack'
  | 'stop'
  | 'shuttleForward'
  | 'frameBack'
  | 'frameForward'
  | 'jumpBack'
  | 'jumpForward'
  | 'home'
  | 'end'
  | 'markIn'
  | 'markOut'
  | 'undo'
  | 'zoomFit'
  | 'zoomIn'
  | 'zoomOut'
  | 'toggleSnap'
  | 'delete';

/** 画面に出す一覧。ヘルプと同じ言葉にする */
export const SHORTCUT_HELP: { keys: string; label: string }[] = [
  { keys: 'Space', label: '再生 / 一時停止' },
  { keys: 'L', label: '送り（続けて押すと倍速）' },
  { keys: 'K', label: '止める' },
  { keys: 'J', label: '逆送り（続けて押すと倍速）' },
  { keys: '← →', label: '1コマ戻る / 進む' },
  { keys: 'Shift + ← →', label: '10コマ戻る / 進む' },
  { keys: 'Home / End', label: '先頭 / 末尾' },
  { keys: 'I / O', label: '範囲の始点 / 終点' },
  { keys: 'Ctrl + Z', label: '元に戻す' },
  { keys: 'Shift + Z', label: '全体を表示' },
  { keys: 'Ctrl + + / −', label: '拡大 / 縮小' },
  { keys: 'N', label: '吸着の切り替え' },
  { keys: 'Delete', label: '選んだものを消す' },
];

/** 文字を打っている最中か。打っているならキーを奪わない */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable === true
  );
}

/**
 * 押されたキーを操作の名前に直す。分からなければ null。
 *
 * 🔴 Ctrl / ⌘ が付くものを先に見ること。
 *    「修飾キーが付いていたら無視」を先に書くと、Ctrl+Z が一度も効かない。
 *    これは実際にこのアプリで起きて、元に戻すが動いていなかった。
 */
export function matchShortcut(e: KeyboardEvent): ShortcutAction | null {
  const key = e.key;
  const mod = e.ctrlKey || e.metaKey;

  if (mod) {
    const k = key.toLowerCase();
    if (k === 'z') return 'undo';
    if (key === '+' || key === '=' || key === ';') return 'zoomIn';
    if (key === '-' || key === '_') return 'zoomOut';
    return null;
  }

  if (e.altKey) return null;

  if (e.shiftKey) {
    switch (key) {
      case 'ArrowLeft':
        return 'jumpBack';
      case 'ArrowRight':
        return 'jumpForward';
      case 'Z':
      case 'z':
        return 'zoomFit';
      default:
        return null;
    }
  }

  switch (key) {
    case ' ':
      return 'playPause';
    case 'ArrowLeft':
      return 'frameBack';
    case 'ArrowRight':
      return 'frameForward';
    case 'Home':
      return 'home';
    case 'End':
      return 'end';
    case 'Delete':
    case 'Backspace':
      return 'delete';
    default:
      break;
  }

  switch (key.toLowerCase()) {
    case 'j':
      return 'shuttleBack';
    case 'k':
      return 'stop';
    case 'l':
      return 'shuttleForward';
    case 'i':
      return 'markIn';
    case 'o':
      return 'markOut';
    case 'n':
      return 'toggleSnap';
    default:
      return null;
  }
}

/** J / L を続けて押したときの速さ。Final Cut と同じ段階 */
export const SHUTTLE_STEPS = [1, 2, 4, 8, 16, 32];

export function nextShuttle(current: number, forward: boolean): number {
  const dir = forward ? 1 : -1;
  const now = Math.abs(current);
  const sameWay = current === 0 || Math.sign(current) === dir;
  if (!sameWay) return dir; // 向きが変わったら等速から
  const i = SHUTTLE_STEPS.indexOf(now);
  const next = SHUTTLE_STEPS[Math.min(SHUTTLE_STEPS.length - 1, i < 0 ? 0 : i + 1)];
  return dir * next;
}
