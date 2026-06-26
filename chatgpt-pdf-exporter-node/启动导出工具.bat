@echo off
setlocal
chcp 65001 >nul
title ChatGPT PDF 导出工具

cd /d "%~dp0"

echo ========================================
echo ChatGPT PDF 导出工具
echo ========================================
echo 当前目录：%cd%
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 没有检测到 Node.js
    echo 请先安装 Node.js 18 或更高版本
    echo.
    pause
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [错误] 没有检测到 npm
    echo 请重新安装 Node.js，安装时勾选 npm
    echo.
    pause
    exit /b 1
)

echo 正在检查依赖...
echo.

if not exist "%~dp0node_modules\puppeteer-core" (
    echo [首次运行] 正在自动安装依赖...
    echo 这一步需要联网，可能需要 1-5 分钟。
    echo.

    if exist "%~dp0package.json" (
        call npm install --no-audit --no-fund
    ) else (
        call npm install --no-audit --no-fund puppeteer-core
    )

    if errorlevel 1 (
        echo.
        echo [错误] 依赖安装失败
        echo 请检查网络，或手动运行：npm install
        echo.
        pause
        exit /b 1
    )
)

echo 依赖检查完成，开始运行...
echo.

node "%~dp0run_fresh_export_select_page.js"

echo.
echo ========================================
echo 程序已结束
echo ========================================
pause