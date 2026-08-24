# PAC for Final Cut Pro — Workflow Extension

PAC（Prep Auto Cut）を **Final Cut Pro のウィンドウ内パネル**として動かすための実装。
現在は **M1: 疎通確認フェーズ**（パネルが出るかどうかだけを見る最小構成）。

要件と調査結果 → [`../docs/requirements-fcp-extension.md`](../docs/requirements-fcp-extension.md)

## 構成

```
fcp-extension/
├── project.yml          XcodeGen 定義（.xcodeproj は commit せず CI で生成）
├── App/                 コンテナアプリ（拡張の入れ物。/Applications に置く必要がある）
├── Extension/           Workflow Extension 本体（.appex になる）
├── scripts/
│   ├── build.sh            xcodegen + xcodebuild
│   ├── adhoc-sign.sh       アドホック署名（$99/年を使わない署名）
│   └── check_extension.sh  配布前の関門
└── deliver/             友達に渡すもの（インストーラ兼診断スクリプト）
```

## 前提

**Workflow Extensions SDK が必要**（Apple の公開ダウンロード。Apple ID でログインすれば無料）:
<https://developer.apple.com/download/all/?q=WorkflowExtensions>

インストール先は `/Library/Developer/SDKs/WorkflowExtensionSDK.sdk`。
`project.yml` の `ADDITIONAL_SDKS` がここを見る。

Apple の SDK は再配布できないので、この public リポジトリには置かない。

**ビルドは private リポジトリ [`touei0931/pac-fcp-build`](https://github.com/touei0931/pac-fcp-build) で回す。**
あちらが SDK を持っていて、こちらのコードを checkout してビルドする。
（public 側に PAT を置かずに済ませるための構成。Actions → build → Run workflow）

## 実装上の要点（実際に出荷されている TheAcharya/MarkerData から確認）

- 拡張ポイント: `com.apple.FinalCut.WorkflowExtension`
- 主クラスのキーは **`ProExtensionPrincipalViewControllerClass`**
  （`NSExtensionPrincipalClass` ではない。ネット上の解説記事に誤りが多い）
- リンカ: `-fapplication-extension` と `-lProExtension`、`MACH_O_TYPE = mh_execute`
- entitlements に **`com.apple.security.app-sandbox` が必須**。
  無いと Gatekeeper が `plug-ins must be sandboxed` で弾き、FCP のメニューに出ない
- `com.apple.security.cs.disable-library-validation` が無いと拡張が読み込まれない事例が多い

## この実験で確かめたいこと

**アドホック署名（`codesign --sign -`）の拡張を PluginKit が登録するか。**

- 登録される → 費用ゼロのままパネル型を続行できる
- されない → Developer ID（$99/年）が必須。案A（PAC本体強化＋FCPXML）へ切り替え

アドホック署名は Team ID を持たないため、登録されない可能性が高いと見ている。
それを $0 で白黒つけるのがこのフェーズ。
