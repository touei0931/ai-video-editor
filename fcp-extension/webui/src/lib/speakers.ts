/**
 * 話者ごとの色。「誰が喋っているか」を声で見分け、登録した色でテロップを塗る。
 *
 * 見分ける本体は PAC 本体の sidecar/speakers.py（話者埋め込み）。
 * こちらは結果をテロップに落とし込む側。
 *
 * 🔴 「誰が喋ったか（色）」と「どう見せるか（スタイル）」は別の軸。
 *    色はテロップ1枚ごとの上書き（overrides.color）で持ち、スタイル（通常/強調）は触らない。
 *    以前 PAC 本体では人ごとにスタイルの枠を作って向けていたが、それだと
 *    「強調の見た目のまま、その人の色」が組めなかった（2026-09-11 に作り直し）。
 *
 * 🔴 自動で付けた色と、人が付けた色を区別すること（manualSpeaker）。
 *    見分け直したときに人が直したものまで上書きすると、直した意味が無くなる。
 *
 * 🔴 書体と大きさは全員同じにすること。色だけ変える。
 *    同じ人のテロップが枚ごとに別の書体で出ると、「誰の色か」より
 *    「なぜ書体が違うのか」が目立つ（2026-09-11、PAC 本体で指摘）。
 *
 * 🔴 ここは PAC 本体の src/telop/speakers.ts と同じ役目の、別の写し。
 *    型（Telop / TelopCard）が違うので共有していない。片方を直したら
 *    もう片方も見ること（splitTelop.ts と同じ扱い）。
 */

import type { IdentifyResult, SpeakerProfile, Telop, TelopStyle, VoiceGroup } from './types'

/** その人の色を上書きに写す。縁取りの色は登録に無ければ触らない */
export function withSpeakerColor(
  overrides: Partial<TelopStyle> | undefined,
  profile: SpeakerProfile,
): Partial<TelopStyle> {
  const next: Partial<TelopStyle> = { ...(overrides ?? {}), color: profile.color }
  if (profile.strokeColor) next.strokeColor = profile.strokeColor
  else delete next.strokeColor
  return next
}

/** 人の色を外す。大きさなど色以外の上書きは残す */
export function withoutSpeakerColor(
  overrides: Partial<TelopStyle> | undefined,
): Partial<TelopStyle> | undefined {
  if (!overrides) return undefined
  const rest = { ...overrides }
  delete rest.color
  delete rest.strokeColor
  return Object.keys(rest).length > 0 ? rest : undefined
}

/**
 * 見分けた結果をテロップに書き込む。
 *
 * - 当たった人がいれば、その人の色を上書きに（人が手で付けたものは触らない）
 * - 当たらなければ「声n」だけ付け、以前に自動で付けた人の色なら外す
 */
export function applyIdentification(
  telops: Telop[],
  result: IdentifyResult,
  profiles: SpeakerProfile[],
): Telop[] {
  const byProfile = new Map(profiles.map((p) => [p.id, p]))
  // 🔴 結果は「まとまり」単位。1枚ずつではなく、そのまとまりの全画面に配る
  const byId = new Map(result.units.map((u) => [u.id, u]))
  return telops.map((t) => {
    const u = byId.get(unitIdOf(t.id)) ?? byId.get(t.id)
    if (!u) return t
    if (t.manualSpeaker) {
      // 人が決めたものは動かさない。「声n」の印だけ外す
      return t.voice ? { ...t, voice: null } : t
    }
    const profile = u.speaker ? byProfile.get(u.speaker) : undefined
    if (profile) {
      return {
        ...t,
        speaker: profile.id,
        speakerScore: u.score,
        voice: null,
        overrides: withSpeakerColor(t.overrides, profile),
      }
    }
    return {
      ...t,
      speaker: null,
      speakerScore: u.score,
      voice: u.voice,
      // 前回は自動で人の色にしていた、という場合だけ外す
      overrides: t.speaker ? withoutSpeakerColor(t.overrides) : t.overrides,
    }
  })
}

/**
 * 人が「この声は◯◯」と決めたときの書き込み。以後は見分け直しても動かさない。
 * profile が null なら「誰でもない」に戻す（色も外す）。
 */
export function assignSpeaker(
  telops: Telop[],
  ids: Iterable<string>,
  profile: SpeakerProfile | null,
): Telop[] {
  const target = new Set(ids)
  return telops.map((t) => {
    if (!target.has(t.id)) return t
    if (profile) {
      return {
        ...t,
        speaker: profile.id,
        voice: null,
        manualSpeaker: true,
        overrides: withSpeakerColor(t.overrides, profile),
      }
    }
    return {
      ...t,
      speaker: null,
      voice: null,
      manualSpeaker: true,
      overrides: withoutSpeakerColor(t.overrides),
    }
  })
}

