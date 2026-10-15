@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo  GSEditor を起動します（ローカル開発用）
echo  公開版はブラウザで開くだけ: https://takumanakata.github.io/gs-editor/
echo ============================================
echo.

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js が入っていません。
  echo   いま開くページ https://nodejs.org/ja から「LTS」を入れて、
  echo   もう一度この「起動.bat」をダブルクリックしてください。
  start "" "https://nodejs.org/ja"
  pause
  exit /b 1
)

if not exist "_dev\web\node_modules" (
  echo 初回の準備をします。数分かかります...
  pushd _dev\web
  call npm install
  if errorlevel 1 (
    popd
    echo.
    echo [ERROR] 準備に失敗しました。上のメッセージを見てください。
    pause
    exit /b 1
  )
  popd
  echo.
)

echo ブラウザが自動で開きます。このウィンドウを閉じると終了します。
echo.
pushd _dev\web
call npm run dev
popd
pause
