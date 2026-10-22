# ============================================================
# 星罗（OSIRIS）一键启动脚本
# 双击或右键"使用 PowerShell 运行"即可
# ============================================================

$ErrorActionPreference = 'SilentlyContinue'

# 项目路径
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeDir    = "C:\Users\Administrator\.local\bin\node22\node-v22.12.0-win-x64"

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  星罗 OSIRIS - 服务启动" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# 1. 检查 Node.js
if (Test-Path "$NodeDir\node.exe") {
    $env:Path = "$NodeDir;$env:Path"
    Write-Host "[1/4] Node.js 版本切换: " -NoNewline
    $nodeVer = & "$NodeDir\node.exe" -v
    Write-Host "$nodeVer OK" -ForegroundColor Green
} else {
    Write-Host "[1/4] Node.js v22 未找到: $NodeDir" -ForegroundColor Red
    Write-Host "       请先安装 Node.js v22.12.0" -ForegroundColor Red
    Read-Host "按回车键退出"
    exit 1
}

# 2. 检查项目目录
if (-not (Test-Path "$ProjectDir\package.json")) {
    Write-Host "[2/4] 项目目录不正确: $ProjectDir" -ForegroundColor Red
    Read-Host "按回车键退出"
    exit 1
}
Write-Host "[2/4] 项目目录: $ProjectDir" -ForegroundColor Green

# 3. 清理端口 3000 残留进程
Write-Host "[3/4] 检查端口 3000..." -NoNewline
$portConn = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue
if ($portConn) {
    $pids = $portConn | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($pid in $pids) {
        Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
    }
    Write-Host " 已清理旧进程" -ForegroundColor Yellow
    Start-Sleep -Seconds 2
} else {
    Write-Host " 端口空闲" -ForegroundColor Green
}

# 4. 启动服务
Write-Host "[4/4] 启动 Next.js 开发服务器..." -ForegroundColor Cyan
Write-Host ""
Write-Host "--------------------------------------------" -ForegroundColor DarkGray
Write-Host "  服务地址: http://localhost:3000" -ForegroundColor White
Write-Host "  按 Ctrl+C 可停止服务" -ForegroundColor DarkGray
Write-Host "--------------------------------------------" -ForegroundColor DarkGray
Write-Host ""

Set-Location $ProjectDir
& "$NodeDir\npm.cmd" run dev
