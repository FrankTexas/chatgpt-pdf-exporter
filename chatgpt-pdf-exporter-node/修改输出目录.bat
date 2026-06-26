@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Change PDF Output Folder

node .\run_json_to_pdf_pick_output.js --change-output-dir

echo.
pause
