@echo off
setlocal
for /f "tokens=2 delims=:." %%c in ('chcp') do set "OLDCP=%%c"
chcp 65001 >nul
rem
rem 「Irodori-TTS-v4.1-Anime」か「Irodori-TTS-v4.1-Small-SUN」のGGUFファイルを取得・変換するスクリプト。
rem 実行すると、どちらを作るかを番号で選ぶ。最初から指定する場合は：
rem make-model.bat --model sun
rem 量子化 Q4_K以外のタイプの場合は：
rem make-model.bat --type q8_0
rem
rem 生成したGGUFモデルの指定方法は次のように環境変数で設定する
rem set TRPG_VOICE_BRIDGE_MINI_MODEL=.\Irodori-TTS-859M-Anime-v4.1-Q4_K.gguf
rem npm start
rem
rem 日本語を正しく読むため、先頭で文字コードをUTF-8（65001）に切り替え、終わったら戻す。
rem
cd /d "%~dp0"
set "ROOT=%CD%"
set "WORK=%ROOT%\work"
set "UV_VERSION=0.13.6"
set "UV_FILE=uv-x86_64-pc-windows-msvc.zip"
set "UV_SHA256=a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f"
set "UV_CACHE_DIR=%WORK%\uv-cache"
set "UV_PYTHON_INSTALL_DIR=%WORK%\python"
set "UV_PYTHON_BIN_DIR=%WORK%\python\bin"
set "UV_PYTHON_PREFERENCE=only-managed"
set "UV_PYTHON_INSTALL_REGISTRY=0"
set "UV_NO_CONFIG=1"

if exist "%WORK%\uv\uv.exe" goto run
mkdir "%WORK%\downloads" 2>nul
mkdir "%WORK%\uv" 2>nul
set "ARCHIVE=%WORK%\downloads\%UV_FILE%"
"%SystemRoot%\System32\curl.exe" --fail --location --retry 5 --silent --show-error --output "%ARCHIVE%" "https://github.com/astral-sh/uv/releases/download/%UV_VERSION%/%UV_FILE%"
if errorlevel 1 goto nouv
set "GOT=none"
for /f "delims=" %%h in ('certutil -hashfile "%ARCHIVE%" SHA256 ^| findstr /v ":"') do set "GOT=%%h"
if /i not "%GOT: =%"=="%UV_SHA256%" goto baduv
"%SystemRoot%\System32\tar.exe" -xf "%ARCHIVE%" -C "%WORK%\uv"
if errorlevel 1 goto nouv

:run
"%WORK%\uv\uv.exe" run --quiet --no-project --python 3.10 "%ROOT%\make_model.py" %*
if errorlevel 1 goto end
if exist "%WORK%\.done" rmdir /s /q "%WORK%"
goto end

:baduv
del "%ARCHIVE%"
echo ダウンロードしたuvの中身が想定と違いました。もう一度実行してください。
goto end

:nouv
echo uvをダウンロードできませんでした。ネットワークを確認して、もう一度実行してください。

:end
pause
chcp %OLDCP% >nul
