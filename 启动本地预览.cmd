@echo off
cd /d "%~dp0"
echo 正在启动 Hugo 本地预览服务...
start "" "http://localhost:1313"
hugo server -D --disableFastRender
pause
