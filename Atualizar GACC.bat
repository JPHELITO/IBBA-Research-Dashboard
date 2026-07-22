@echo off
rem ── Atualizar GACC (cavaco China) na dashboard — duplo-clique ──────────────
rem Le o CSV do customs (Downloads), monta o banco e publica pela API do GitHub
rem (sem login, sem git). Precisa do token em %USERPROFILE%\.ibba\token.txt
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONUTF8=1
python publicar_gacc.py
if errorlevel 1 (
  echo.
  echo [!] Se apareceu "python nao e reconhecido", tente trocar por:  py publicar_gacc.py
)
echo.
pause
