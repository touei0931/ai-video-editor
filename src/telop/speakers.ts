/**
 * 話者ごとの色。「誰が喋っているか」を声で見分け、登録した色でテロップを塗る。
 *
 * 見分ける本体は sidecar/speakers.py（話者埋め込み）。こちらは結果を
 * テロップに落とし込む側。
 *
 * 🔴 「誰が喋ったか（色）」と「どう見せるか（雛形）」は別の軸。
 *    色はテロップ1枚ごとの上書き（override.color）で持ち、雛形（通常／強調）は触らない。
 *    強調した話し方のときは強調の雛形のまま、その人の色で出る。
 *    以前は人ごとに雛形の枠を作って style を向けていたが、それだと
 *    「強調＋その人の色」が組めない（2026-09-11 に指摘）。
 *    並べる画面のテロップも override を持てるようにしたので、送っても色は消えない。
 *
 * 🔴 自動で付けた色と、人が付けた色を区別すること（manualSpeaker）。
 *    見分け直したときに、人が直したものまで上書きすると、直した意味が無くなる。
 */

import type { TelopCard } from './split';
import type { TelopOverride } from './style';

/** 登録した人（覚えた声の持ち主）。画面に渡る形。埋め込みは含まない */
export interface SpeakerProfile {
  id: string;
  name: string;
  /** #rrggbb */
  color: string;
  strokeColor?: string | null;
  /** 覚えている声の数（区間の数） */
  samples: number;
  updated?: string;
}

/** 誰にも当たらなかった声のまとまり */
export interface VoiceGroup {
  id: string;
  count: number;
  seconds: number;
  /** 聞いて確かめる用。いちばん長い区間 */
  sample: { id: string; src_start: number; src_end: number } | null;
  unitIds: string[];
}

export interface IdentifyResult {
  units: { id: string; speaker: string | null; score: number; voice: string | null }[];
  voices: VoiceGroup[];
  speakers: SpeakerProfile[];
  matched: number;
  unknown: number;
  tooShort: number;
}

/**
 * 見分ける側（sidecar）への口。素材の audio.wav は呼び出し側（App）が結び付ける。
 * テロップ画面はこれを通してだけ sidecar に触る。
 */
export interface SpeakerService {
  identify(units: { id: string; src_start: number; src_end: number }[]): Promise<IdentifyResult>;
  enroll(args: {
    id?: string;
    name?: string;
    color?: string;
    ranges: { src_start: number; src_end: number }[];
  }): Promise<{ speaker: SpeakerProfile; added: number; speakers: SpeakerProfile[] }>;
  update(args: {
    id: string;
    name?: string;
    color?: string;
    strokeColor?: string | null;
    forget?: boolean;
  }): Promise<{ speakers: SpeakerProfile[] }>;
  remove(id: string): Promise<{ speakers: SpeakerProfile[] }>;
  list(): Promise<{ speakers: SpeakerProfile[]; backend: string }>;
}

/** window.app.speakers を SpeakerService の形にする。wav は解析が作った audio.wav */
export function makeSpeakerService(
  call: (params: Record<string, unknown>) => Promise<unknown>,
  wavPath: string,
): SpeakerService {
  return {
    identify: (units) => call({ op: 'identify', wav_path: wavPath, units }) as Promise<IdentifyResult>,
    enroll: (args) =>
      call({ op: 'enroll', wav_path: wavPath, ...args }) as Promise<{
        speaker: SpeakerProfile;
        added: number;
        speakers: SpeakerProfile[];
      }>,
    update: (args) => call({ op: 'update', ...args }) as Promise<{ speakers: SpeakerProfile[] }>,
    remove: (id) => call({ op: 'delete', id }) as Promise<{ speakers: SpeakerProfile[] }>,
    list: () => call({ op: 'list' }) as Promise<{ speakers: SpeakerProfile[]; backend: string }>,
  };
}

/** その人の色を上書きに写す。縁取りの色は登録に無ければ触らない */
export function withSpeakerColor(
  override: TelopOverride | undefined,
  profile: SpeakerProfile,
): TelopOverride {
  const next: TelopOverride = { ...(override ?? {}), color: profile.color };
  if (profile.strokeColor) next.strokeColor = profile.strokeColor;
  else delete next.strokeColor;
  return next;
}

