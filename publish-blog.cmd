@echo off
title Folio Blog Publish System
setlocal enabledelayedexpansion

echo ==============================================
echo   Folio 个人数字空间 · 自动化发布系统
echo ==============================================
echo.

cd /d "%~dp0"

:: 步骤 1: 扫描并同步 Obsidian 中勾选了 publish: true 的笔记
echo [1/4] 正在扫描 Obsidian 知识库并同步已勾选文章...
node scripts/sync-obsidian.mjs
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Obsidian 同步失败！请检查上方输出信息。
    echo.
    pause
    exit /b %ERRORLEVEL%
)

:: 步骤 2: 执行全量工程守则与自动化回归测试
echo.
echo [2/4] 正在执行全量自动化回归测试 (npm test)...
call npm test
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] 本地工程测试未通过！已终止发布流程以防止破损代码上线。
    echo.
    pause
    exit /b %ERRORLEVEL%
)

:: 步骤 3: 检查 Git 变更并提交推送
echo.
echo [3/4] 检查内容变更并提交到 Git...
git add content/posts static/images/posts
git diff --cached --quiet
if %ERRORLEVEL% NEQ 0 (
    git commit -m "feat(blog): sync published posts from obsidian"
    echo [4/4] 正在推送到 GitHub 远端仓库 (自动触发 Cloudflare/GitHub Pages 上线)...
    git push origin main
    if %ERRORLEVEL% EQU 0 (
        echo.
        echo ==============================================
        echo   [OK] 文章已成功推送到 GitHub！
        echo   云端 GitHub Pages 正在自动构建，约 15-20 秒后生效。
        echo ==============================================
    ) else (
        echo.
        echo [ERROR] Git 推送失败，请检查网络连接或凭据状态。
    )
) else (
    echo [3/4] content/posts 与图片无新变动。
    echo [4/4] 尝试触发云端手动工作流...
    gh workflow run deploy.yml --repo illtree/my-site >nul 2>&1
    if %ERRORLEVEL% EQU 0 (
        echo   [OK] 已触发云端部署任务。
    ) else (
        echo   [OK] 本地内容已是最新状态。
    )
)

echo.
timeout /t 5 >nul
