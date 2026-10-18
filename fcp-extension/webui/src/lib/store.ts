// 画面の状態と、それを変える操作をまとめたところ。
// UI コンポーネントはここから受け取った関数を呼ぶだけにして、
// Swift とのやり取り（bridge.ts）に直接触らせない。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { splitTelops } from './splitTelop'
import {
  checkCuts,
  clearTitleTemplate,
  enrollSpeaker,
  identifySpeakers,
  listSpeakers,
  listSpeakerTemplates,
  loadProject,
  proofreadTelops,
  loadTitleTemplate,
  removeSpeaker,
  updateSpeaker,
} from './bridge'
import { applyIdentification, assignSpeaker, recolor, screensOfUnits, unitsOf } from './speakers'
import type {
  CutCandidate,
  Decision,
  ProjectState,
  ProofCandidate,
  StyleName,
  Telop,
  TelopStyle,
} from './types'

export interface Store {
  state: ProjectState | null
  /** カットの承認/却下 */
  decideCut: (id: string, decision: Decision) => void
  decideAllCuts: (decision: Decision) => void
  /** カットの区間を直す（タイムラインで端を掴んだとき） */
  updateCut: (id: string, patch: Partial<CutCandidate>) => void
  /** カットを当ててよいかを前後の発言から確かめる。返り値は画面に出すひとこと */
  checkCutSafety: (onProgress?: (stage: string, ratio: number) => void) => Promise<string>
  /** テロップの編集 */
  updateTelop: (id: string, patch: Partial<Telop>) => void
  addTelop: (telop: Telop) => void
  removeTelop: (id: string) => void
  /** 既定スタイルの編集 */
  updateStyle: (name: StyleName, patch: Partial<TelopStyle>) => void
  /** 承認済みのカットだけ */
  approvedCuts: CutCandidate[]
  /** テロップの見本を取り込む / 外す */
  pickTemplate: () => Promise<string | null>
  dropTemplate: () => Promise<void>
  /** 解析の結果で中身を入れ替える（スタイル・フォント・見本は保つ） */
  applyAnalysis: (result: Partial<ProjectState>, telopMaxChars?: number) => void
  /* ── 話者（喋っている人）ごとの色 ── */
  /** 登録の一覧を読み直す */
  refreshSpeakers: () => Promise<void>
  /** 声を見分けて色を付ける。返り値は画面に出すひとこと */
  identify: (onProgress?: (stage: string, ratio: number) => void) => Promise<string>
  /** 「声n」に名前と色を付けて覚える */
  nameVoice: (voiceId: string, name: string, color: string) => Promise<string>
  /** 1枚だけ話者を付け替える */
  setTelopSpeaker: (telopId: string, speakerId: string | null) => void
  /** 名前・色を変える / 覚えた声だけ忘れる */
  editSpeaker: (id: string, patch: { name?: string; color?: string; forget?: boolean }) => Promise<void>
  /** 登録を消す */
  forgetSpeaker: (id: string) => Promise<void>
  /** その人のテロップに使う見本を読み込む / 外す */
  pickSpeakerTemplate: (speakerId: string) => Promise<string | null>
  dropSpeakerTemplate: (speakerId: string) => Promise<void>
  /* ── 文字起こしの見直し ── */
  /** 前後の会話を読んで直し候補を出す。返り値は画面に出すひとこと */
  proofread: (
    args?: { names?: string; swaps?: string; onlyChecked?: boolean },
    onProgress?: (stage: string, ratio: number) => void,
  ) => Promise<string>
  /** 候補を1件採る */
  applyCandidate: (candidate: ProofCandidate) => void
  /** 候補を1件捨てる */
  dismissCandidate: (candidate: ProofCandidate) => void
  /** ひとつ前に戻す（Cmd+Z） */
  undo: () => void
  canUndo: boolean
}

