/**
 * 骨格（EditorShell）のツールバーに出す「いま何で作業しているか」。
 *
 * 🔴 版・素材の大きさ・使った設定は必ず画面に出すこと（プラグイン版と同じ）。
 *    出していないと、直した版を渡しても「本当にそれが動いているのか」が
 *    キャプチャから分からない。素材の大きさが読めずに 1920x1080 へ倒れたときも、
 *    出ていなければ縦の素材が小さく出る形でしか現れず、3回の配布で誰も気づけなかった。
 *
 * 段階ごとの画面（CutStage / TelopStage / FinalStage）に1つずつ渡すと
 * 3か所の配線になるので、Context で骨格へ直接届ける。
 */

import { createContext, useContext } from 'react';

export interface ShellInfo {
  /** アプリの版。不具合を伝えるときに一緒に教えてもらう */
  version?: string | null;
  /** 素材の大きさとコマ数。書き出しはこの値で組む */
  media?: { width: number; height: number; fps: number } | null;
  /** 解析に使った設定の要約 */
  analysis?: { paceLabel: string; detectAside: boolean; candidates: number } | null;
}

export const ShellInfoContext = createContext<ShellInfo>({});

export function useShellInfo(): ShellInfo {
  return useContext(ShellInfoContext);
}
