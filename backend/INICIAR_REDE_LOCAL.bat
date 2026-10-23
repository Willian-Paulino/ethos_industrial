@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "firebase.local.bat" call "firebase.local.bat"
title ETHOS - Servidor na Rede Local
where node >nul 2>&1
if errorlevel 1 goto ERRO
node -e "const v=process.versions.node.split('.').map(Number);if(v[0]<22||(v[0]===22&&v[1]<13))process.exit(1);try{require('node:sqlite')}catch(e){process.exit(1)}" 2>nul
if errorlevel 1 goto ERRO
echo ATENCAO: use apenas em rede interna confiavel. Nao exponha a porta 8765 na internet.
echo Crie o administrador primeiro com INICIAR_WINDOWS.bat no computador servidor.
echo Para acesso externo, solicite HTTPS e controle de acesso a TI.
echo.
node server.js serve --host 0.0.0.0 --port 8765
pause
exit /b 0
:ERRO
echo Node.js 22.13+ nao encontrado. Instale Node.js 24 LTS em https://nodejs.org/
pause
exit /b 1
