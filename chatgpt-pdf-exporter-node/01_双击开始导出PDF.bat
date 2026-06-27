@echo off
setlocal
chcp 65001 >nul
title ChatGPT PDF Exporter

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo Please install Node.js 18 or higher.
    echo.
    pause
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm not found.
    echo Please reinstall Node.js and include npm.
    echo.
    pause
    exit /b 1
)

if not exist "%~dp0node_modules\puppeteer-core" (
    echo First run: installing dependencies...
    echo This requires internet and may take 1-5 minutes.
    echo.

    if exist "%~dp0package.json" (
        call npm install --no-audit --no-fund
    ) else (
        call npm install --no-audit --no-fund puppeteer-core markdown-it
    )

    if errorlevel 1 (
        echo.
        echo [ERROR] Dependency installation failed.
        echo Please check your network, or manually run:
        echo npm install
        echo.
        pause
        exit /b 1
    )
)

node "%~dp0run_fresh_export_select_page.js"
set EXIT_CODE=%ERRORLEVEL%

if "%EXIT_CODE%"=="0" (
    exit
)

echo.
echo ========================================
echo Program failed. Error code: %EXIT_CODE%
echo ========================================
pause
exit /b %EXIT_CODE%
