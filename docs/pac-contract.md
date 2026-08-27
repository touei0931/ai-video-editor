# PAC 本体との約束

FCP プラグインの解析エンジンは、PAC 本体（`sidecar/`）の処理を
**コピーせず import して**使っている。判定の中身は作り込みの塊なので、
写すと二重管理になって必ず片方が腐る。

そのかわり、**借りている入口の形**が変わるとプラグインが壊れる。
PAC 本体を触るときに気をつけるのはここだけ。中の判定ロジックは
どれだけ作り変えても影響しない。

借りている場所: `fcp-extension/engine/pac_fcp_engine/analyze.py`

---

## 借りている5つ

| 呼ぶもの | 渡すもの | 返ってくるもので使うところ |
|---|---|---|
| `sidecar.asr.make_asr()` | なし | `.transcribe(...)` を持っていること |
| `.transcribe(wav, model=, language=, on_progress=)` | 引数名そのまま | `duration` / `segments[].words[].text` |
| `sidecar.clean.clean_transcript(transcript)` | 文字起こし | `dropped` / `speech_ratio` |
| `sidecar.cut.detect_candidates(transcript, options)` | 文字起こしと設定 | `candidates` / `word_count` |
| `sidecar.telop.build_units(transcript, wav_path=, options=)` | 文字起こしと設定 | `telops` |

### `candidates` の1件

```
id          そのまま使う
src_start   元素材の秒
src_end     元素材の秒
kind        silence / filler / restate のどれか
text        無くてもよい（無音には入らない）
confidence  0〜1
```

### `telops` の1件

```
id          そのまま使う
src_start   元素材の秒
src_end     元素材の秒
text        本文
style       normal / emphasis / note のどれか
```

---

## 壊れ方は2つある

### 1. ビルドが赤くなる（気づける）

関数名・引数名・キー名を変えた場合。
`fcp-extension/engine/tests/test_engine.py` が**実物の sidecar を呼んで**いるので、
プラグインをビルドし直すと必ず止まる。CI の2つのワークフローが両方これを走らせる。

直すのは `analyze.py` と `mapping.py` の2箇所で済むことがほとんど。

### 2. 黙って減る（気づきにくい）

**新しい種類が増えた場合**。たとえば `kind` に4つ目、`style` に3つ目が増えたとき、
プラグインはそれを知らないので通せない。名前は変わっていないので、テストは通る。

これは `mapping.py` が理由をログと解析結果（`report.unknown`）に残すようにしてある。
新種を足したら、ここも一緒に足すこと:

- `mapping.py` の `_KINDS`
- `mapping.py` の `_STYLE_MAP`
- テロップの見た目を増やすなら、パネル側の雛形（`webui/src/lib/types.ts` の `TelopStyle`）も

---

## 配布済みのものには影響しない

エンジンは PyInstaller で固めるとき、`sidecar/` のコピーを中に取り込む。
つまり**固めた時点のもの**が友達の Mac で動く。
PAC 本体を今後どう変えても、すでに配ったものは変わらない。
影響が出るのは**次にビルドし直したとき**だけ。

---

## FCPXML は借りていない

`sidecar/fcpxml.py`（デスクトップ版の書き出し）は使っていない。
プラグインは `fcp-extension/Extension/FCPXMLWriter.swift` で自前に書き出す。
テンプレートの丸写しや、文字ごとの見た目の指定など、あちらには無い都合があるため。

両方に同じ落とし穴があるので、片方で見つけたら**もう片方も見ること**:

- `<library>` に `name` は無い
- `<sequence>` の中に置けるのは `<spine>` だけ（`text-style-def` は `<title>` の中）
- `<title>` の中の並びは `param` → `adjust-transform` → `text` → `text-style-def`
- `text-style-def` の `id` は書類の中で1つきり
