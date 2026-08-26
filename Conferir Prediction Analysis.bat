@echo off
chcp 65001 >nul
title Conferir Prediction Analysis (nao escreve nada)
cd /d "%~dp0"
echo.
echo   So CONFERE o que esta faltando. Nao escreve nada, nao publica nada.
echo.
python atualizar_prediction.py --conferir
echo.
pause