export function useStore(): Store {
  const [state, setState] = useState<ProjectState | null>(null)

  /**
   * ひとつ前に戻すための控え。
   *
   * 直前の状態だけでなく少し遡れるようにしておく。テロップの手直しは
   * 「色を変えて、位置も動かして、やっぱり戻したい」と続くことが多い。
   */
  const history = useRef<ProjectState[]>([])
  const [canUndo, setCanUndo] = useState(false)

  /*
    いまの状態を同期的に読むための控え。
    🔴 非同期の操作（声を見分ける）で使う。setState の中から
       await すると、返ってきた時には古い状態を見ていることがある。
  */
  const stateRef = useRef<ProjectState | null>(null)
  stateRef.current = state

  /** 変更を加える前に、いまの状態を控えておく */
  const edit = useCallback((fn: (s: ProjectState) => ProjectState) => {
    setState((s) => {
      if (!s) return s
      history.current = [...history.current.slice(-49), s]
      setCanUndo(true)
      return fn(s)
    })
  }, [])

  const undo = useCallback(() => {
    setState((s) => {
      const prev = history.current.pop()
      if (!prev) return s
      setCanUndo(history.current.length > 0)
      return prev
    })
  }, [])

  useEffect(() => {
    let alive = true
    loadProject().then((p) => {
      if (alive) setState(p)
    })
    return () => {
      alive = false
    }
  }, [])

  const decideCut = useCallback(
    (id: string, decision: Decision) => {
      edit((s) => ({ ...s, cuts: s.cuts.map((c) => (c.id === id ? { ...c, decision } : c)) }))
    },
    [edit],
  )

  /**
   * まとめて決める。
   *
   * 🔴 「全部承認」では、切ると前後が繋がらなくなる候補を外すこと。
   *    独り言やフィラーを全部切ると、前後の関係が消えて話が分からなく
   *    なることがある（2026-10-19、利用者）。印が付いたものは pending の
   *    ままにして、1件ずつ見てもらう。「全部却下」は安全なので全部に当てる。
   */
  const decideAllCuts = useCallback(
    (decision: Decision) => {
      edit((s) => ({
        ...s,
        cuts: s.cuts.map((c) => {
          if (decision === 'approved' && (c.keepHint || c.cutVerdict?.cut === false)) return c
          return { ...c, decision }
        }),
      }))
    },
    [edit],
  )

  const updateCut = useCallback(
    (id: string, patch: Partial<CutCandidate>) => {
      edit((s) => ({ ...s, cuts: s.cuts.map((c) => (c.id === id ? { ...c, ...patch } : c)) }))
    },
    [edit],
  )

  const updateTelop = useCallback(
    (id: string, patch: Partial<Telop>) => {
      edit((s) => ({ ...s, telops: s.telops.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
    },
    [edit],
  )

  const addTelop = useCallback(
    (telop: Telop) => {
      edit((s) => ({ ...s, telops: [...s.telops, telop].sort((a, b) => a.start - b.start) }))
    },
    [edit],
  )

  const removeTelop = useCallback(
    (id: string) => {
      edit((s) => ({ ...s, telops: s.telops.filter((t) => t.id !== id) }))
    },
    [edit],
  )

  const updateStyle = useCallback(
    (name: StyleName, patch: Partial<TelopStyle>) => {
      edit((s) => ({ ...s, styles: { ...s.styles, [name]: { ...s.styles[name], ...patch } } }))
    },
    [edit],
  )

  /** 見本を取り込むと、既定スタイルも見本の見た目に合わせる（通常はそのまま、強調は色だけ変える） */
  const pickTemplate = useCallback(async () => {
    try {
      const t = await loadTitleTemplate()
      setState((s) => {
        if (!s) return s
        const face = t.fontFace ? `${t.font} ${t.fontFace}` : t.font
        /*
          🔴 見本が持っていない項目で、今の値を上書きしないこと。

             見本の text-style に font / fontSize が書かれていないことがある
             （Motion 側で決めている作り）。そのとき Swift は空文字と 0 を返す。
             それをそのまま入れていたため、パネルの既定（48px・ヒラギノ）が
             **0 と空文字で潰れ**、書き出した XML に fontSize が1つも
             入らなくなっていた。Final Cut は既定の極小サイズで描くので、
             「テロップが意味が分からないくらい小さい」になる
             （2026-09-01、見本 基本01_13 で発生）。
        */
        const font = face.trim() || s.styles.normal.fontFamily
        const size = t.fontSize > 0 ? t.fontSize : s.styles.normal.fontSize
        return {
          ...s,
          template: t,
          styles: {
            normal: { ...s.styles.normal, fontFamily: font, fontSize: size, bold: t.bold, color: '#ffffff' },
            emphasis: {
              ...s.styles.emphasis,
              fontFamily: font,
              // 強調は通常より少し大きいまま保つ（見本が大きさを持っていないときも）
              fontSize: t.fontSize > 0 ? t.fontSize : s.styles.emphasis.fontSize,
              bold: t.bold,
            },
          },
        }
      })
      return t.effectName
    } catch (e) {
      return null
    }
  }, [])

  const dropTemplate = useCallback(async () => {
    await clearTitleTemplate()
    setState((s) => (s ? { ...s, template: null } : s))
  }, [])

  /*
    素材の高さに対する、テロップの文字の大きさ。

    🔴 決め打ちの px にしないこと。
       既定を 48px にしていたため、縦4K（3840）でも 1080p でも同じ 48px で
       書き出していた。友達の見本（基本01_10）は 3840 の枠で 167px、
       つまり高さの 4.35%。48px は 1080p ではほぼ同じ割合になるが、
       大きい枠では文字が豆粒になる（2026-09-02）。
       見本が大きさを持っていれば、そちらが優先される。
  */
  const TELOP_HEIGHT_RATIO = { normal: 0.045, emphasis: 0.056 }

  const applyAnalysis = useCallback((result: Partial<ProjectState>, telopMaxChars?: number) => {
    setState((s) => {
      // 解析が返すのは素材そのものの情報だけ。
      // 見た目の設定と見本は利用者が決めたものなので上書きしない。
      const base = s ?? null
      /*
        🔴 エンジンが返すのは「文のまとまり」で、1画面に出す量ではない。
           そのまま並べると 40文字・25秒のテロップになり、文節の途中でも切れる。
           ここで1画面ぶんに割り直す（splitTelop.ts）。
      */
      const telops = splitTelops(result.telops ?? [], telopMaxChars)
      if (!base) return { ...(result as ProjectState), telops }
      /*
        🔴 見本が大きさを持っていないときは、素材の高さから決めること。
           持っているときは触らない（見た目を写すのが見本の役目）。
      */
      const h = result.height ?? base.height ?? 0
      const fromTemplate = (base.template?.fontSize ?? 0) > 0
      const styles =
        h > 0 && !fromTemplate
          ? {
              ...base.styles,
              normal: { ...base.styles.normal, fontSize: Math.round(h * TELOP_HEIGHT_RATIO.normal) },
              emphasis: {
                ...base.styles.emphasis,
                fontSize: Math.round(h * TELOP_HEIGHT_RATIO.emphasis),
              },
            }
          : base.styles

      return {
        ...base,
        styles,
        videoUrl: result.videoUrl ?? base.videoUrl,
        // 🔴 素材の大きさとコマ数を落とさないこと。落とすと書き出しが決め打ちに戻る
        width: result.width ?? base.width,
        height: result.height ?? base.height,
        fps: result.fps ?? base.fps,
        durationSec: result.durationSec ?? base.durationSec,
        waveform: result.waveform ?? base.waveform,
        cuts: result.cuts ?? [],
        telops,
        /*
          🔴 「声n」の一覧は捨てること。あれは前の素材のテロップ id を指している。
             残すと、別の動画で「覚える」を押したときに1枚も当たらない
             （どのテロップのことか分からないまま覚えることになる）。
             登録した人（speakers）は動画をまたいで使うので残す。
        */
        voices: [],
        speakerReport: undefined,
        // 🔴 落とさないこと。素材の大きさが読めなかった理由がここにしかない
        report: result.report ?? base.report,
      }
    })
  }, [])

  /*
    ── 話者（喋っている人）ごとの色 ─────────────────────────

    🔴 色は「1枚ごとの上書き」として持つ（lib/speakers.ts 参照）。
       スタイル（通常/強調）は触らないので、見た目の既定を後から変えても付いてくる。

    🔴 覚えた声はエンジン側（Application Support）にある。
       こちらが持つのは画面に出すための写しだけなので、
       操作のたびに返ってきた一覧で入れ替える。
  */

  /** 登録の一覧と、話者ごとの見本を読み直す（⑤テロップで話者の欄を開いたとき） */
  const refreshSpeakers = useCallback(async () => {
    try {
      const [r, templates] = await Promise.all([listSpeakers(), listSpeakerTemplates()])
      setState((s) => (s ? { ...s, speakers: r.speakers, speakerTemplates: templates } : s))
    } catch {
      // 読めなくても画面は出す（登録が無いのと見分けがつかないが、操作はできる）
    }
  }, [])

  /** 声を見分ける。返り値は画面に出すひとこと（失敗の理由もここに入る） */
  const identify = useCallback(
    async (onProgress?: (stage: string, ratio: number) => void): Promise<string> => {
      const current = stateRef.current
      if (!current || current.telops.length === 0) return 'テロップがありません'
      try {
        const result = await identifySpeakers(unitsOf(current.telops), onProgress)
        edit((s) => ({
          ...s,
          speakers: result.speakers,
          voices: result.voices,
          speakerReport: {
            matched: result.matched,
            unknown: result.unknown,
            tooShort: result.tooShort,
            backend: result.backend,
          },
          telops: applyIdentification(s.telops, result, result.speakers),
        }))
        if (result.speakers.length === 0) {
          return `${result.voices.length}人ぶんの声に分かれました。名前を付けると色が付きます`
        }
        /*
          🔴 数の単位は「か所（まとまり）」。枚ではない。
             見分けは文のまとまりごとに1回で、結果はそのまとまりの全画面に配る。
             「枚」と書くと、画面の枚数と合わなくて混乱する。
        */
        const short = result.tooShort > 0 ? `。短くて判別できない所 ${result.tooShort}か所` : ''
        return `${result.matched}か所に色が付きました（当たらなかった声 ${result.unknown}か所）${short}`
      } catch (e) {
        /*
          🔴 理由をそのまま画面に出すこと。
             声のモデル（40MB）や部品が同梱から漏れていると、ここに
             「見つかりません」が入る。黙って 0 件にすると
             「1人しか喋っていない動画なのかも」と誤解したまま終わる。
        */
        const message = (e as { message?: string })?.message
        return message ? `見分けられませんでした：${message}` : '見分けられませんでした'
      }
    },
    [edit],
  )

  /**
   * 「この声は◯◯」と決める。その声の区間を覚えてから、人に結び付ける。
   *
   * 🔴 覚える前に結び付けないこと。覚えていないと、次の動画で同じ声が来ても当たらない。
   *
   * 🔴 同じ名前なら**同じ人に足すこと**。新しい人を作らない。
   *    同じ人の声は「叫び声の組」と「落ち着いた声の組」に分かれる（2026-09-11 の実測）。
   *    両方に同じ名前を入れたときに別人が2人できると、色も別色になり、
   *    「一部分しか色が付かない」ことになる。
   *
   * 🔴 覚えたら、そのまま見分け直すこと。
   *    以前は覚えた声の分だけ色が付き、残りは利用者がもう一度
   *    「声を見分ける」を押すまで無色のままだった（押さなければ一部分しか付かない）。
   */
  const nameVoice = useCallback(
    async (voiceId: string, name: string, color: string): Promise<string> => {
      const current = stateRef.current
      const voice = current?.voices?.find((v) => v.id === voiceId)
      if (!current || !voice) return 'その声が見つかりません'
      const wanted = name.trim()
      if (!wanted) return '名前を入れてください'
      const existing = (current.speakers ?? []).find((p) => p.name.trim() === wanted)

      const ranges = unitsOf(current.telops)
        .filter((u) => voice.unitIds.includes(u.id))
        // 長い区間ほど声の特徴が出る。上限は覚えすぎを防ぐため（エンジン側も 32 まで）
        .sort((a, b) => b.src_end - b.src_start - (a.src_end - a.src_start))
        .slice(0, 16)
        .map((u) => ({ src_start: u.src_start, src_end: u.src_end }))

      try {
        const r = existing
          ? await enrollSpeaker({ id: existing.id, ranges })
          : await enrollSpeaker({ name: wanted, color, ranges })
        const ids = screensOfUnits(current.telops, voice.unitIds)
        edit((s) => ({
          ...s,
          speakers: r.speakers,
          voices: (s.voices ?? []).filter((v) => v.id !== voiceId),
          telops: assignSpeaker(s.telops, ids, r.speaker),
        }))
        const added = existing
          ? `${wanted} に声を ${r.added}本 足しました`
          : `${wanted} を覚えました（声 ${r.added}本）`
        // 覚えた声で、残りにも当たるか見る
        const note = await identify()
        return `${added}。${note}`
      } catch (e) {
        const message = (e as { message?: string })?.message
        return message ? `覚えられませんでした：${message}` : '覚えられませんでした'
      }
    },
    [edit, identify],
  )

  /** 1枚ずつ「この人」に付け替える（自動の判定より人の指定を優先する） */
  const setTelopSpeaker = useCallback(
    (telopId: string, speakerId: string | null) => {
      edit((s) => {
        const profile = speakerId ? (s.speakers ?? []).find((p) => p.id === speakerId) ?? null : null
        return { ...s, telops: assignSpeaker(s.telops, [telopId], profile) }
      })
    },
    [edit],
  )

  /** 名前と色を変える。色を変えたら、その人のテロップを塗り直す */
  const editSpeaker = useCallback(
    async (id: string, patch: { name?: string; color?: string; forget?: boolean }) => {
      const r = await updateSpeaker({ id, ...patch })
      edit((s) => ({ ...s, speakers: r.speakers, telops: recolor(s.telops, r.speakers) }))
    },
    [edit],
  )

  /** 登録を消す。そのテロップは色を外して自動の判定に戻す */
  const forgetSpeaker = useCallback(
    async (id: string) => {
      const r = await removeSpeaker(id)
      edit((s) => ({
        ...s,
        speakers: r.speakers,
        telops: recolor(s.telops, r.speakers),
      }))
    },
    [edit],
  )

  /*
    ── 文字起こしの見直し ─────────────────────────────

    🔴 候補を自動で当てないこと。テロップは発言の引用で、小さいモデルは
       「もっともらしい別の台詞」を作る。1件ずつ人が採る。
  */

  /** 前後の会話を読んで直し候補を出す。返り値は画面に出すひとこと */
  const proofread = useCallback(
    async (
      args: { names?: string; swaps?: string; onlyChecked?: boolean } = {},
      onProgress?: (stage: string, ratio: number) => void,
    ): Promise<string> => {
      const current = stateRef.current
      if (!current || current.telops.length === 0) return 'テロップがありません'
      const onlyIds = args.onlyChecked
        ? current.telops.filter((t) => t.needsCheck).map((t) => t.id)
        : undefined
      if (args.onlyChecked && (!onlyIds || onlyIds.length === 0)) {
        return '「要確認」の印が付いたテロップがありません'
      }
      try {
        const r = await proofreadTelops(
          {
            telops: current.telops.map((t) => ({ id: t.id, text: t.text })),
            names: args.names,
            swaps: args.swaps,
            onlyIds,
          },
          onProgress,
        )
        edit((s) => ({ ...s, proofCandidates: r.candidates ?? [] }))
        if (r.error) return `見直せませんでした：${r.error}`
        const n = (r.candidates ?? []).length
        return n === 0
          ? `${r.checked ?? 0}か所を見ましたが、直す所は見つかりませんでした`
          : `${n}件の候補が見つかりました（${r.checked ?? 0}か所を確認）`
      } catch (e) {
        const message = (e as { message?: string })?.message
        return message ? `見直せませんでした：${message}` : '見直せませんでした'
      }
    },
    [edit],
  )

  /** 候補を1件採る（その語だけ置き換える） */
  const applyCandidate = useCallback(
    (candidate: ProofCandidate) => {
      edit((s) => ({
        ...s,
        telops: s.telops.map((t) =>
          t.id === candidate.id && t.text.includes(candidate.before)
            ? {
                ...t,
                text: t.text.replace(candidate.before, candidate.after),
                // 直したのだから、印は外す（残すと何度も見返すことになる）
                needsCheck: false,
                checkReasons: undefined,
                // 🔴 一部だけの見た目（spans）は文字位置で持っている。
                //    本文の長さが変わると指す場所がずれるので捨てる
                spans: candidate.before.length === candidate.after.length ? t.spans : undefined,
              }
            : t,
        ),
        proofCandidates: (s.proofCandidates ?? []).filter((c) => c !== candidate),
      }))
    },
    [edit],
  )

  /** 候補を1件捨てる */
  const dismissCandidate = useCallback(
    (candidate: ProofCandidate) => {
      edit((s) => ({
        ...s,
        proofCandidates: (s.proofCandidates ?? []).filter((c) => c !== candidate),
      }))
    },
    [edit],
  )

  /**
   * カットを当ててよいかを、前後の発言から確かめる。
   *
   * 🔴 判断（切る/残す）は書き換えない。見立てを添えるだけで、決めるのは人。
   *    ここで自動的に却下まですると、「確かめたら勝手に残っていた」になる。
   */
  const checkCutSafety = useCallback(
    async (onProgress?: (stage: string, ratio: number) => void): Promise<string> => {
      const current = stateRef.current
      if (!current || current.cuts.length === 0) return 'カット候補がありません'
      const spoken = current.cuts.filter((c) => c.kind !== 'silence')
      if (spoken.length === 0) return '言葉が消えるカット候補はありません（無音だけです）'
      try {
        const r = await checkCuts({ candidates: current.cuts }, onProgress)
        const hints = new Map((r.flagged ?? []).map((f) => [f.id, f]))
        const verdicts = new Map((r.verdicts ?? []).map((v) => [v.id, v]))
        edit((s) => ({
          ...s,
          cuts: s.cuts.map((c) => {
            const hint = hints.get(c.id)
            const verdict = verdicts.get(c.id)
            if (!hint && !verdict) return c
            return {
              ...c,
              keepHint: hint ? { risk: hint.risk as 'high' | 'medium', reason: hint.reason } : c.keepHint,
              cutVerdict: verdict ? { cut: verdict.cut, reason: verdict.reason } : c.cutVerdict,
            }
          }),
        }))
        if (r.error) return `確かめられませんでした：${r.error}`
        const keep = (r.verdicts ?? []).filter((v) => !v.cut).length
        return keep === 0
          ? `${r.checked ?? 0}件を確かめました。どれも切って大丈夫そうです`
          : `${r.checked ?? 0}件のうち ${keep}件は残した方がよさそうです（「全部承認」からは外れます）`
      } catch (e) {
        const message = (e as { message?: string })?.message
        return message ? `確かめられませんでした：${message}` : '確かめられませんでした'
      }
    },
    [edit],
  )

  /**
   * その人のテロップに使う見本を読み込む。
   *
   * 🔴 既定の見本は置き換えないこと。ここで割り当てた人のテロップだけ、
   *    その見本で出す。割り当てていない人と、声が短くて分からなかった
   *    テロップは既定の見本で出る。
   */
  const pickSpeakerTemplate = useCallback(async (speakerId: string): Promise<string | null> => {
    try {
      const t = await loadTitleTemplate(speakerId)
      setState((s) =>
        s ? { ...s, speakerTemplates: { ...(s.speakerTemplates ?? {}), [speakerId]: t } } : s,
      )
      return t.effectName
    } catch {
      return null
    }
  }, [])

  /** その人の見本を外す（既定の見本に戻る） */
  const dropSpeakerTemplate = useCallback(async (speakerId: string) => {
    const map = await clearTitleTemplate(speakerId)
    setState((s) => (s ? { ...s, speakerTemplates: map } : s))
  }, [])

  const approvedCuts = useMemo(
    () => (state ? state.cuts.filter((c) => c.decision === 'approved') : []),
    [state],
  )

  return {
    state,
    decideCut,
    decideAllCuts,
    updateCut,
    checkCutSafety,
    updateTelop,
    addTelop,
    removeTelop,
    updateStyle,
    approvedCuts,
    pickTemplate,
    dropTemplate,
    applyAnalysis,
    refreshSpeakers,
    identify,
    nameVoice,
    setTelopSpeaker,
    editSpeaker,
    forgetSpeaker,
    pickSpeakerTemplate,
    dropSpeakerTemplate,
    proofread,
    applyCandidate,
    dismissCandidate,
    undo,
    canUndo,
  }
}

/**
 * 再生位置の管理。
 * 動画がある時は video 要素が時計、無い時（開発中）は requestAnimationFrame が時計。
 * どちらでも同じように playhead が動くようにしておく。
 */
export function usePlayback(
  durationSec: number,
  videoEl: HTMLVideoElement | null,
  /** 承認したカット。再生中はここを飛ばす（切ったあとの繋がりを確かめるため） */
  skips: { start: number; end: number }[] = [],
  /**
   * 再生速度。書き出しに指定するものと同じ値を渡す。
   *
   * 🔴 time（再生位置）は**素材の時刻のまま**にすること。
   *    速度で割ると、テロップの出る位置がずれる。
   *    速いのは実時間の進み方であって、素材の中の位置ではない。
   */
  speed = 1,
) {
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const raf = useRef<number | null>(null)
  const last = useRef<number>(0)

  // 速度は video 要素に任せる（再生位置は素材の時刻のまま進む）
  useEffect(() => {
    if (!videoEl) return
    videoEl.playbackRate = speed > 0 ? speed : 1
  }, [videoEl, speed])

  // 動画がある場合は video 要素に追従する
  useEffect(() => {
    if (!videoEl) return
    const onTime = () => setTime(videoEl.currentTime)
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    videoEl.addEventListener('timeupdate', onTime)
    videoEl.addEventListener('play', onPlay)
    videoEl.addEventListener('pause', onPause)
    return () => {
      videoEl.removeEventListener('timeupdate', onTime)
      videoEl.removeEventListener('play', onPlay)
      videoEl.removeEventListener('pause', onPause)
    }
  }, [videoEl])

  // 動画が無い場合は自前で時間を進める
  useEffect(() => {
    if (videoEl || !playing) return
    last.current = performance.now()
    const tick = (now: number) => {
      // パネルが隠れている間 requestAnimationFrame は止まる。
      // 復帰したときに「隠れていた時間」がまるごと加算されて
      // 再生位置が飛ぶので、1フレーム分の上限をかける。
      const dt = Math.min(0.25, (now - last.current) / 1000) * (speed > 0 ? speed : 1)
      last.current = now
      setTime((t) => {
        const next = t + dt
        if (next >= durationSec) {
          setPlaying(false)
          return durationSec
        }
        return next
      })
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current)
    }
  }, [playing, durationSec, videoEl])

  // 承認したカットに入ったら、その終わりまで飛ばす。
  // 「切ったあとどう繋がるか」を確かめるのがレビューの目的なので、
  // 切ると決めた区間を再生してしまうと確認にならない。
  const skipRef = useRef(skips)
  skipRef.current = skips
  useEffect(() => {
    if (!playing) return
    const hit = skipRef.current.find((c) => time >= c.start && time < c.end - 0.02)
    if (!hit) return
    const to = Math.min(durationSec, hit.end)
    setTime(to)
    if (videoEl) videoEl.currentTime = to
  }, [time, playing, videoEl, durationSec])

  const seek = useCallback(
    (t: number) => {
      const clamped = Math.max(0, Math.min(durationSec, t))
      setTime(clamped)
      if (videoEl) videoEl.currentTime = clamped
    },
    [durationSec, videoEl],
  )

  /** 終わりまで再生し切っていたら、頭から流し直す */
  const rewindIfEnded = useCallback(() => {
    if (time < durationSec - 0.05) return
    setTime(0)
    if (videoEl) videoEl.currentTime = 0
  }, [time, durationSec, videoEl])

  const play = useCallback(() => {
    rewindIfEnded()
    if (videoEl) void videoEl.play()
    else setPlaying(true)
  }, [videoEl, rewindIfEnded])

  const toggle = useCallback(() => {
    if (videoEl) {
      if (videoEl.paused) {
        rewindIfEnded()
        void videoEl.play()
      } else {
        videoEl.pause()
      }
    } else {
      setPlaying((p) => {
        if (!p) rewindIfEnded()
        return !p
      })
    }
  }, [videoEl, rewindIfEnded])

  return { time, playing, seek, toggle, play }
}
