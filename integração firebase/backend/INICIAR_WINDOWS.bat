@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "firebase.local.bat" call "firebase.local.bat"
title ETHOS Industrial - Inicializacao Node.js
where node >nul 2>&1
if errorlevel 1 goto SEM_NODE
node -e "const v=process.versions.node.split('.').map(Number);if(v[0]<22||(v[0]===22&&v[1]<13))process.exit(1);try{require('node:sqlite')}catch(e){process.exit(1)}" 2>nul
if errorlevel 1 goto VERSAO
start "ETHOS PCP - Servidor Node.js" cmd /k "node server.js serve --host 127.0.0.1 --port 8765"
timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:8765"
echo Sistema iniciado. Mantenha a janela do servidor aberta.
timeout /t 3 /nobreak >nul
exit /b 0
:SEM_NODE
echo.
echo Node.js nao encontrado. Instale o Node.js 24 LTS em https://nodejs.org/
echo Depois feche e abra novamente esta janela.
echo.
pause
exit /b 1
:VERSAO
echo.
echo Este sistema precisa do Node.js 22.13+ com SQLite nativo. Recomendado: Node.js 24 LTS.
echo Verifique com: node --version
echo Instale em https://nodejs.org/
echo.
pause
exit /b 1
