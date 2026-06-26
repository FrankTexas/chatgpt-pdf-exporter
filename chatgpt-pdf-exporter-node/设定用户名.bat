@echo off
chcp 65001 >nul
title Set PDF User Name

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found.
    pause
    exit /b 1
)

node "%~dp0set_pdf_user_name.js"

echo.
pause
