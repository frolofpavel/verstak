@echo off
chcp 65001 >nul
set LANG=en_US.UTF-8
set LC_ALL=en_US.UTF-8
set TERM=xterm-256color
set COLORTERM=truecolor
title Verstak
cd /d "C:\Users\Pavel\Progetc\Проекты\verstak"
echo Starting Verstak...
echo.
echo Keep this window open while using the app.
echo Close it (or press Ctrl+C) to quit.
echo.
npm run dev
pause
