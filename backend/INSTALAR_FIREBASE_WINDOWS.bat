@echo off
chcp 65001 >nul
cd /d "%~dp0"
where npm >nul 2>&1
if errorlevel 1 (
  echo NPM nao encontrado. Instale Node.js 24 LTS.
  pause
  exit /b 1
)
echo Instalando Firebase Admin SDK e dependencias Node.js...
call npm install --omit=dev
if errorlevel 1 (
  echo Falha na instalacao. Verifique conexao com a internet e permissoes.
  pause
  exit /b 1
)
echo SDK instalado. Configure firebase.local.bat antes de ativar.
pause
