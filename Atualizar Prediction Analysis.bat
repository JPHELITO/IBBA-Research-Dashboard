@echo off
chcp 65001 >nul
title Atualizar Prediction Analysis

cd /d "%~dp0"

echo.
echo  ===============================================================
echo   ATUALIZAR PREDICTION ANALYSIS
echo  ===============================================================
echo   SECEX ....... eu busco sozinho no MDIC
echo   KOREA ....... uso o "by H.S Code and Country*.xlsx" do Downloads
echo   CHINA ....... uso o "downloadData*.csv" do Downloads
echo.
echo   No fim, publico a linha preta na dashboard.
echo   (Feche o Excel-mestre antes de continuar.)
echo  ===============================================================
echo.

python atualizar_prediction.py %*

echo.
echo  ---------------------------------------------------------------
echo   Terminou. Pode fechar esta janela.
echo  ---------------------------------------------------------------
pause
