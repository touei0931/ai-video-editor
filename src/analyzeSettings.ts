/**
 * 解析を始める前に決めること（②設定）。
 *
 * 🔴 FCP プラグイン版（fcp-extension/webui/src/lib/types.ts の AnalyzeSettings）と
 *    項目と言葉を揃えること。友達はプラグイン版で覚えているので、
 *    同じものが別の名前で並ぶと「こっちには無い」と受け取られる。
 *
 * 🔴 sidecar が受け取れるものだけを置く。
 *    ここに項目を足しても、heavy.py の analyze / redetect に渡さなければ
 *    黙って既定で解析され、「設定したのに効かない」の形でしか現れない
 *    （プラグイン版で実際に起きた。2026-08-31）。
 */

import type { PacePreset } from './review/ReviewScreen';

export type AsrModel = 'large-v3-turbo' | 'medium' | 'small' | 'base';
export type AnalyzeLanguage = 'ja' | 'en' | 'auto';

export interface AnalyzeSettings {
  language: AnalyzeLanguage;
  model: AsrModel;
  /** 間の詰め具合。解析のあとでも「カット」画面で変えられる */
  pace: PacePreset;
  /** 話の本筋と繋がっていないひとりごとも候補に挙げるか */
  detectAside: boolean;
  /** 自分の口ぐせ。読点・空白・改行のどれで区切ってもよい */
  extraFillers: string;
  /**
   * 書き出す再生速度（1 = 等倍）。
   *
   * 🔴 解析には関係しない。書き出し（動画・字幕・Final Cut 用）にだけ効く。
   *    あとで速度を変えるとテロップの位置がずれるので、ここで決めて
   *    テロップごと一緒に付いてくるようにする（プラグイン版と同じ扱い）。
   */
  exportSpeed: number;
}

export const DEFAULT_ANALYZE_SETTINGS: AnalyzeSettings = {
  language: 'ja',
  model: 'large-v3-turbo',
  // 既定は「ふつう」。詰めた設定を長尺に当てると、意図して置いた間まで消える
  pace: 'talk',
  // 必ず人が1件ずつ見る側に入るので、既定で挙げる
  detectAside: true,
  extraFillers: '',
  exportSpeed: 1,
};

/** 書き出す速度の範囲（%）。プラグイン版と同じ */
export const EXPORT_SPEED_RANGE = { min: 25, max: 400 };

export const LANGUAGES: { code: AnalyzeLanguage; label: string }[] = [
  { code: 'ja', label: '日本語' },
  { code: 'en', label: '英語' },
  { code: 'auto', label: '自動で判定する' },
];

/** モデルの選択肢。初回のダウンロード量を必ず添える（無反応に見えて強制終了されるため） */
export const MODELS: { name: AsrModel; label: string; description: string; downloadSize: string }[] = [
  {
    name: 'large-v3-turbo',
    label: '高い（おすすめ） — large-v3-turbo',
    description: '一番きれいに文字起こしできます。',
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
];

/**
 * 間の詰め具合。左ほど間を残し、右ほど詰まる。
 * 🔴 sidecar/cut.py の PRESETS と名前を合わせること。無い名前は黙って既定に戻る。
 */
export const PACE_PRESETS: { name: PacePreset; label: string; description: string }[] = [
  { name: 'loose', label: 'ゆったり', description: '間をしっかり残します。落ち着いた解説向けです。' },
  {
    name: 'talk',
    label: 'ふつう（おすすめ）',
    description: '10〜20分の解説や実況向け。意図して置いた間は残ります。',
  },
  { name: 'short', label: 'テンポよく', description: 'ショート動画向け。短い間もどんどん候補に挙げます。' },
  {
    name: 'tight',
    label: 'とにかく詰める',
    description: '息継ぎくらいの間まで候補に挙げます。切る所は増えますが、判断も増えます。',
  },
];

export const PACE_LABEL: Record<PacePreset, string> = {
  loose: 'ゆったり',
  talk: 'ふつう',
  short: 'テンポよく',
  tight: 'とにかく詰める',
};

const STORAGE_KEY = 'pac.analyzeSettings';

/** 形の分からないものから、分かる項目だけ受け取る。残りは既定 */
export function sanitizeAnalyzeSettings(raw: unknown): AnalyzeSettings {
  const d = DEFAULT_ANALYZE_SETTINGS;
  if (!raw || typeof raw !== 'object') return { ...d };
  const r = raw as Record<string, unknown>;
  const language = LANGUAGES.some((l) => l.code === r.language)
    ? (r.language as AnalyzeLanguage)
    : d.language;
  const model = MODELS.some((m) => m.name === r.model) ? (r.model as AsrModel) : d.model;
  const pace = PACE_PRESETS.some((p) => p.name === r.pace) ? (r.pace as PacePreset) : d.pace;
  const detectAside = typeof r.detectAside === 'boolean' ? r.detectAside : d.detectAside;
  const extraFillers = typeof r.extraFillers === 'string' ? r.extraFillers : d.extraFillers;
  const exportSpeed = clampSpeed(typeof r.exportSpeed === 'number' ? r.exportSpeed : d.exportSpeed);
  return { language, model, pace, detectAside, extraFillers, exportSpeed };
}

/** 速度を範囲に収める。数でなければ等倍 */
export function clampSpeed(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const pct = Math.round(v * 100);
  return Math.min(EXPORT_SPEED_RANGE.max, Math.max(EXPORT_SPEED_RANGE.min, pct)) / 100;
}

/**
 * 前回の設定を読む。
 * 🔴 壊れていても例外を投げないこと。設定が読めなくても解析はできるべき。
 */
export function loadAnalyzeSettings(): AnalyzeSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return sanitizeAnalyzeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_ANALYZE_SETTINGS };
  }
}

export function saveAnalyzeSettings(s: AnalyzeSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // 保存できなくても、この場の解析には効くので止めない
  }
}

/**
 * sidecar のカット検出（detect_candidates）へ渡す options。
 * 🔴 analyze と redetect の**両方**で同じものを渡すこと。
 *    片方にだけ渡すと、詰め具合を変えた瞬間に口ぐせと独り言の設定が既定へ戻る。
 */
export function cutOptionsOf(s: Pick<AnalyzeSettings, 'pace' | 'detectAside' | 'extraFillers'>): {
  preset: PacePreset;
  detect_aside: boolean;
  extra_fillers: string;
} {
  return { preset: s.pace, detect_aside: s.detectAside, extra_fillers: s.extraFillers };
}

/** 口ぐせを一覧にする。読点・空白・改行のどれで区切ってもよい */
export function splitFillers(text: string): string[] {
  return text
    .split(/[、,，\s\n]+/)
    .map((w) => w.trim())
    .filter(Boolean);
}
