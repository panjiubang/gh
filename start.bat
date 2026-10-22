@echo off
chcp 65001 >nul 2>&1
title 星罗 OSIRIS - 服务启动

echo.
echo ============================================
echo   星罗 OSIRIS - 服务启动
echo ============================================
echo.

REM 设置 Node.js v22 路径
set "NODE_DIR=C:\Users\Administrator\.local\bin\node22\node-v22.12.0-win-x64"
set "PATH=%NODE_DIR%;%PATH%"

REM 切换到脚本所在目录
cd /d "%~dp0"

REM 检查 Node.js
if not exist "%NODE_DIR%\node.exe" (
    echo [错误] 未找到 Node.js v22: %NODE_DIR%
    echo         请先安装 Node.js v22.12.0
    echo.
    pause
    exit /b 1
)

echo [1/3] Node.js 版本:
"%NODE_DIR%\node.exe" -v
echo.

REM 清理端口 3000 残留进程
echo [2/3] 检查端口 3000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
    echo        终止旧进程 PID: %%a
    taskkill /PID %%a /F >nul 2>&1
    timeout /t 2 /nobreak >nul
)
echo        端口已就绪
echo.

REM 启动服务
echo [3/3] 启动 Next.js 开发服务器...
echo.
echo --------------------------------------------
echo   服务地址: http://localhost:3000
echo   按 Ctrl+C 可停止服务
echo --------------------------------------------
echo.

"%NODE_DIR%\npm.cmd" run dev

REM 如果 npm 退出（出错或 Ctrl+C），保持窗口
echo.
echo ============================================
echo   服务已停止
echo ============================================
pause
