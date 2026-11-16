@echo off
title Publish Blog
echo ==============================================
echo   Triggering Cloud Build ^& Publish for Blog...
echo ==============================================

gh workflow run deploy.yml --repo illtree/my-site

if %ERRORLEVEL% EQU 0 (
    echo.
    echo [OK] Cloud publish workflow triggered successfully!
    echo      Pulling published posts and deploying site...
    echo      It usually takes around 15-20 seconds to go live.
    echo.
    timeout /t 5 >nul
) else (
    echo.
    echo [ERROR] Failed to trigger cloud publish workflow!
    echo         Please check your network connection or GitHub login status.
    echo.
    echo Press any key to close this window...
    pause >nul
)
