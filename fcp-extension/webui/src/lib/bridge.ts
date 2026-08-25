// Swift(WKWebView) との橋渡し。
//
// FCP のパネル内では window.webkit.messageHandlers.pac 経由で Swift を呼ぶ。
// Windows のブラウザで開発しているときは Swift がいないので、モックで動く。
// 「同じ UI が両方で動く」ことを保つのがこの層の役目。

import { MOCK } from './mock'
import type { ProjectState, Telop, CutCandidate } from './types'

type Resolver = { resolve: (v: unknown) => void; reject: (e: unknown) => void }

declare global {
  interface Window {
    webkit?: { messageHandlers?: { pac?: { postMessage: (m: unknown) => void } } }
    /** Swift から呼ばれる。応答を受け取る入口 */
    pacResolve?: (id: number, ok: boolean, payload: unknown) => void
  }
}

/** FCP のパネルの中で動いているか */
export const isInFCP = typeof window !== 'undefined' && !!window.webkit?.messageHandlers?.pac

let seq = 0
const pending = new Map<number, Resolver>()

if (typeof window !== 'undefined') {
  window.pacResolve = (id, ok, payload) => {
    const r = pending.get(id)
    if (!r) return
    pending.delete(id)
    ok ? r.resolve(payload) : r.reject(payload)
  }
}

function callSwift<T>(method: string, params: unknown = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    window.webkit!.messageHandlers!.pac!.postMessage({ id, method, params })
    // Swift 側が落ちたときに永遠に待たないようにする
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`${method} が応答しませんでした`))
      }
    }, 30_000)
  })
}

/** 素材とプレビューの読み込み。パネル内では FCP から、開発中はモックから */
export async function loadProject(): Promise<ProjectState> {
  if (!isInFCP) return structuredClone(MOCK)
  return callSwift<ProjectState>('loadProject')
}

/** macOS のフォント一覧。サンドボックス内でも取得できる */
export async function listFonts(): Promise<string[]> {
  if (!isInFCP) return MOCK.fonts
  return callSwift<string[]>('listFonts')
}

/**
 * 素材フォルダの許可をもらう（初回のみ）。
 * security-scoped bookmark として保存されるので、次回以降はダイアログが出ない。
 */
export async function grantMediaFolder(): Promise<string | null> {
  if (!isInFCP) return null
  return callSwift<string | null>('grantMediaFolder')
}

/** 承認したカットとテロップを FCPXML にして FCP のタイムラインへ送る */
export async function sendToFCP(payload: {
  cuts: CutCandidate[]
  telops: Telop[]
}): Promise<{ ok: boolean; message: string }> {
  if (!isInFCP) {
    // 開発中は送らずに中身だけ確認できるようにする
    console.info('[dev] FCP へ送る内容', payload)
    return { ok: true, message: `開発モード: カット${payload.cuts.length}件 / テロップ${payload.telops.length}件` }
  }
  return callSwift('sendToFCP', payload)
}
