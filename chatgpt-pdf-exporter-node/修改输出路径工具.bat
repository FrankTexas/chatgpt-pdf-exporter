@echo off
chcp 65001 >nul
title Change PDF Output Folder

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found.
    echo Please install Node.js first.
    pause
    exit /b 1
)

node "%~dp0run_json_to_pdf_pick_output.js" --choose-output-only

echo.
pause
