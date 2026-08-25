// PAC パネルの共通データ型。Swift 側とやり取りする JSON の形もこれに合わせる。

/** カット候補の種類 */
export type CutKind = 'silence' | 'filler' | 'restate'

/** 人間の判断 */
export type Decision = 'pending' | 'approved' | 'rejected'

export interface CutCandidate {
  id: string
  /** 秒 */
  start: number
  /** 秒 */
  end: number
  kind: CutKind
  /** その区間で喋っている内容（無音なら空） */
  text: string
  /** 0..1 */
  confidence: number
  decision: Decision
}

/** テロップの見た目。FCP のテンプレに渡す値でもある */
export interface TelopStyle {
  fontFamily: string
  fontSize: number
  /** #rrggbb */
  color: string
  strokeColor: string
  strokeWidth: number
  shadow: boolean
  bold: boolean
  /** 画面下からの位置(%)。FCP の座標ではなくプレビュー用 */
  bottomPercent: number
}

/** 通常 / 強調 の2種類を既定で持つ */
export type StyleName = 'normal' | 'emphasis'

export interface Telop {
  id: string
  start: number
  end: number
  text: string
  style: StyleName
  /** そのテロップだけ既定から変えたいとき */
  overrides?: Partial<TelopStyle>
}

export interface ProjectState {
  /** プレビューする動画。dev ではローカルの mp4、パネル内では FCP から渡されたパス */
  videoUrl: string | null
  durationSec: number
  /** 0..1 の振幅列。波形描画用 */
  waveform: number[]
  cuts: CutCandidate[]
  telops: Telop[]
  styles: Record<StyleName, TelopStyle>
  /** 選べるフォント（Swift 側が macOS から取ってきて渡す） */
  fonts: string[]
}

export const CUT_LABEL: Record<CutKind, string> = {
  silence: '無音',
  filler: 'フィラー',
  restate: '言い直し',
}

export const STYLE_LABEL: Record<StyleName, string> = {
  normal: '通常',
  emphasis: '強調',
}
