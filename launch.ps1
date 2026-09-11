# PAC（デスクトップ版）を起動する。
#
# デスクトップの「PAC」アイコンと「アプリを起動.cmd」の両方がここを通る。
#
# 🔴 直したソースが必ず反映されるように、ソースが dist より新しければ組み直す。
#    毎回組み直すと起動に十数秒かかるので、変わっていなければ飛ばす。
# 🔴 判定と起動はここ（PowerShell）でやる。.cmd の中に長い PowerShell を書くと、
#    for /f の引用符とコードページの切り替えで壊れる（2026-09-11 に踏んだ）。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}

function Need-Build {
  $dist = Get-Item (Join-Path $root 'dist\index.html') -ErrorAction SilentlyContinue
  if (-not $dist) { return $true }
  $watch = @('src', 'electron', 'package.json') + (Get-ChildItem $root -Filter 'vite.config.*' | ForEach-Object { $_.Name })
  $newest = Get-ChildItem $watch -Recurse -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  return ($newest -and $newest.LastWriteTime -gt $dist.LastWriteTime)
}

if (Need-Build) {
  Write-Host 'ビルドしています...'
  & npm run build
  if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host 'ビルドに失敗しました。'
    Read-Host '閉じるには Enter'
    exit 1
  }
} else {
  Write-Host '変更が無いのでビルドを飛ばします。'
}

Write-Host 'アプリを起動します...'
# アイコンから開くときは開発ツールの別窓を出さない（electron/main/index.ts）
$env:PAC_NO_DEVTOOLS = '1'
& (Join-Path $root 'node_modules\.bin\electron.cmd') .
