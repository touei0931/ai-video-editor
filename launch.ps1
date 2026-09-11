# PAC（デスクトップ版）を起動する。
#
# デスクトップの「PAC」アイコン（launch.vbs 経由・窓なし）と
# 「アプリを起動.cmd」（コンソールあり）の両方がここを通る。
#
# 🔴 直したソースが必ず反映されるように、ソースが dist より新しければ組み直す。
#    毎回組み直すと起動に十数秒かかるので、変わっていなければ飛ばす。
# 🔴 判定と起動はここ（PowerShell）でやる。.cmd の中に長い PowerShell を書くと、
#    for /f の引用符とコードページの切り替えで壊れる（2026-09-11 に踏んだ）。
# 🔴 このファイルは UTF-8 の BOM 付きで保存すること。無いと Windows PowerShell 5.1 が
#    ANSI で読んで「} が見つからない」と言う。
# 🔴 窓なしで動くことがあるので、失敗は Read-Host ではなくメッセージボックスで知らせる。
#    Read-Host は見えない窓で待ち続け、何も起きていないように見える。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}

function Show-Failure([string] $message) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($message, 'PAC', 'OK', 'Error')
  } catch {
    Write-Host $message
  }
}

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
  $log = Join-Path $env:TEMP 'pac-build.log'
  & npm run build 2>&1 | Tee-Object -FilePath $log | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Show-Failure ("ビルドに失敗しました。`n`n記録: " + $log)
    exit 1
  }
} else {
  Write-Host '変更が無いのでビルドを飛ばします。'
}

Write-Host 'アプリを起動します...'
# アイコンから開くときは開発ツールの別窓を出さない（electron/main/index.ts）
$env:PAC_NO_DEVTOOLS = '1'
& (Join-Path $root 'node_modules\.bin\electron.cmd') .
if ($LASTEXITCODE -ne 0) {
  Show-Failure ("PAC が途中で止まりました（終了コード " + $LASTEXITCODE + "）。`n`n" +
    "もう一度アイコンを押しても直らないときは、アプリを起動.cmd で起動して画面の文字を見てください。")
  exit $LASTEXITCODE
}
