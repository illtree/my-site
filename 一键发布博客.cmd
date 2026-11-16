@echo off
chcp 65001 >nul
title 一键发布博客
echo ==============================================
echo   正在通知云端同步并发布 Notion 博客...
echo ==============================================
gh workflow run deploy.yml --repo illtree/my-site
if %ERRORLEVEL% EQU 0 (
    echo.
    echo [OK] 已成功触发云端发布！
    echo      云端正在拉取打勾的文章并自动部署上线。
    echo      预计耗时约 15~20 秒，窗口即将自动关闭...
) else (
    echo.
    echo [ERR] 触发失败，请检查网络或 GitHub 登录状态。
)
echo.
timeout /t 4 >nul
