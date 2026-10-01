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
  CutMemorySummary,
  IdentifyResult,
  SpeakerProfile,
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

/**
 * 話者（喋っている人）を声で見分ける・覚える・名前と色を変える。
 *
 * 🔴 音（wav）と覚えた声の置き場所は渡さないこと。
 *    どちらもサンドボックスの外にあり、パネルからは触れない。
 *    コンテナアプリ側（EngineServer）が足す。
 *
 * 🔴 時間で切らないこと。エンジンの起動と声のモデル（40MB）の
 *    読み込みが乗るので、枚数が多いと 30 秒を超える。
 */
async function speakersCall<T>(params: Record<string, unknown>): Promise<T> {
  if (!isInFCP) return mockSpeakers<T>(params)
  return callSwift<T>('speakers', params, 0)
}

/** 声を見分ける（登録済みの声と見比べる） */
export async function identifySpeakers(
  units: { id: string; src_start: number; src_end: number }[],
  onProgress?: (stage: string, ratio: number) => void,
): Promise<IdentifyResult> {
  if (onProgress && isInFCP) window.pacProgress = onProgress
  try {
    return await speakersCall<IdentifyResult>({ op: 'identify', units })
  } finally {
    if (onProgress && isInFCP) window.pacProgress = undefined
  }
}

/** この声を覚える。id があればその人に足し、無ければ名前と色で新しく作る */
export async function enrollSpeaker(args: {
  id?: string
  name?: string
  color?: string
  ranges: { src_start: number; src_end: number }[]
}): Promise<{ speaker: SpeakerProfile; added: number; speakers: SpeakerProfile[] }> {
  return speakersCall({ op: 'enroll', ...args })
}

/** 名前や色を変える。forget を立てると覚えた声だけ消す（名前と色は残す） */
export async function updateSpeaker(args: {
  id: string
  name?: string
  color?: string
  strokeColor?: string | null
  forget?: boolean
}): Promise<{ speakers: SpeakerProfile[] }> {
  return speakersCall({ op: 'update', ...args })
}

/** 登録を消す */
export async function removeSpeaker(id: string): Promise<{ speakers: SpeakerProfile[] }> {
  return speakersCall({ op: 'delete', id })
}

/** 登録の一覧と、部品の有無 */
export async function listSpeakers(): Promise<{ speakers: SpeakerProfile[]; backend?: string }> {
  return speakersCall({ op: 'list' })
}

/*
  開発中（Windows のブラウザ）は声を聞けないので、それらしい返事を作る。
  🔴 UI の確認はここで済ませること。Mac の実機でしか触れない作りにすると、
     パネルの見え方を直すたびにビルドを1回待つことになる。
*/
const devSpeakers: SpeakerProfile[] = []

function mockSpeakers<T>(params: Record<string, unknown>): Promise<T> {
  const op = params.op as string
  if (op === 'list') return Promise.resolve({ speakers: [...devSpeakers], backend: '開発モード' } as T)
  if (op === 'enroll') {
    const existing = devSpeakers.find((s) => s.id === params.id)
    const ranges = (params.ranges as unknown[] | undefined) ?? []
    if (existing) {
      existing.samples += ranges.length
      return Promise.resolve({ speaker: existing, added: ranges.length, speakers: [...devSpeakers] } as T)
    }
    const made: SpeakerProfile = {
      id: `spk${devSpeakers.length + 1}`,
      name: String(params.name ?? '名無し'),
      color: String(params.color ?? '#7ec8ff'),
      samples: ranges.length,
    }
    devSpeakers.push(made)
    return Promise.resolve({ speaker: made, added: ranges.length, speakers: [...devSpeakers] } as T)
  }
  if (op === 'update') {
    const s = devSpeakers.find((x) => x.id === params.id)
    if (s) {
      if (params.name !== undefined) s.name = String(params.name)
      if (params.color !== undefined) s.color = String(params.color)
      if (params.forget) s.samples = 0
    }
    return Promise.resolve({ speakers: [...devSpeakers] } as T)
  }
  if (op === 'delete') {
    const i = devSpeakers.findIndex((x) => x.id === params.id)
    if (i >= 0) devSpeakers.splice(i, 1)
    return Promise.resolve({ speakers: [...devSpeakers] } as T)
  }
  // identify: 登録があれば交互に当て、無ければ2つの「声」に分ける
  const units = (params.units as { id: string; src_start: number; src_end: number }[]) ?? []
  const result: IdentifyResult = {
    units: units.map((u, i) => {
      if (devSpeakers.length > 0 && i % 3 !== 2) {
        return { id: u.id, speaker: devSpeakers[i % devSpeakers.length].id, score: 0.62, voice: null }
      }
      return { id: u.id, speaker: null, score: 0.3, voice: `v${(i % 2) + 1}` }
    }),
    voices: [1, 2].map((n) => {
      const mine = units.filter((_u, i) => i % 3 === 2 && (i % 2) + 1 === n)
      return {
        id: `v${n}`,
        count: mine.length,
        seconds: Math.round(mine.reduce((a, u) => a + (u.src_end - u.src_start), 0) * 100) / 100,
        sample: mine[0] ? { id: mine[0].id, src_start: mine[0].src_start, src_end: mine[0].src_end } : null,
        unitIds: mine.map((u) => u.id),
      }
    }).filter((v) => v.count > 0),
    speakers: [...devSpeakers],
    matched: units.filter((_u, i) => devSpeakers.length > 0 && i % 3 !== 2).length,
    unknown: units.filter((_u, i) => i % 3 === 2).length,
    tooShort: 0,
    backend: '開発モード',
  }
  return Promise.resolve(result as T)
}

/**
 * 覚えた「間の好み」を読む。
 *
 * 🔴 これは機械学習ではない。④カットで下した判断の記録と、
 *    その境目の探索だけ。どこにも送っていない。
 */
export async function loadCutMemory(): Promise<CutMemorySummary> {
  if (!isInFCP) {
    return { decisions: 0, silences: 0, minSamples: 30, fillerSuggestions: [] }
  }
  return callSwift<CutMemorySummary>('cutMemory', {}, 0)
}

/** 覚えたことを忘れる */
export async function forgetCutMemory(): Promise<CutMemorySummary> {
  if (!isInFCP) {
    return { decisions: 0, silences: 0, minSamples: 30, fillerSuggestions: [] }
  }
  return callSwift<CutMemorySummary>('forgetCutMemory', {}, 0)
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
    /**
     * 素材の本当の長さ（秒）。
     * 🔴 必ず渡すこと。無いと書き出し側が見積もることになり、
     *    Final Cut が「対応するメディアがない」と言って読み込みを拒む。
     */
    durationSec: number
    /**
     * ④カットで下した判断ぜんぶ（切る・残すの両方）。
     * 🔴 承認したものだけでは「好み」は分からない。残した方も要る。
     */
    decisions?: { kind: string; start: number; end: number; text: string; decision: string }[]
    /** 書き出す再生速度（1.0 = 等倍）。1.0 なら速度の指定は書かれない */
    speed?: number
    /** 素材の大きさ。無いと書き出しが 1920x1080 決め打ちになる */
    width?: number
    height?: number
    /**
     * 何で作ったか（版・設定・件数）。XML のコメントとして残る。
     *
     * 🔴 書き出したものだけで追えるようにすること。
     *    版も設定も分からないと、直しが届いたかどうかを毎回
     *    キャプチャで聞き直すことになる。実際それで何往復もした。
     */
    meta?: Record<string, unknown>
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
