@echo off
chcp 65001 > nul
cd /d "%~dp0"

echo ビルドしています...
call npm run build
if errorlevel 1 (
  echo.
  echo ビルドに失敗しました。
  pause
  exit /b 1
)

echo アプリを起動します...
call "node_modules\.bin\electron.cmd" .

REM 開発サーバーを使わないので、ウィンドウを閉じてもこのファイルを実行すれば何度でも起動できる
