@echo off
chcp 65001 >nul
title Start Chrome for Web PDF Tool

echo 正在启动 Chrome 调试模式...

set "CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe"

if not exist "%CHROME_PATH%" (
    set "CHROME_PATH=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
)

if not exist "%CHROME_PATH%" (
    set "CHROME_PATH=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
)

if not exist "%CHROME_PATH%" (
    echo 没有找到 Chrome，请确认你已经安装 Google Chrome。
    pause
    exit /b
)

set "USER_DATA_DIR=%~dp0chrome_data"

if not exist "%USER_DATA_DIR%" (
    mkdir "%USER_DATA_DIR%"
)

echo Chrome 路径：
echo %CHROME_PATH%
echo.
echo 用户数据目录：
echo %USER_DATA_DIR%
echo.

start "" "%CHROME_PATH%" ^
 --remote-debugging-port=9222 ^
 --user-data-dir="%USER_DATA_DIR%" ^
 --no-first-run ^
 --no-default-browser-check ^
 --disable-popup-blocking

echo.
echo Chrome 已启动。
echo 如果浏览器已经打开，请不要关闭它。
pause