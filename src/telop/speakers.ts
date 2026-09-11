/**
 * 話者ごとの色。「誰が喋っているか」を声で見分け、登録した色でテロップを塗る。
 *
 * 見分ける本体は sidecar/speakers.py（話者埋め込み）。こちらは結果を
 * テロップと雛形に落とし込む側。
 *
 * 🔴 色は「1枚ごとの上書き」ではなく**雛形の枠**として持つこと。
 *    並べる画面（タイムライン）のテロップは雛形の名前しか持たない。
 *    上書きで塗ると、タイムラインに送った瞬間に色が消える。
 *    人ごとに `slot-spk-<id>` の枠を作り、テロップの style をそこへ向ければ、
 *    プレビュー・書き出し・Final Cut 用・タイムラインのどれでも同じ色で出る。
 *    枠は「通常」を土台にして色だけ変える（利用者の選択: 色だけ）。
 *
 * 🔴 自動で付けた色と、人が付けた色を区別すること（manualSpeaker）。
 *    見分け直したときに、人が直したものまで上書きすると、直した意味が無くなる。
 */

import type { TelopCard } from './split';
import { isBuiltinStyle, type StyleMap, type TelopStyle } from './style';

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

/** 人ごとの枠の名前。`slot-` で始めると、雛形の一覧と数字キーにそのまま並ぶ */
export const SPEAKER_STYLE_PREFIX = 'slot-spk-';

export function speakerStyleName(speakerId: string): string {
  return `${SPEAKER_STYLE_PREFIX}${speakerId}`;
}

/** その枠が「人ごとの枠」なら持ち主の id */
export function speakerOfStyle(styleName: string): string | null {
  return styleName.startsWith(SPEAKER_STYLE_PREFIX)
    ? styleName.slice(SPEAKER_STYLE_PREFIX.length)
    : null;
}

/**
 * 登録した人ごとの枠を、今の雛形に足す（あれば名前と色を今の登録に合わせる）。
 *
 * 🔴 土台は「通常」。書体・大きさ・位置は通常と同じで、色だけ人の色。
 *    通常を直せば全員に効く。
 * 🔴 縁取りの色は、登録に無ければ通常のまま。
 */
export function withSpeakerStyles(styles: StyleMap, profiles: SpeakerProfile[]): StyleMap {
  const next: StyleMap = { ...styles };
  let changed = false;
  for (const p of profiles) {
    const name = speakerStyleName(p.id);
    const base: TelopStyle = next[name] ?? structuredClone(next.normal);
    const stroke = p.strokeColor
      ? { ...(base.stroke ?? next.normal.stroke ?? { color: '#000000', widthRatio: 0.16 }), color: p.strokeColor }
      : base.stroke;
    const want: TelopStyle = { ...base, label: p.name.slice(0, 12), color: p.color, stroke };
    if (
      !next[name] ||
      next[name].label !== want.label ||
      next[name].color !== want.color ||
      next[name].stroke?.color !== want.stroke?.color
    ) {
      next[name] = want;
      changed = true;
    }
  }
  return changed ? next : styles;
}

/**
 * 見分けた結果をテロップに書き込む。
 *
 * - 当たった人がいれば style を人の枠へ（人が手で付けたものは触らない）
 * - 当たらなければ voice（声n）だけ付け、以前に自動で付けた人の枠なら通常へ戻す
 */
export function applyIdentification(
  cards: TelopCard[],
  result: IdentifyResult,
  profiles: SpeakerProfile[],
): TelopCard[] {
  const known = new Set(profiles.map((p) => p.id));
  const byId = new Map(result.units.map((u) => [u.id, u]));
  return cards.map((c) => {
    const u = byId.get(c.id);
    if (!u) return c;
    if (c.manualSpeaker) {
      // 人が決めたものは動かさない。声nの印だけ外す
      return c.voice ? { ...c, voice: null } : c;
    }
    if (u.speaker && known.has(u.speaker)) {
      return {
        ...c,
        speaker: u.speaker,
        speakerScore: u.score,
        voice: null,
        style: speakerStyleName(u.speaker),
      };
    }
    // 当たらなかった。前回自動で人の枠にしていたなら、通常へ戻す
    const wasSpeaker = speakerOfStyle(c.style) !== null;
    return {
      ...c,
      speaker: null,
      speakerScore: u.score,
      voice: u.voice,
      style: wasSpeaker ? 'normal' : c.style,
    };
  });
}

/**
 * 人が「この声は◯◯」と決めたときの書き込み。以後は自動で動かさない。
 * speakerId が null なら「誰でもない」に戻す（枠も通常へ）。
 */
export function assignSpeaker(
  cards: TelopCard[],
  ids: Iterable<string>,
  speakerId: string | null,
): TelopCard[] {
  const target = new Set(ids);
  return cards.map((c) => {
    if (!target.has(c.id)) return c;
    if (speakerId) {
      return { ...c, speaker: speakerId, voice: null, manualSpeaker: true, style: speakerStyleName(speakerId) };
    }
    const style = speakerOfStyle(c.style) !== null || !isBuiltinStyle(c.style) ? 'normal' : c.style;
    return { ...c, speaker: null, voice: null, manualSpeaker: true, style };
  });
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
