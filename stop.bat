@echo off
chcp 65001 >nul 2>&1
title 星罗 OSIRIS - 服务停止

echo.
echo ============================================
echo   星罗 OSIRIS - 服务停止
echo ============================================
echo.

echo 查找端口 3000 上的进程...

set "found=0"
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING" 2^>nul') do (
    set "found=1"
    echo 终止进程 PID: %%a
    taskkill /PID %%a /F >nul 2>&1
)

if "%found%"=="0" (
    echo 端口 3000 空闲，服务未在运行
) else (
    timeout /t 2 /nobreak >nul
    netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>&1
    if errorlevel 1 (
        echo.
        echo 服务已停止，端口已释放
    ) else (
        echo.
        echo 警告：端口仍被占用，可能需要手动关闭
    )
)

echo.
echo --------------------------------------------
pause