/**
 * 登録した人の色が変わったとき、その人のテロップを塗り直す。
 * 消えた人（profiles に無い）のテロップは色を外し、自動の判定に戻す。
 */
export function recolor(telops: Telop[], profiles: SpeakerProfile[]): Telop[] {
  const byProfile = new Map(profiles.map((p) => [p.id, p]))
  let changed = false
  const next = telops.map((t) => {
    if (!t.speaker) return t
    const p = byProfile.get(t.speaker)
    if (p) {
      const overrides = withSpeakerColor(t.overrides, p)
      if (
        overrides.color === t.overrides?.color &&
        overrides.strokeColor === t.overrides?.strokeColor
      ) {
        return t
      }
      changed = true
      return { ...t, overrides }
    }
    changed = true
    return { ...t, speaker: null, manualSpeaker: false, overrides: withoutSpeakerColor(t.overrides) }
  })
  return changed ? next : telops
}

/**
 * 画面の id から、元になった「まとまり」の id を取る（`t0007-2` → `t0007`）。
 * 割る側（splitTelop.ts）が付ける規則に合わせてある。
 */
export function unitIdOf(telopId: string): string {
  return telopId.replace(/-\d+$/, '')
}

/**
 * 声を見分けるために渡す区間。**まとまり単位**で1つにまとめる。
 *
 * 🔴 1画面ぶんで渡さないこと。
 *    声の特徴が取れるのは 0.6秒以上の区間だけ（sidecar/speakers.py の min_seconds）。
 *    テロップを息継ぎで割るようにしたため、画面は短く刻まれていて、実素材
 *    （VTuber のコラボ5本・画面 210枚）で**18% が 0.6秒未満**だった。
 *    割る前のまとまりなら 4〜6%。刻んだ区間は材料としても弱く、当たりにくい。
 *    まとまりで見分けて、結果はその全画面に配る（2026-10-19 に実測して変更）。
 *
 * 🔴 区間は**語の時刻**から作ること。
 *    テロップの表示時刻には余韻（+0.15秒）と最低表示時間（0.7秒）の
 *    引き伸ばしが入っている。その無音まで声として渡すと特徴が薄まる。
 */
export function unitsOf(telops: Telop[]): { id: string; src_start: number; src_end: number }[] {
  const byUnit = new Map<string, { start: number; end: number }>()
  for (const t of telops) {
    const key = unitIdOf(t.id)
    // 画面は元のまとまりの語を丸ごと持っている（splitTelop が複製する）
    const words = (t.words ?? []).filter((w) => w.text.trim())
    const start = words.length ? Math.min(...words.map((w) => w.srcStart)) : t.start
    const end = words.length ? Math.max(...words.map((w) => w.srcEnd)) : t.end
    const found = byUnit.get(key)
    byUnit.set(
      key,
      found
        ? { start: Math.min(found.start, start), end: Math.max(found.end, end) }
        : { start, end },
    )
  }
  return [...byUnit].map(([id, r]) => ({
    id,
    src_start: Number(r.start.toFixed(3)),
    src_end: Number(r.end.toFixed(3)),
  }))
}

/** まとまりの id から、その画面の id を集める */
export function screensOfUnits(telops: Telop[], unitIds: Iterable<string>): string[] {
  const want = new Set(unitIds)
  return telops.filter((t) => want.has(unitIdOf(t.id))).map((t) => t.id)
}


/**
 * 画面に出す声のまとまり。1枚だけの短いものは「その他」に寄せる。
 * 全部並べると、付ける手間が枚数ぶんになる。
 */
export function visibleVoices(voices: VoiceGroup[]): { shown: VoiceGroup[]; others: number } {
  const shown = voices.filter((v) => v.count >= 2 || v.seconds >= 1.5)
  const others = voices.filter((v) => !shown.includes(v)).reduce((n, v) => n + v.count, 0)
  return { shown, others }
}

/** 人ごとの枚数（画面に出す） */
export function countsBySpeaker(telops: Telop[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of telops) {
    if (t.speaker) out[t.speaker] = (out[t.speaker] ?? 0) + 1
  }
  return out
}

/**
 * 未登録の人に付ける色の候補。あとで選び直す前提の仮の色。
 * 🔴 白から始めないこと。通常と同じ色だと、登録しても何も変わって見えない。
 */
export const SPEAKER_COLORS = [
  '#7ec8ff',
  '#c59bff',
  '#ff9fb4',
  '#ffe14d',
  '#8ef0b0',
  '#ffb070',
  '#ffffff',
]

/** まだ使われていない色を選ぶ */
export function nextColor(profiles: SpeakerProfile[]): string {
  const used = new Set(profiles.map((p) => p.color.toLowerCase()))
  return SPEAKER_COLORS.find((c) => !used.has(c)) ?? SPEAKER_COLORS[0]
}
