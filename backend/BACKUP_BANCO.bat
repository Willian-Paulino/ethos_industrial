@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js nao encontrado. Instale o Node.js 24 LTS.
  pause
  exit /b 1
)
node server.js backup
if errorlevel 1 (
 echo Falha ao criar backup.
) else (
 echo Backup salvo na pasta backups.
)
pause
