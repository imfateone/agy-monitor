# 一键安装 / 更新 AGY监控 插件，并自动为 Antigravity 快捷方式配置 CDP 调试端口
$ErrorActionPreference = "Stop"

Write-Host "=== AGY监控 一键安装与更新 ===" -ForegroundColor Cyan

# 1. 检测 Node.js（Antigravity sidecar 运行依赖）
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    $nodeCandidates = @(@(
        (Join-Path $env:ProgramFiles "nodejs\node.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe"),
        ($(if ($env:NVM_SYMLINK) { Join-Path $env:NVM_SYMLINK "node.exe" }))
    ) | Where-Object { $_ -and (Test-Path $_) })
    if ($nodeCandidates.Count -gt 0) {
        $nodeDir = Split-Path $nodeCandidates[0] -Parent
        $env:Path = "$nodeDir;$env:Path"
        $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    }
}
if (-not $nodeCmd) {
    throw "未检测到 Node.js，请先安装 Node.js 22.13+ LTS (https://nodejs.org/) 并确保 node 在 PATH 中后再运行本脚本。"
}
$nodeVerStr = (& node --version).Trim()
Write-Host "[1/4] Node.js 就绪: $nodeVerStr" -ForegroundColor Green
if ($nodeVerStr -match '^v(\d+)\.(\d+)\.(\d+)') {
    $nodeVer = [version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
    if ($nodeVer -lt [version]"22.13.0") {
        Write-Warning "检测到当前 Node.js 版本为 $nodeVerStr；AGY监控 依赖内置 node:sqlite，建议升级至 Node.js 22.13+ LTS 以获完整支持。"
    }
}

# 2. 备份并安装插件到 %USERPROFILE%\.gemini\config\plugins\agy-monitor
$srcDir = Join-Path $PSScriptRoot "plugin"
if (-not (Test-Path $srcDir)) {
    throw "未找到插件源码目录: $srcDir"
}
$liveDir = Join-Path $env:USERPROFILE ".gemini\config\plugins\agy-monitor"
$backupsRoot = Join-Path $PSScriptRoot "backups"
if (Test-Path $liveDir) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupDir = Join-Path $backupsRoot $stamp
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    robocopy $liveDir $backupDir /E /XD node_modules __pycache__ backups | Out-Null
    if ($LASTEXITCODE -ge 8) {
        throw "备份原有插件失败，退出码: $LASTEXITCODE"
    }
    Write-Host "[2/4] 已备份原有插件至: $backupDir" -ForegroundColor DarkGray
    Get-ChildItem -Path $backupsRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^\d{8}-\d{6}$' } |
        Sort-Object Name -Descending |
        Select-Object -Skip 5 |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Path $liveDir -Force | Out-Null
robocopy $srcDir $liveDir /MIR /XD node_modules __pycache__ backups | Out-Null
if ($LASTEXITCODE -ge 8) {
    throw "同步插件文件失败，退出码: $LASTEXITCODE"
}
Write-Host "[2/4] 插件已安装/更新至: $liveDir" -ForegroundColor Green

# 3. 自动检查并配置 Antigravity 快捷方式的 --remote-debugging-port=0
$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath("Desktop")
$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$searchRoots = @(@($desktop, $startMenu) | Where-Object { $_ -and (Test-Path $_) })

$patchedCount = 0
foreach ($root in $searchRoots) {
    Get-ChildItem -Path $root -Filter "*.lnk" -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            $lnk = $ws.CreateShortcut($_.FullName)
            if ($lnk.TargetPath -and ($lnk.TargetPath -match '(?i)Antigravity\.exe$')) {
                $args = if ($lnk.Arguments) { $lnk.Arguments.Trim() } else { "" }
                if ($args -notmatch '--remote-debugging-port') {
                    $lnk.Arguments = if ($args) { "$args --remote-debugging-port=0" } else { "--remote-debugging-port=0" }
                    $lnk.Save()
                    Write-Host "    已为快捷方式添加 --remote-debugging-port=0: $($_.FullName)" -ForegroundColor Cyan
                } else {
                    Write-Host "    快捷方式已配置调试端口: $($_.FullName)" -ForegroundColor DarkGray
                }
                $patchedCount += 1
            }
        } catch {
            Write-Warning "检查快捷方式失败 ($($_.FullName)): $_"
        }
    }
}

if ($patchedCount -eq 0) {
    $regCandidates = @()
    try {
        $appKey = Get-ItemProperty -Path "HKCU:\Software\121a0be4-63bd-531e-acf8-fc3924c7e984" -ErrorAction SilentlyContinue
        if ($appKey -and $appKey.InstallLocation) {
            $regCandidates += (Join-Path ($appKey.InstallLocation.Trim('"')) "Antigravity.exe")
        }
    } catch {}
    foreach ($uninstallRoot in @(
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )) {
        try {
            Get-ItemProperty -Path $uninstallRoot -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -like "Antigravity*" -and $_.DisplayName -notlike "*IDE*" } |
                ForEach-Object {
                    foreach ($rawVal in @($_.InstallLocation, $_.DisplayIcon, $_.UninstallString)) {
                        if (-not $rawVal) { continue }
                        $val = [string]$rawVal
                        if ($val -match '^"([^"]+?\.exe)"') {
                            $dir = Split-Path $Matches[1] -Parent
                            $regCandidates += (Join-Path $dir "Antigravity.exe")
                        } elseif ($val -match '^(.*?\.exe)\b') {
                            $dir = Split-Path $Matches[1] -Parent
                            $regCandidates += (Join-Path $dir "Antigravity.exe")
                        } else {
                            $regCandidates += (Join-Path ($val.Trim('"')) "Antigravity.exe")
                        }
                    }
                }
        } catch {}
    }

    $agCandidates = @((
        @($regCandidates) +
        @(
            (Join-Path $env:LOCALAPPDATA "Programs\antigravity\Antigravity.exe"),
            (Join-Path $env:ProgramFiles "Antigravity\Antigravity.exe")
        )
    ) | Where-Object { $_ -and (Test-Path $_) })
    if ($agCandidates.Count -gt 0) {
        $exe = $agCandidates[0]
        $deskLnkPath = Join-Path $desktop "Antigravity.lnk"
        $lnk = $ws.CreateShortcut($deskLnkPath)
        $lnk.TargetPath = $exe
        $lnk.WorkingDirectory = Split-Path $exe -Parent
        $lnk.Arguments = "--remote-debugging-port=0"
        $lnk.Save()
        Write-Host "    已在桌面创建带 --remote-debugging-port=0 的快捷方式: $deskLnkPath" -ForegroundColor Cyan
        $patchedCount += 1
    } else {
        Write-Warning "未自动找到 Antigravity 快捷方式或主程序；请手动为 Antigravity 快捷方式目标参数追加 --remote-debugging-port=0。"
    }
}
Write-Host "[3/4] Antigravity 调试端口检查完成 (已处理 $patchedCount 个快捷方式)" -ForegroundColor Green

# 4. 运行单元测试验证插件健康状态
$testFile = Join-Path $liveDir "test\telemetry.test.mjs"
if (Test-Path $testFile) {
    Write-Host "[4/4] 正在运行单元测试..." -ForegroundColor Cyan
    & node --test $testFile
    if ($LASTEXITCODE -ne 0) {
        throw "单元测试失败，退出码: $LASTEXITCODE"
    }
}

Write-Host ""
Write-Host "安装完成！请通过桌面/开始菜单中的 Antigravity 快捷方式重启 Antigravity，即可生效右侧 AGY监控 面板与底部/每轮用量胶囊。" -ForegroundColor Yellow
