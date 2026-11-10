@echo off
cd /d "%~dp0"
echo ===================================================
echo 正在准备 Folio 个人数字空间本地预览服务...
echo ===================================================

echo 正在清理可能残留的 1313 端口占用进程...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :1313 ^| findstr LISTENING') do (
  taskkill /f /pid %%a >nul 2>nul
)

echo 正在启动 Hugo 预览服务 (http://localhost:1313)...
start "" "http://localhost:1313"
hugo server -D --disableFastRender
pause
