@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Este comando NAO envia nada ao Firebase agora.
echo Apenas marca chamados, mensagens e notificacoes anteriores para envio futuro.
echo Confirme que sua empresa autorizou enviar esses dados para a nuvem.
set /p CONFIRMA=Digite SIM para continuar: 
if /I not "%CONFIRMA%"=="SIM" exit /b 1
node server.js firebase-seed
pause
