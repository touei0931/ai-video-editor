// PAC パネルの共通データ型。Swift 側とやり取りする JSON の形もこれに合わせる。

/** カット候補の種類 */
export type CutKind = 'silence' | 'filler' | 'restate' | 'aside'

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
  /** 画面左からの位置(%)。50 で中央 */
  leftPercent: number
  /**
   * 画面端で自動的に折り返すか。
   * 切ると画面からはみ出すテロップも作れる（手で入れた改行は常に効く）。
   */
  autoWrap: boolean
}

/**
 * テロップの一部だけ見た目を変えるための指定。
 * 日本語テロップの作法として「その語だけ目立たせる」ことが多いので、
 * 文字の範囲ごとに大きさ・色・太さを持てるようにしておく。
 */
export interface TelopSpan {
  /** 本文の何文字目から何文字目か（終わりは含まない） */
  start: number
  end: number
  fontSize?: number
  color?: string
  bold?: boolean
}

/** 通常 / 強調 の2種類を既定で持つ */
export type StyleName = 'normal' | 'emphasis'

/** 語ひとつぶんの時刻。1画面ぶんに割り直すときに使う */
export interface TelopWord {
  text: string
  srcStart: number
  srcEnd: number
}

export interface Telop {
  id: string
  start: number
  end: number
  text: string
  style: StyleName
  /** そのテロップだけ既定から変えたいとき */
  overrides?: Partial<TelopStyle>
  /** 一部の文字だけ見た目を変えたいとき */
  spans?: TelopSpan[]
  /**
   * 語ごとの時刻。
   * 🔴 1画面ぶんに割り直すときに、割った先の時刻を出すのに要る。
   *    無いと割れない（出どころの無い時刻をでっち上げないため）。
   */
  words?: TelopWord[]
}

/** 友達のテロップ見本（FCPXML から取り込んだもの）の要約 */
export interface TitleTemplateSummary {
  effectName: string
  /**
   * 見本に文字の書式（書体・大きさ）が入っていたか。
   * 🔴 見本のタイトルに文字を入れずに書き出すと false になる。
   *    写すものが無いので既定の見た目になる。必ず画面で知らせること。
   */
  hasStyle?: boolean
  font: string
  fontFace: string
  fontSize: number
  bold: boolean
  paramCount: number
}

export interface ProjectState {
  /** プレビューする動画。dev ではローカルの mp4、パネル内では FCP から渡されたパス */
  videoUrl: string | null
  durationSec: number
  /**
   * 素材の大きさとコマ数（回転を見た「表示上の」値）。
   * 🔴 書き出しはこれで組む。無いと 1920x1080 決め打ちになり、
   *    縦の素材が横向きのプロジェクトに小さく収まる。
   */
  width?: number
  height?: number
  fps?: number
  /** 0..1 の振幅列。波形描画用 */
  waveform: number[]
  cuts: CutCandidate[]
  telops: Telop[]
  styles: Record<StyleName, TelopStyle>
  /** 選べるフォント（Swift 側が macOS から取ってきて渡す） */
  fonts: string[]
  /** 取り込み済みのテロップ見本。無ければ null */
  template?: TitleTemplateSummary | null
  /** FCP から読めた情報（アプリ名・バージョン・シーケンス名など） */
  host?: Record<string, unknown>
  /**
   * 解析中に何が起きたか。
   * 🔴 素材の大きさが読めなかった理由（videoInfoError）は必ず画面に出すこと。
   *    黙って 1920x1080 に倒れると、縦の素材が枠の 0.316 倍で真ん中に出る、
   *    という形でしか現れず、3回の配布で誰も気づけなかった（2026-08-31）。
   */
  report?: {
    videoInfoError?: string
    /**
     * エンジンが実際に使った設定。
     * 🔴 画面で選んだものと突き合わせて出すこと。
     *    途中で落ちても候補が少ないとしか見えず、気づけない。
     */
    cutPreset?: string
    detectAside?: boolean
    cutCandidates?: number
    droppedSegments?: number
    speechRatio?: number
    wordCount?: number
    unknown?: string[]
  }
}

export const CUT_LABEL: Record<CutKind, string> = {
  silence: '無音',
  filler: 'フィラー',
  restate: '言い直し',
  aside: '独り言',
}

export const STYLE_LABEL: Record<StyleName, string> = {
  normal: '通常',
  emphasis: '強調',
}

// ── 解析の設定 ─────────────────────────────────────────

export type ModelName = 'large-v3-turbo' | 'medium' | 'small' | 'base'

