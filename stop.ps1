# ============================================================
# 星罗（OSIRIS）一键停止脚本
# 双击或右键"使用 PowerShell 运行"即可
# ============================================================

$ErrorActionPreference = 'SilentlyContinue'

Write-Host ""
Write-Host "============================================" -ForegroundColor Yellow
Write-Host "  星罗 OSIRIS - 服务停止" -ForegroundColor Yellow
Write-Host "============================================" -ForegroundColor Yellow
Write-Host ""

# 查找端口 3000 上的进程
$portConn = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue

if ($portConn) {
    $pids = $portConn | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $pids) {
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "停止进程: $($proc.ProcessName) (PID: $procId)" -ForegroundColor Yellow
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Seconds 1

    # 验证
    $stillRunning = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue
    if ($stillRunning) {
        Write-Host "服务仍在运行，可能需要手动终止" -ForegroundColor Red
    } else {
        Write-Host "服务已停止" -ForegroundColor Green
    }
} else {
    # 也查找 node.exe 进程作为兜底
    $nodeProcs = Get-Process -Name "node" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match "next|osiris" }

    if ($nodeProcs) {
        foreach ($proc in $nodeProcs) {
            Write-Host "停止 Node 进程: $($proc.ProcessName) (PID: $($proc.Id))" -ForegroundColor Yellow
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        }
        Write-Host "服务已停止" -ForegroundColor Green
    } else {
        Write-Host "服务未在运行（端口 3000 空闲）" -ForegroundColor DarkGray
    }
}

Write-Host ""
Write-Host "--------------------------------------------" -ForegroundColor DarkGray
Write-Host "  端口 3000 已释放" -ForegroundColor Green
Write-Host "--------------------------------------------" -ForegroundColor DarkGray
Write-Host ""
Read-Host "按回车键退出"
