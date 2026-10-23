@echo off
setlocal
cd /d "%~dp0"
if not exist "pages.local.bat" (
  echo [ERRO] Copie pages.local.example.bat como pages.local.bat e configure ETHOS_PAGES_URL.
  pause
  exit /b 1
)
call "pages.local.bat"
if exist "firebase.local.bat" call "firebase.local.bat"
if not exist "dados" mkdir "dados"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Instale Node.js 22.13+ ^(recomendado Node 24 LTS^).
  pause
  exit /b 1
)
echo Iniciando ETHOS na interface local 127.0.0.1:8765
node server.js serve --host 127.0.0.1 --port 8765
pause