/**
 * 間の詰め具合。左ほど間を残し、右ほど詰まる。
 *
 * 🔴 sidecar/cut.py の PRESETS と名前を合わせること。
 *    ここに無い名前を送ると、エンジン側は黙って既定に戻る。
 */
export type CutPreset = 'loose' | 'talk' | 'short' | 'tight'

export const CUT_PRESETS: { name: CutPreset; label: string; description: string }[] = [
  {
    name: 'loose',
    label: 'ゆったり',
    description: '間をしっかり残します。落ち着いた解説向けです。',
  },
  {
    name: 'talk',
    label: 'ふつう（おすすめ）',
    description: '10〜20分の解説や実況向け。意図して置いた間は残ります。',
  },
  {
    name: 'short',
    label: 'テンポよく',
    description: 'ショート動画向け。短い間もどんどん候補に挙げます。',
  },
  {
    name: 'tight',
    label: 'とにかく詰める',
    description: '息継ぎくらいの間まで候補に挙げます。切る所は増えますが、判断も増えます。',
  },
]

export interface AnalyzeSettings {
  language: string
  model: ModelName
  /**
   * 間の詰め具合。
   *
   * 🔴 これを送らないと、どんな素材でも「ふつう」で候補を出す。
   *    ショート動画では**候補が数件しか出ず**、
   *    「カットが2つしかない」と言われた（2026-08-31）。
   */
  cutPreset: CutPreset
  /**
   * 話の本筋と繋がっていないひとりごと（「あれ、止まってない？」など）も
   * 候補に挙げるか。
   *
   * 🔴 意味を読んでいるわけではない。見ているのは
   *    「前後と同じ話題の語を使っているか」「ぽつんと孤立しているか」
   *    「撮り直しの言い回しか」の3つ。外すこともあるので、
   *    切るかどうかは必ず「④ カット」で人が決める。
   */
  detectAside: boolean
  /**
   * 自分の口ぐせ。読点・空白・改行のどれで区切ってもよい。
   * 🔴 口ぐせは人によって違う。決め打ちの一覧（えー・あの…）だけでは足りない。
   */
  extraFillers: string
  /**
   * 書き出す再生速度（1.0 = 等倍）。
   *
   * 🔴 これは書き出しにだけ効く。解析には関係しない。
   *    あとで FCP 側で速度を変えると、テロップの位置がずれる。
   *    ここで指定しておけば、テロップも一緒に付いてくる。
   */
  exportSpeed: number
  /**
   * テロップ1枚に入れる文字数の上限（全角換算。半角は 0.5 と数える）。
   *
   * 🔴 ここで割るのは「1画面に出す量」。
   *    大きくすると1枚が長くなり、読み終わる前に次へ行く。
   *    小さくすると枚数が増え、目がついていかない。
   *    実際の見え方はテンプレートの文字サイズ次第なので、
   *    決め打ちにせず触れるようにしておく。
   */
  telopMaxChars: number
}


/**
 * 覚えた「間の好み」。
 * 🔴 必ず根拠（件数・一致率）と一緒に見せること。
 *    候補が減る仕組みなので、理由が見えないと不具合と区別できない。
 */
export interface CutMemorySummary {
  decisions: number
  silences: number
  minSamples: number
  fillerSuggestions: string[]
  /** これより短い間は候補にしない（秒）。覚えていなければ無し */
  minGain?: number
  samples?: number
  agreement?: number
}

export const LANGUAGES: { code: string; label: string }[] = [
  { code: 'ja', label: '日本語' },
  { code: 'en', label: '英語' },
  { code: 'auto', label: '自動で判定する' },
]

/** モデルの選択肢。初回のダウンロード量を必ず添える（無反応に見えて強制終了されるため） */
export const MODELS: {
  name: ModelName
  label: string
  description: string
  downloadSize: string
}[] = [
  {
    name: 'large-v3-turbo',
    label: '高い（おすすめ） — large-v3-turbo',
    description: '一番きれいに文字起こしできます。M2 なら実時間の 1〜2 倍くらいです。',
    downloadSize: '1.6GB',
  },
  {
    name: 'medium',
    label: 'ふつう — medium',
    description: '少し粗くなりますが、その分軽いです。',
    downloadSize: '1.5GB',
  },
  {
    name: 'small',
    label: '低い（速い） — small',
    description: '固有名詞をよく間違えます。下書きを急ぎで作るとき向けです。',
    downloadSize: '480MB',
  },
  {
    name: 'base',
    label: '最低（試し用） — base',
    description: '動くかどうかを確かめるためのものです。仕上げには向きません。',
    downloadSize: '145MB',
  },
]

/** 画面の進み方 */
export type Step = 'select' | 'settings' | 'analyzing' | 'cut' | 'telop'
