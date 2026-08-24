# 要件定義書: PAC for Final Cut Pro (Workflow Extension 化)

作成日: 2026-08-25 / 対象: PAC (Prep Auto Cut) の FCP プラグイン版

## 概要

既存のスタンドアロンアプリ PAC を、**Final Cut Pro の画面の中にパネルとして常駐する
Workflow Extension** に作り替える。友達が FCP から離れずに「自動カット」「自動文字起こし
→テロップ」をレビューし、そのままタイムラインへ反映できる状態を目指す。

## ユーザー・利用者

- 実利用者: 友達（MacBook Air M2 / 24GB、Final Cut Pro 12.0、IT知識なし）
- 開発者: 本人（Windows + RTX 5070 Ti、**Mac 実機なし**）

## 機能要件

### Must（必須）

- FCP のウィンドウ内にパネルとして表示される（ウィンドウ > エクステンション から起動）
- 素材（または FCP の現在のプロジェクト）を読み込み、以下を自動検出する
  - 無音区間
  - フィラー語（「えー」「あのー」等）
  - 言い直し
- 検出結果をパネル上で人間が承認/却下できる（PAC のレビュー体験を踏襲）
- 自動文字起こしの結果を**テロップ（タイトルクリップ）**として出力する
  - 字幕（キャプション）トラックではなくタイトル。見た目は友達のテロップテンプレ
    「基本01_10」(MP_テロップパック) の effect uid を丸写しして完全一致させる（AutoTelop の手法）
- 承認済みの編集結果を **FCPXML 1.13** で FCP のタイムラインへ送り込む（`sendFCPXML`）
- 友達の Mac に**インストールできる形**で配布する（.dmg または .pkg、ドラッグ&ドロップ）

### Want（あれば嬉しい）

- ズーム・画角の自動化（PAC の未着手機能③）
- FCP 側で選択中のクリップ範囲だけを処理対象にする
- 処理の中断・再開、作業状態の保存（PAC 実装済み機能の移植）

## 非機能要件

- パフォーマンス: 40分素材が M2 Air（24GB）で完走すること。**実機がないため未実測**
- 設計の主軸は精度ではなく**レビュー速度**（友達のペイン = カット作業に1本30〜60分）
- プレビューとタイムライン反映は**同じ描画コード**を通す（PAC の `drawTelop` / `resolveStyle` / `buildLines`）

## 技術スタック（案）

- 拡張本体: Swift + AppKit/SwiftUI の App Extension（ProExtension SDK）
- UI: **WKWebView で PAC の既存 Web UI（React）をそのまま読み込む**
  → Swift での UI 全面書き直しを回避する
- 処理エンジン: 既存サイドカー（Python / faster-whisper large-v3-turbo + Silero VAD + ffmpeg）
  - 拡張はサンドボックス制約でプロセスを自由に起動できない可能性があるため、
    **コンテナアプリ側でエンジンを常駐させ、拡張とはローカル IPC で通信**する構成を前提とする
- ビルド: GitHub Actions の macOS ランナーで `xcodebuild`（public リポジトリなので課金 0）
- 署名: アドホック署名（`codesign --sign -`）。Apple Developer Program は使わない

## スコープ外

- FxPlug（エフェクト/トランジション）としての実装 — タイムラインを編集できないため不可
- Mac App Store 配布
- Premiere Pro / DaVinci Resolve 対応
- x264 / x265 / Ultralytics YOLO の使用（ライセンス上、収益化のため不採用）

## 制約・前提条件

- 🔴 **費用ゼロ**。Apple Developer Program（$99/年）は使わない
- 🔴 **Mac 実機なし**。Xcode の GUI は使えず、プロジェクトファイルは手書き＋CI ビルドで進める
- 🔴 **FCP 上での動作確認ができるのは友達の Mac だけ**。PAC で2度踏んだ
  「CI は通るのに友達の環境で動かない」（Homebrew 依存の ffmpeg / 配布時のパス解決）が
  再発しやすい構造。検査は「動くか」ではなく「何に依存しているか」「配布した形で動くか」で行う
- FCPXML は FCP 12 = 1.13 固定。本物の DTD で事前検証する

## 未決事項（着手前に潰す必要がある）

1. **ProExtension SDK を無料で入手できるか** ← 最大のゲート
   Workflow Extension のビルドには Apple から個別提供される SDK が必要。
   申請に Apple Developer Program（有料）が必須かどうかを確認する。
   有料必須なら「パネル型」は成立せず、方針を作り直す。
2. **アドホック署名の App Extension を FCP が読み込むか**
   macOS の pluginkit が拡張を検出する条件、Apple Silicon での署名要件。
   開発者証明書なしで通るかは要検証。
3. 拡張がサンドボックス必須か。必須なら Python サイドカー/ffmpeg の起動経路をどう確保するか
4. WKWebView で既存 React UI を再利用する際の IPC 設計（Electron の IPC 置き換え）
5. 既存 PAC（スタンドアロン版）を残すか、拡張版に一本化するか

## マイルストーン（案）

- M0: 上記「未決事項 1〜2」を確定させる（コードは書かない。ここで不可なら計画変更）
- M1: 最小の Workflow Extension（パネルに Hello と出す）を CI でビルドし、友達の FCP で表示確認
- M2: 拡張 ⇔ エンジンの IPC 疎通、`sendFCPXML` でダミークリップをタイムラインに送る
- M3: 自動カットの移植
- M4: 文字起こし→テロップの移植

---

# M0 調査結果 (2026-08-25)

