// Swift(WKWebView) との橋渡し。
//
// FCP のパネル内では window.webkit.messageHandlers.pac 経由で Swift を呼ぶ。
// Windows のブラウザで開発しているときは Swift がいないので、モックで動く。
// 「同じ UI が両方で動く」ことを保つのがこの層の役目。

import { MOCK } from './mock'
import type {
  ProjectState,
  Telop,
  CutCandidate,
  TitleTemplateSummary,
  AnalyzeSettings,
} from './types'

type Resolver = { resolve: (v: unknown) => void; reject: (e: unknown) => void }

declare global {
  interface Window {
    webkit?: { messageHandlers?: { pac?: { postMessage: (m: unknown) => void } } }
    /** Swift から呼ばれる。応答を受け取る入口 */
    pacResolve?: (id: number, ok: boolean, payload: unknown) => void
    /** Swift から呼ばれる。解析の進み具合を受け取る入口 */
    pacProgress?: (stage: string, ratio: number) => void
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

function callSwift<T>(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    window.webkit!.messageHandlers!.pac!.postMessage({ id, method, params })
    /*
      Swift 側が落ちたときに永遠に待たないようにする。

      🔴 人が操作している間は時間で切らないこと（timeoutMs = 0）。
         ファイルを選ぶダイアログは、探している間に30秒を軽く超える。
         切ってしまうと、あとから届いた「選んだファイル」を捨てることになり、
         選んだのに何も起きない、という見え方になる。
         解析も数分〜数十分かかるので同じ。
    */
    if (timeoutMs > 0) {
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(
            `${method} が応答しませんでした。パネルを閉じて開き直してください`,
          ))
        }
      }, timeoutMs)
    }
  })
}

/**
 * 素材とプレビューの読み込み。パネル内では FCP から、開発中はモックから。
 *
 * 開発中に public/dev-state.json（エンジンで実素材を解析した結果）を置いておくと、
 * そちらを優先して読む。作り物ではなく本物のデータで UI を確認するため。
 */
export async function loadProject(): Promise<ProjectState> {
  if (isInFCP) return callSwift<ProjectState>('loadProject')

  try {
    const res = await fetch('./dev-state.json', { cache: 'no-store' })
    if (res.ok) {
      const real = (await res.json()) as Partial<ProjectState>
      return { ...structuredClone(MOCK), ...real }
    }
  } catch {
    // 置いていないだけなのでモックに落ちる
  }
  return structuredClone(MOCK)
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
  return callSwift<string | null>('grantMediaFolder', {}, 0)
}

/** 解析する動画を選ぶ。サンドボックスの許可もここで取れる */
export async function pickVideo(): Promise<{ path: string; name: string } | null> {
  if (!isInFCP) {
    // 開発中は選べないので、置いてある実データを使う
    return { path: '(開発モード)', name: 'dev-sample.mp4' }
  }
  return callSwift<{ path: string; name: string } | null>('pickVideo', {}, 0)
}

/**
 * 解析（文字起こし → カット候補とテロップ）を実行する。
 *
 * フィラーと言い直しは「何と言ったか」が分からないと判定できないので、
 * カットだけを先に出すことはできない。ここで一度に作る。
 */
export async function runAnalysis(
  params: { videoPath: string } & AnalyzeSettings,
  onProgress: (stage: string, ratio: number) => void,
): Promise<ProjectState> {
  if (!isInFCP) {
    // 開発中はエンジンがいないので、実データを読みながら進捗だけ真似る
    const stages: [string, number][] = [
      ['音声を取り出しています', 0.1],
      ['文字起こしをしています', 0.45],
      ['カット候補を探しています', 0.8],
      ['テロップを作っています', 0.95],
      ['完了', 1],
    ]
    for (const [stage, ratio] of stages) {
      onProgress(stage, ratio)
      await new Promise((r) => setTimeout(r, 260))
    }
    return loadProject()
  }

  window.pacProgress = onProgress
  try {
    return await callSwift<ProjectState>('runAnalysis', params, 0)
  } finally {
    window.pacProgress = undefined
  }
}

/**
 * 友達が FCP から書き出した .fcpxml を「テロップの見本」として取り込む。
 * effect の uid と text-style を丸写しするので、FCP 上の見た目が完全に一致する。
 */
export async function loadTitleTemplate(): Promise<TitleTemplateSummary> {
  if (!isInFCP) {
    // 開発中は見本を選べないので、それらしいものを返す
    return { effectName: '基本01_10', font: 'Hiragino Sans', fontFace: 'W8', fontSize: 146, bold: true, paramCount: 3 }
  }
  return callSwift<TitleTemplateSummary>('loadTitleTemplate', {}, 0)
}

export async function clearTitleTemplate(): Promise<void> {
  if (!isInFCP) return
  await callSwift('clearTitleTemplate')
}

/**
 * 承認したカットとテロップを FCPXML にして書き出す。
 *
 * 🔴 mediaPath を必ず渡すこと。
 *    渡さないと、書き出した XML に**映像が入らない**（テロップだけになる）。
 *    Final Cut は文句を言わずに読み込むので、開くまで気づけない。
 */
export async function sendToFCP(
  payload: {
    cuts: CutCandidate[]
    telops: Telop[]
    styles?: unknown
    mediaPath: string | null
    fps?: number
  },
  onProgress?: (stage: string, ratio: number) => void,
): Promise<{ ok: boolean; message: string }> {
  if (!isInFCP) {
    // 開発中は送らずに中身だけ確認できるようにする
    console.info('[dev] FCP へ送る内容', payload)
    return { ok: true, message: `開発モード: カット${payload.cuts.length}件 / テロップ${payload.telops.length}件` }
  }
  /*
    🔴 時間で切らないこと。保存先を選ぶダイアログは人が操作する。
       30秒で切ると、保存先を探しているだけで「失敗しました」になる。
  */
  if (onProgress) window.pacProgress = onProgress
  try {
    return await callSwift('sendToFCP', payload, 0)
  } finally {
    if (onProgress) window.pacProgress = undefined
  }
}
