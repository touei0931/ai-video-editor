# -*- mode: python ; coding: utf-8 -*-
"""解析エンジンを PyInstaller で固める。

作りは PAC 本体の packaging/sidecar.spec に倣う（同じ落とし穴を踏まないため）。

onedir にする理由:
  onefile は起動のたびに一時ディレクトリへ展開するので、推論ライブラリのような
  巨大な依存があると起動が数秒〜十数秒遅くなる。

🔴 **このフォルダの中で実行すること。**

    $ cd fcp-extension/engine/packaging
    $ pyinstaller engine.spec --noconfirm \
        --distpath ../../build-engine/dist --workpath ../../build-engine/work

    下の pathex は**実行時のカレントからの相対**。別の場所で走らせると
    pac_fcp_engine や sidecar が同梱されず、固めたバイナリが起動時に
    ModuleNotFoundError で落ちる。**固める作業自体は成功してしまう**ので、
    動かして初めて分かる壊れ方をする。
"""

from PyInstaller.utils.hooks import collect_all

datas: list = []
binaries: list = []
hiddenimports: list = []

# 推論まわりはデータファイルやネイティブライブラリを大量に持つので、まとめて拾う。
# 足りないと「固めた後だけ動かない」という一番厄介な壊れ方をする。
for package in (
    "faster_whisper",
    "ctranslate2",
    "av",
    "tokenizers",
    "huggingface_hub",
    "onnxruntime",
):
    try:
        d, b, h = collect_all(package)
    except Exception as e:  # noqa: BLE001
        print(f"[spec] {package} を収集できませんでした: {e}")
        continue
    datas += d
    binaries += b
    hiddenimports += h

a = Analysis(
    ["engine_entry.py"],
    # ".." = fcp-extension/engine（pac_fcp_engine がある）
    # "../../.." = リポジトリのルート（sidecar がある。PAC 本体のコードを読むだけ）
    pathex=["..", "../../.."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports
    + [
        "pac_fcp_engine",
        "pac_fcp_engine.analyze",
        "pac_fcp_engine.mapping",
        "pac_fcp_engine.waveform",
        "sidecar",
        "sidecar.cut",
        # 🔴 動的に import するものは、ここに書かないと固めたバイナリに入らない。
        #    書き忘れても import に失敗するだけなので、
        #    受け側が黙って既定値に倒れると**誰も気づけない**（実際に起きた）。
        "sidecar.media",
        "sidecar.clean",
        "sidecar.telop",
        "sidecar.asr",
        "sidecar.asr.faster_whisper_backend",
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        # 使わないもの・巨大で不要なものを落とす
        "tkinter",
        "matplotlib",
        "PyQt5",
        "PySide6",
        "IPython",
        "torch",
        "torchaudio",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="pac-engine",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # UPX は誤検知の原因になるので使わない
    console=True,  # 進捗を標準エラーに流すので必須
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="pac-engine",
)
