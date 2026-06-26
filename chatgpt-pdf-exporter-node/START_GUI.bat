@echo off
setlocal
chcp 65001 >nul
title ChatGPT PDF Exporter GUI

cd /d "%~dp0"

echo ========================================
echo ChatGPT PDF Exporter GUI
echo ========================================
echo.

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

if not exist "node_modules\electron" (
    echo Installing Electron...
    call npm install --save-dev electron
    if errorlevel 1 (
        echo.
        echo [ERROR] Electron installation failed.
        echo.
        pause
        exit /b 1
    )
)

echo Starting GUI...
echo.
npx electron .\gui\main.js

echo.
echo GUI closed.
pause
