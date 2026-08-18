#!/usr/bin/env python3
"""LGPL ビルドの ffmpeg / ffprobe を vendor/ffmpeg/ に用意する（Phase 0 T3）。

🔴 x264 / x265 を含むビルドは**絶対に使わない**（GPL 汚染。収益化時に致命的・§13.1）。
取得後は必ず scripts/verify_ffmpeg.py で構成を検証すること。

調達方針:
  - Windows: BtbN/FFmpeg-Builds の **lgpl** バリアント（x264/x265 非搭載）
  - macOS arm64: **自前ビルド**（.github/workflows/build-ffmpeg-mac.yml）
      信頼でき、かつ最新の LGPL 既製ビルドが見当たらなかったため。
      ビルド済みバイナリは本リポジトリの Release に置き、ここから取得する。

    $ python scripts/fetch_ffmpeg.py
"""

from __future__ import annotations

import argparse
import hashlib
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _console import enable_utf8  # noqa: E402

enable_utf8()

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor" / "ffmpeg"

# BtbN の release タグ。"latest" は自動更新されるので、
# 再現性が要るときは固定タグに変えること。
BTBN_BASE = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest"
BTBN_WIN64 = "ffmpeg-n8.1-latest-win64-lgpl-8.1.zip"

# macOS 版は自前ビルドの成果物を本リポジトリの Release から取る。
MAC_RELEASE_TAG = os.environ.get("FFMPEG_MAC_TAG", "ffmpeg-lgpl-mac-arm64")
MAC_ASSET = "ffmpeg-lgpl-macos-arm64.tar.gz"
REPO = os.environ.get("GITHUB_REPOSITORY", "touei0931/ai-video-editor")


def target() -> str:
    system = platform.system()
    machine = platform.machine().lower()
    if system == "Windows":
        return "windows"
    if system == "Darwin" and machine in ("arm64", "aarch64"):
        return "macos-arm64"
    sys.exit(f"未対応の環境です: {system}/{machine}（対象は Windows x64 と macOS arm64）")


def download(url: str, dest: Path) -> None:
    print(f"ダウンロード: {url}")
    with urllib.request.urlopen(url) as res, dest.open("wb") as f:
        shutil.copyfileobj(res, f)
    print(f"  → {dest.stat().st_size / 1024 / 1024:.1f} MB")


def extract_binaries(archive: Path, work: Path) -> list[Path]:
    """アーカイブを展開し、ffmpeg / ffprobe の実体を探して返す。"""
    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive) as z:
            z.extractall(work)
    else:
        with tarfile.open(archive) as t:
            t.extractall(work)

    wanted = {"ffmpeg", "ffmpeg.exe", "ffprobe", "ffprobe.exe"}
    return [p for p in work.rglob("*") if p.is_file() and p.name in wanted]


def fetch_windows(work: Path) -> list[Path]:
    archive = work / BTBN_WIN64
    download(f"{BTBN_BASE}/{BTBN_WIN64}", archive)
    return extract_binaries(archive, work / "x")


def verify_sha256(archive: Path, sha_file: Path) -> None:
    """配布バイナリなので取得後にハッシュを検証する。"""
    expected = sha_file.read_text(encoding="utf-8").split()[0].strip()
    actual = hashlib.sha256(archive.read_bytes()).hexdigest()
    if actual != expected:
        sys.exit(
            f"SHA256 が一致しません。取得したファイルが壊れているか差し替えられています。\n"
            f"  期待値: {expected}\n"
            f"  実際  : {actual}"
        )
    print(f"  SHA256 検証 OK ({actual[:16]}…)")


def fetch_macos(work: Path) -> list[Path]:
    # 🔴 このリポジトリは private なので、Release アセットの直リンクは 404 になる。
    #    gh 経由なら認証付きで取得できる（CI では GH_TOKEN、手元では gh のログインを使う）。
    archive = work / MAC_ASSET
    sha_file = work / f"{MAC_ASSET.replace('.tar.gz', '')}.sha256"

    if shutil.which("gh"):
        print(f"gh で取得: {REPO} {MAC_RELEASE_TAG}")
        result = subprocess.run(
            ["gh", "release", "download", MAC_RELEASE_TAG,
             "--repo", REPO,
             "--pattern", MAC_ASSET,
             "--pattern", sha_file.name,
             "--dir", str(work)],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            sys.exit(
                f"macOS 版の取得に失敗しました:\n{result.stderr.strip()}\n\n"
                "まだビルドしていない場合は、GitHub Actions で build-ffmpeg-mac を実行してください:\n"
                "  gh workflow run build-ffmpeg-mac.yml\n"
                "CI で失敗する場合は、ジョブに GH_TOKEN が渡っているか確認してください。"
            )
    else:
        url = f"https://github.com/{REPO}/releases/download/{MAC_RELEASE_TAG}/{MAC_ASSET}"
        try:
            download(url, archive)
        except Exception as e:  # noqa: BLE001
            sys.exit(
                f"macOS 版の取得に失敗しました: {e}\n"
                "private リポジトリのため、gh CLI を入れて認証してください。"
            )

    if archive.exists() and sha_file.exists():
        verify_sha256(archive, sha_file)

    return extract_binaries(archive, work / "x")


def main() -> int:
    parser = argparse.ArgumentParser(description="LGPL ビルドの ffmpeg を用意する")
    parser.add_argument("--force", action="store_true", help="既にあっても取り直す")
    args = parser.parse_args()

    plat = target()
    exe = ".exe" if plat == "windows" else ""

    if (VENDOR / f"ffmpeg{exe}").exists() and not args.force:
        print(f"既に存在します: {VENDOR / f'ffmpeg{exe}'}（取り直すなら --force）")
        return 0

    VENDOR.mkdir(parents=True, exist_ok=True)

    with TemporaryDirectory() as tmp:
        work = Path(tmp)
        found = fetch_windows(work) if plat == "windows" else fetch_macos(work)

        if not found:
            sys.exit("アーカイブに ffmpeg / ffprobe が見つかりませんでした")

        for src in found:
            dst = VENDOR / src.name
            shutil.copy2(src, dst)
            if not exe:
                dst.chmod(0o755)
            print(f"配置: {dst}")

    print("\n構成を検証します…")
    return subprocess.run([sys.executable, str(ROOT / "scripts" / "verify_ffmpeg.py")]).returncode


if __name__ == "__main__":
    raise SystemExit(main())
