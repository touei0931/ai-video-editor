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
  /** この語のあとに息継ぎがある（エンジンが音で確かめた）。長さに関わらずここで割る */
  breakAfter?: boolean
}

export interface Telop {
  id: string
  start: number
  end: number
  text: string
  style: StyleName
  /** そのテロップだけ既定から変えたいとき */
  overrides?: Partial<TelopStyle>
  /**
   * 喋っている人（登録済みの話者の id）。無ければ null。
   *
   * 🔴 「誰が喋ったか（色）」と「どう見せるか（スタイル）」は別の軸。
   *    色は overrides.color として持ち、スタイル（通常/強調）は触らない。
   */
  speaker?: string | null
  /** 見分けたときの近さ（0..1）。低いものは人が確かめる手がかり */
  speakerScore?: number
  /** 誰にも当たらなかったときの「声1」「声2」 */
  voice?: string | null
  /**
   * 人が「この声は◯◯」と決めた。
   * 🔴 見分け直しても動かさないこと。直した意味が無くなる。
   */
  manualSpeaker?: boolean
  /** 一部の文字だけ見た目を変えたいとき */
  spans?: TelopSpan[]
  /**
   * 語ごとの時刻。
   * 🔴 1画面ぶんに割り直すときに、割った先の時刻を出すのに要る。
   *    無いと割れない（出どころの無い時刻をでっち上げないため）。
   */
  words?: TelopWord[]
}

/**
 * 登録した人（覚えた声の持ち主）。
 * 🔴 覚えているのは声の特徴（数値）だけで、音そのものは保存していない。
 */
export interface SpeakerProfile {
  id: string
  name: string
  /** #rrggbb。テロップの文字色として使う */
  color: string
  /** 縁取りの色。登録していなければ触らない */
  strokeColor?: string | null
  /** 覚えている声の数（区間の数） */
  samples: number
  updated?: string
}

/** 誰にも当たらなかった声のまとまり（「声1」「声2」…） */
export interface VoiceGroup {
  id: string
  count: number
  seconds: number
  /** 聞いて確かめる用。いちばん長い区間 */
  sample: { id: string; src_start: number; src_end: number } | null
  unitIds: string[]
}

/** 声を見分けた結果（エンジンが返す形） */
export interface IdentifyResult {
  units: { id: string; speaker: string | null; score: number; voice: string | null }[]
  voices: VoiceGroup[]
  speakers: SpeakerProfile[]
  matched: number
  unknown: number
  tooShort: number
  /** 部品とモデルの有無（同梱漏れをここから辿る） */
  backend?: string
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
  /** 登録した話者（喋っている人ごとの色）。覚えた声は動画をまたいで残る */
  speakers?: SpeakerProfile[]
  /** 誰にも当たらなかった声のまとまり。名前を付けると次から自動で当たる */
  voices?: VoiceGroup[]
  /** 最後に声を見分けた結果の要約。画面に出して判断の材料にする */
  speakerReport?: { matched: number; unknown: number; tooShort: number; backend?: string }
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

export type ModelName = 'qwen3-asr-1.7b' | 'large-v3-turbo' | 'medium' | 'small' | 'base'

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
   * 出演者（喋っている人）の一覧。1 行に 1 人。「名前 呼び方 呼び方…」を空白区切り。
   * 聞き取りで名前が別の言葉になったとき、この一覧を見てエンジンが直す。
   *
   * 🔴 デスクトップ版（src/analyzeSettings.ts）と同じ項目だが、こちらは任意（?）にしてある。
   *    プラグイン版ではまだ画面にもエンジンにも繋がっていないので、既定値も sanitize も無い。
   *    エンジンへ繋ぐときに必須（cast: string）にし、SettingsScreen の既定値と sanitize に '' を足す
   *    （optional のまま textarea の value に渡すと controlled/uncontrolled の警告が出る）。
   *    通すには webui の SettingsScreen → bridge → Extension/PanelActions.swift →
   *    Extension/EngineClient.swift → App/EngineServer.swift（--cast）→
   *    engine/pac_fcp_engine/__main__.py → analyze.py の順に足す。
   */
  cast?: string
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
  /*
    日本語の自然な会話で最も誤りが少ないモデル（2026-02〜05 の公開ベンチマークで
    CER 0.140。large-v3-turbo は 0.184、kotoba-whisper は 0.495 で最下位だった）。
    🔴 語の時刻は別の整列モデルが出す（ダウンロードが2つになる）。
       Windows は NVIDIA の GPU が要る。Mac は Apple の GPU（mlx）で動く。
  */
  {
    name: 'qwen3-asr-1.7b',
    label: '最高 — Qwen3-ASR 1.7B',
    description:
      '日本語の自然な会話で、いちばん聞き取りの間違いが少ないモデルです。「高い」より一段良く、' +
      '語と語の間もきちんと取れるので、息継ぎでの分け方も良くなります。Windows は NVIDIA の GPU が要ります。',
    downloadSize: '4.6GB（本体 3.4GB＋語の時刻用 1.2GB）',
  },
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