/** 人の色を外す。大きさなど色以外の上書きは残す */
export function withoutSpeakerColor(override: TelopOverride | undefined): TelopOverride | undefined {
  if (!override) return undefined;
  const rest = { ...override };
  delete rest.color;
  delete rest.strokeColor;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/**
 * 見分けた結果をテロップに書き込む。
 *
 * - 当たった人がいれば、その人の色を上書きに（人が手で付けたものは触らない）
 * - 当たらなければ voice（声n）だけ付け、以前に自動で付けた人の色なら外す
 */
export function applyIdentification(
  cards: TelopCard[],
  result: IdentifyResult,
  profiles: SpeakerProfile[],
): TelopCard[] {
  const byProfile = new Map(profiles.map((p) => [p.id, p]));
  const byId = new Map(result.units.map((u) => [u.id, u]));
  return cards.map((c) => {
    const u = byId.get(c.id);
    if (!u) return c;
    if (c.manualSpeaker) {
      // 人が決めたものは動かさない。声nの印だけ外す
      return c.voice ? { ...c, voice: null } : c;
    }
    const profile = u.speaker ? byProfile.get(u.speaker) : undefined;
    if (profile) {
      return {
        ...c,
        speaker: profile.id,
        speakerScore: u.score,
        voice: null,
        override: withSpeakerColor(c.override, profile),
      };
    }
    // 当たらなかった。前回自動で人の色にしていたなら外す
    return {
      ...c,
      speaker: null,
      speakerScore: u.score,
      voice: u.voice,
      override: c.speaker ? withoutSpeakerColor(c.override) : c.override,
    };
  });
}

/**
 * 人が「この声は◯◯」と決めたときの書き込み。以後は自動で動かさない。
 * profile が null なら「誰でもない」に戻す（色も外す）。
 */
export function assignSpeaker(
  cards: TelopCard[],
  ids: Iterable<string>,
  profile: SpeakerProfile | null,
): TelopCard[] {
  const target = new Set(ids);
  return cards.map((c) => {
    if (!target.has(c.id)) return c;
    if (profile) {
      return {
        ...c,
        speaker: profile.id,
        voice: null,
        manualSpeaker: true,
        edited: true,
        override: withSpeakerColor(c.override, profile),
      };
    }
    return {
      ...c,
      speaker: null,
      voice: null,
      manualSpeaker: true,
      edited: true,
      override: withoutSpeakerColor(c.override),
    };
  });
}

/**
 * 登録した人の色が変わったとき、その人のテロップを塗り直す。
 * 消えた人（profiles に無い）のテロップは色を外し、自動の判定に戻す。
 */
export function recolor(cards: TelopCard[], profiles: SpeakerProfile[]): TelopCard[] {
  const byProfile = new Map(profiles.map((p) => [p.id, p]));
  let changed = false;
  const next = cards.map((c) => {
    if (!c.speaker) return c;
    const p = byProfile.get(c.speaker);
    if (p) {
      const override = withSpeakerColor(c.override, p);
      if (override.color === c.override?.color && override.strokeColor === c.override?.strokeColor) return c;
      changed = true;
      return { ...c, override };
    }
    changed = true;
    return { ...c, speaker: null, manualSpeaker: false, override: withoutSpeakerColor(c.override) };
  });
  return changed ? next : cards;
}

/** テロップから「見分ける」に渡す区間 */
export function unitsOf(cards: TelopCard[]): { id: string; src_start: number; src_end: number }[] {
  return cards.map((c) => ({ id: c.id, src_start: c.srcStart, src_end: c.srcEnd }));
}

/** 画面に出す声のまとまり。1枚だけの短いものは「その他」に寄せる */
export function visibleVoices(voices: VoiceGroup[]): { shown: VoiceGroup[]; others: number } {
  const shown = voices.filter((v) => v.count >= 2 || v.seconds >= 1.5);
  const others = voices.filter((v) => !shown.includes(v)).reduce((n, v) => n + v.count, 0);
  return { shown, others };
}

/**
 * 未登録の人に付ける色の候補。VTuber の見た目に合わせて選び直す前提の仮の色。
 * 🔴 白から始めないこと。通常と同じ色だと、登録しても何も変わって見えない。
 */
export const SPEAKER_COLOR_CANDIDATES = [
  '#7ec8ff',
  '#c59bff',
  '#ff9fb4',
  '#ffe14d',
  '#8ef0b0',
  '#ffb070',
  '#ffffff',
];