## ゲート1: ProExtension SDK は無料で入手できるか → ほぼ ○

- Workflow Extensions SDK は **Apple Developer サイトの公開ダウンロード**にある
  （`developer.apple.com/download/all/?q=WorkflowExtensions`）。個別申請・NDA は不要になっている。
- 無料の Apple ID（＝無料デベロッパアカウント）で「ソフトウェアダウンロード・ドキュメント・
  サンプルコード」にはアクセスできる。**$99 が要るのは配布・公証・TestFlight 側**。
- ただし実際のダウンロードは Apple ID ログインが要るため、**本人が試して確認する**必要がある（5分）。
  Windows からでも zip はダウンロードできる。
- SDK には Xcode の「Final Cut Pro Workflow Extension」テンプレートと ProExtension フレームワークが入る。
- 既知の落とし穴: Xcode 16 以降、リンカオプション `-e_ProExtensionMain` を `-e _ProExtensionMain`
  （スペース必須）に直さないとビルドが通らない。SDK 側は未修正。

## ゲート2: アドホック署名で友達の Mac に入るか → ✗ 黒に近い灰色

- **App Extension はサンドボックス必須**。署名時に `com.apple.security.app-sandbox` を付けないと
  Gatekeeper が `plug-ins must be sandboxed` で拒否し、FCP のメニューに出ない。
- アドホック署名（`codesign --sign -`）は **Team ID を持たない**。macOS 15 以降、App Group
  コンテナ保護などが Team ID ベースで動くため、拡張として登録される保証がない。
- 実在する Workflow Extension は例外なく **Developer ID 署名＋公証**か **Mac App Store** 配布。
- 無料アカウントの Personal Team では **Developer ID 証明書を発行できない＝公証もできない**。
  他人の Mac に配る前提だと、$99/年が事実上の必須条件になる。

→ **「FCP内パネル × 費用ゼロ × 他人のMacへ配布」は、そろわない可能性が濃厚。**

## 副次的に判明した設計上の制約

- **拡張もコンテナアプリも両方サンドボックス**。FCP のライブラリフォルダには直接アクセスできない。
- そのため現行 PAC の構成（Electron＋Python サイドカー＋ローカルファイル自由アクセス）は
  そのままでは載らない。素材はユーザー選択／ドラッグ&ドロップ経由で受け取る設計に変える必要がある。
- 拡張が読み込まれない時の定番対処: 署名の「Disable Library Validation」を有効化、
  Apple Silicon ではコンテナアプリを一度 /Applications から起動してから FCP を開く。

## 次の分岐（要判断）

- 案A: パネル型を諦め、PAC本体を強化して FCPXML 連携を磨く（費用ゼロ・実現は確実）
- 案B: $99/年を払ってパネル型に進む（Mac実機なしのデバッグ難易度は別途残る）
- 案C: **$0 のまま1回だけ実験する** — 最小の拡張（パネルに Hello と出すだけ）を
  アドホック署名＋サンドボックス entitlement で CI ビルドし、友達の Mac に入れて
  「ウィンドウ > エクステンション」に出るか見る。出れば全部生きる／出なければ案Aへ落ちる。

---

# 決定 (2026-08-25): 案C — $0 のまま1回だけ実験する

最小の Workflow Extension を作り、アドホック署名で友達の Mac に入れて
「ウィンドウ > エクステンション」に出るかを見る。実装は `fcp-extension/` に配置済み。

## この実験が答える唯一の問い

**アドホック署名（Team ID なし）の App Extension を、macOS の PluginKit が登録するか。**

- YES → 費用ゼロのままパネル型を継続（M2 以降へ）
- NO  → Developer ID（$99/年）が必須と確定 → 案A（PAC本体強化 + FCPXML）へ切り替え

## 実装で確定させた事実（TheAcharya/MarkerData の実装から確認、推測ではない）

| 項目 | 値 |
|---|---|
| 拡張ポイント | `com.apple.FinalCut.WorkflowExtension` |
| 主クラスのキー | `ProExtensionPrincipalViewControllerClass`（`NSExtensionPrincipalClass` は誤り） |
| SDK の設置先 | `/Library/Developer/SDKs/WorkflowExtensionSDK.sdk`（`ADDITIONAL_SDKS` で参照） |
| リンカ | `-fapplication-extension` / `-lProExtension` |
| バンドル | `WRAPPER_EXTENSION = appex` / `MACH_O_TYPE = mh_execute` |
| 必須 entitlement | `com.apple.security.app-sandbox`（無いと `plug-ins must be sandboxed` で弾かれる） |
| 事実上必須 | `com.apple.security.cs.disable-library-validation` |

## 残っている手作業（touei がやる必要があるもの）

1. Apple ID でログインして Workflow Extensions SDK をダウンロード
   <https://developer.apple.com/download/all/?q=WorkflowExtensions>
   （**ここで $99 を要求されたらゲート1が崩れる。その時点で案Aへ**）
2. private リポジトリを作り、その SDK ファイルを Release にアップロード
   （Apple の SDK を public な ai-video-editor に置かないため）
3. ai-video-editor に Secrets を設定: `WFE_SDK_REPO` / `WFE_SDK_TAG` / `WFE_SDK_TOKEN`
4. `build-fcp-extension` ワークフローを実行 → 成果物を友達へ

## 判定基準

友達から返ってくる `PAC診断結果.txt` の `pluginkit -mAvvv -p com.apple.FinalCut.WorkflowExtension` に
PAC の行が出るかどうかが答え。メニューに出なくても、この出力があれば原因を切り分けられる。
