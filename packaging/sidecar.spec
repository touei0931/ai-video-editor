# -*- mode: python ; coding: utf-8 -*-
"""Python サイドカーを PyInstaller で固める（Phase 0 T4 / T5）。

onedir にする理由:
  onefile は起動のたびに一時ディレクトリへ展開するため、
  推論ライブラリのような巨大な依存があると起動が数秒〜十数秒遅くなる。
  サイドカーはアプリ起動時に立ち上げっぱなしにするので、onedir が適切。

🔴 **このフォルダの中で実行すること。**

    $ cd packaging
    $ pyinstaller sidecar.spec --noconfirm --distpath ../dist-sidecar --workpath ../build-sidecar

    下の pathex=[".."] は**実行時のカレントからの相対**なので、
    リポジトリ直下で走らせるとリポジトリの外を指す。すると sidecar パッケージが
    同梱されず、固めたバイナリが起動時に
    ModuleNotFoundError: No module named 'sidecar' で落ちる。
    固める作業自体は成功してしまうので、**動かして初めて分かる**。

    --distpath も必ず付ける。既定の dist/ は Vite の出力先なので、
    そのあとの vite build に消される。
"""

from PyInstaller.utils.hooks import collect_all

datas: list = []
binaries: list = []
hiddenimports: list = []

# 推論まわりはデータファイルやネイティブDLLを大量に持つので、まとめて拾う。
# 足りないと「固めた後だけ動かない」という一番厄介な壊れ方をする。
for package in (
    "faster_whisper",
    "ctranslate2",
    "av",
    "tokenizers",
    "huggingface_hub",
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
    ["sidecar_entry.py"],
    pathex=[".."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports + ["sidecar", "sidecar.worker", "sidecar.heavy"],
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        # レンダラ側でしか使わないもの・巨大で不要なものを落とす
        "tkinter",
        "matplotlib",
        "PyQt5",
        "PySide6",
        "IPython",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # UPX は誤検知の原因になるので使わない
    console=True,  # stdio でやり取りするので必須
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="sidecar",
)
