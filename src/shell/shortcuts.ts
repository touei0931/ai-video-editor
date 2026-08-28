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
 *   ⌘B         白線の所で素材を分ける
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
  | 'delete'
  /** 白線の所で素材を分ける（Final Cut の ⌘B） */
  | 'blade'
  // ── ここから下はこのアプリ独自。Final Cut には対応するものが無い ──
  /** 切る（承認） */
  | 'markCut'
  /** 残す（却下） */
  | 'markKeep'
  /** 保留 */
  | 'markHold'
  /** 次の保留へ */
  | 'nextPending'
  /** 前の保留へ */
  | 'prevPending'
  /** 再生位置より前を、頭からまとめて切る */
  | 'cutBefore'
  /** 再生位置より後ろを、末尾までまとめて切る */
  | 'cutAfter'
  /**
   * 素材（コマ）のレーンの高さ。
   *
   * 🔴 この2つと拡大縮小は Timeline が自分で受け取る。
   *    倍率もレーンの高さも Timeline の内側の状態なので、
   *    Stage を経由させると持ち回すだけの引数が増える。
   */
  | 'laneBigger'
  | 'laneSmaller';

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
  { keys: 'Delete', label: '選んだクリップを消す（カット候補では「残す」）' },
  { keys: 'D', label: 'ここを切る' },
  { keys: 'F', label: 'ここは残す' },
  { keys: 'G', label: '保留にする' },
  { keys: '↓ / ↑', label: '次 / 前の保留へ' },
  { keys: 'Ctrl + B', label: 'ここで素材を分ける（切り込み）' },
  { keys: 'Q / W', label: 'クリップの先頭 / 末尾まで切る（カット画面）' },
  { keys: '1 / 2', label: '拡大 / 縮小（テロップ画面を除く）' },
  { keys: 'Shift + ↑ / ↓', label: '素材のコマを大きく / 小さく（Shift + 1 / 2 も同じ）' },
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
    // 🔴 Final Cut と同じ ⌘B。単独の B にしないこと。
    //    再生しながら聞いている最中に、うっかり素材が分かれる。
    if (k === 'b') return 'blade';
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
    /*
      🔴 上下は「保留へ移る」に割り当てる。
         Final Cut では上下が編集点の移動で、ここでの編集点にあたるのが
         保留の箇所。指の動きが同じになるので覚え直しが要らない。
    */
    case 'ArrowDown':
      return 'nextPending';
    case 'ArrowUp':
      return 'prevPending';
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
    /*
      Q / W は「ここより前（後ろ）を丸ごと切る」。

      🔴 素材の頭と尻を落とす操作は、範囲を指定するまでもない。
         I → O → Enter の3手を、聞きながら1手で済ませる。
    */
    case 'q':
      return 'cutBefore';
    case 'w':
      return 'cutAfter';
    /*
      素材のコマを大きく / 小さく。
      🔴 テロップ画面では雛形の切り替え（1〜9）が先。
         あちらは枠を選ぶキーとして先に決まっているので、ここでは奪わない。
    */
    case '1':
      return 'laneBigger';
    case '2':
      return 'laneSmaller';
    /*
      判定は D / F / G。ホームポジションで**隣り合った3つ**にする。

      🔴 左から順に「切る・残す・保留」。インスペクタのボタンの並びと同じ。
         3つが離れていると、押すたびに指を探すことになり、
         1件あたりの手数が減らない（この画面の目的はレビュー速度）。

      Final Cut の既定との衝突:
        D … 単独キーの割り当ては無い（⌘D は複製）
        F … 「よく使う項目にする」。このアプリに同じ機能は無い
        G … 単独キーの割り当ては無い
      Y / X は隣り合っていない（Y は上段、X は下段）ので使わない。
    */
    case 'd':
      return 'markCut';
    case 'f':
      return 'markKeep';
    case 'g':
      return 'markHold';
    default:
      return null;
  }
}

/**
 * J / L を続けて押したときの速さ。
 *
 * 🔴 いきなり2倍にしないこと。1回押しただけで2倍になると、
 *    「少しだけ速く見たい」ができない。細かい段から上げる。
 *
 * 🔴 2倍で止めること。校正のための道具なので、それ以上速くしても
 *    声が聞き取れず使い道がない。
 *    （Chromium の playbackRate の上限は 16。超えると例外を投げ、
 *      画面が真っ白になって操作を受け付けなくなる。実際に 32 で起きた。
 *      useEditedPlayer の setRateSafely でも丸めている）
 */
export const SHUTTLE_STEPS = [1, 1.25, 1.5, 1.75, 2];

export function nextShuttle(current: number, forward: boolean): number {
  const dir = forward ? 1 : -1;
  const now = Math.abs(current);
  const sameWay = current === 0 || Math.sign(current) === dir;
  if (!sameWay) return dir; // 向きが変わったら等速から
  const i = SHUTTLE_STEPS.indexOf(now);
  const next = SHUTTLE_STEPS[Math.min(SHUTTLE_STEPS.length - 1, i < 0 ? 0 : i + 1)];
  return dir * next;
}
