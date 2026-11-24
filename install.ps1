# 一键安装 / 更新 AGY监控 插件
[CmdletBinding()]
param([switch]$CreateMonitorShortcut)

$ErrorActionPreference = "Stop"

function Set-RemoteDebuggingPortArg {
    param([string]$Arguments)

    $argsText = if ($null -eq $Arguments) { "" } else { $Arguments.Trim() }
    $pattern = '(?i)(^|\s)--remote-debugging-port(?:=[^\s]*|\s+\d+)?(?=\s|$)'
    if ($argsText -match $pattern) {
        return ([regex]::Replace($argsText, $pattern, '$1--remote-debugging-port=0')).Trim()
    }
    return "$argsText --remote-debugging-port=0".TrimStart()
}

function New-PageMonitorShortcut {
    param(
        [string]$Desktop,
        [string]$StartMenu,
        [string[]]$ExtraSearchRoots = @()
    )

    if (-not $Desktop -or -not (Test-Path -LiteralPath $Desktop -PathType Container)) {
        Write-Warning "未找到桌面。可在 Antigravity 的启动参数中加入 --remote-debugging-port=0 来启用页面监控。"
        return
    }

    $monitorLinkPath = Join-Path $Desktop "Antigravity (AGY Monitor).lnk"
    if (Test-Path -LiteralPath $monitorLinkPath) {
        Write-Host "页面监控快捷方式已存在: $monitorLinkPath" -ForegroundColor DarkGray
        return
    }

    $shell = New-Object -ComObject WScript.Shell
    $primaryLink = $null
    $primaryIsCustom = $false
    $fallbackDirectLink = $null
    $seenRoots = @{}
    $searchRoots = @()
    foreach ($root in (@($Desktop, $StartMenu) + @($ExtraSearchRoots))) {
        if (-not $root) { continue }
        $key = $root.TrimEnd('\').ToLowerInvariant()
        if ($seenRoots.ContainsKey($key)) { continue }
        if (Test-Path -LiteralPath $root -PathType Container) {
            $seenRoots[$key] = $true
            $searchRoots += $root
        }
    }

    foreach ($root in $searchRoots) {
        foreach ($file in Get-ChildItem -LiteralPath $root -Filter "*.lnk" -File -Recurse -ErrorAction SilentlyContinue) {
            try {
                $candidate = $shell.CreateShortcut($file.FullName)
                $isDirectTarget = ([IO.Path]::GetFileName($candidate.TargetPath) -ieq "Antigravity.exe")
                if ($file.Name -ieq "Antigravity.lnk") {
                    if (-not $primaryLink) {
                        if ($isDirectTarget) {
                            if (Test-Path -LiteralPath $candidate.TargetPath -PathType Leaf) {
                                $primaryLink = $candidate
                                $primaryIsCustom = $false
                            }
                        } else {
                            $primaryLink = $candidate
                            $primaryIsCustom = $true
                        }
                    }
                } elseif ($isDirectTarget -and -not $fallbackDirectLink -and (Test-Path -LiteralPath $candidate.TargetPath -PathType Leaf)) {
                    $fallbackDirectLink = $candidate
                }
            } catch {
                Write-Warning "读取快捷方式失败 ($($file.FullName)): $_"
            }
        }
    }

    if ($primaryLink -and $primaryIsCustom) {
        if ($primaryLink.Arguments -match '(?:^|[\s"''])--remote-debugging-port=0(?=$|[\s"''])') {
            Write-Host "现有 Antigravity 启动入口已配置页面监控，请沿用该入口。" -ForegroundColor Cyan
        } else {
            Write-Warning "请沿用自定义 Antigravity 启动入口，由该入口透传 --remote-debugging-port=0 来启用页面监控。"
        }
        return
    }

    $sourceLink = if ($primaryLink) { $primaryLink } else { $fallbackDirectLink }

    $exe = if ($sourceLink) { $sourceLink.TargetPath }
    if (-not $exe) {
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
        ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) })
        $exe = $agCandidates | Select-Object -First 1
    }
    if (-not $exe) {
        Write-Warning "未找到 Antigravity 主程序。可在原有启动入口传入 --remote-debugging-port=0 来启用页面监控。"
        return
    }

    $launchArgs = Set-RemoteDebuggingPortArg -Arguments $(if ($sourceLink) { [string]$sourceLink.Arguments } else { "" })

    $tempLinkPath = Join-Path $Desktop (".agy-monitor-" + [Guid]::NewGuid().ToString("N") + ".lnk")
    try {
        $shortcut = $shell.CreateShortcut($tempLinkPath)
        $shortcut.TargetPath = $exe
        $shortcut.WorkingDirectory = if ($sourceLink -and $sourceLink.WorkingDirectory) {
            $sourceLink.WorkingDirectory
        } else {
            Split-Path -LiteralPath $exe
        }
        if ($sourceLink -and $sourceLink.IconLocation) {
            $shortcut.IconLocation = $sourceLink.IconLocation
        }
        $shortcut.Arguments = $launchArgs
        $shortcut.Save()
        [IO.File]::Move($tempLinkPath, $monitorLinkPath)
        Write-Host "已创建页面监控快捷方式，请使用该入口启动: $monitorLinkPath" -ForegroundColor Cyan
    } catch [IO.IOException] {
        if (-not (Test-Path -LiteralPath $monitorLinkPath)) { throw }
        Write-Host "页面监控快捷方式已存在: $monitorLinkPath" -ForegroundColor DarkGray
    } finally {
        if (Test-Path -LiteralPath $tempLinkPath) {
            Remove-Item -LiteralPath $tempLinkPath -Force
        }
    }
}

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
Write-Host "[1/3] Node.js 就绪: $nodeVerStr" -ForegroundColor Green
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
    Write-Host "[2/3] 已备份原有插件至: $backupDir" -ForegroundColor DarkGray
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
Write-Host "[2/3] 插件已安装/更新至: $liveDir" -ForegroundColor Green

# 3. 运行单元测试验证插件健康状态
$testFile = Join-Path $liveDir "test\telemetry.test.mjs"
if (Test-Path $testFile) {
    Write-Host "[3/3] 正在运行单元测试..." -ForegroundColor Cyan
    & node --test $testFile
    if ($LASTEXITCODE -ne 0) {
        throw "单元测试失败，退出码: $LASTEXITCODE"
    }
}

if ($CreateMonitorShortcut) {
    $desktopPath = [Environment]::GetFolderPath("Desktop")
    $startMenuPath = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
    $extraRoots = @(
        [Environment]::GetFolderPath("CommonDesktopDirectory"),
        [Environment]::GetFolderPath("CommonPrograms")
    )
    New-PageMonitorShortcut -Desktop $desktopPath -StartMenu $startMenuPath -ExtraSearchRoots $extraRoots
}

Write-Host ""
Write-Host "安装完成！请完全退出并重新启动 Antigravity，即可使用 AGY监控。" -ForegroundColor Yellow
