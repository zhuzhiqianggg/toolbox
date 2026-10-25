# Toolbox 一键打包 + 安装部署脚本
#
# 用法（在项目根目录执行）:
#   powershell scripts\deploy.ps1                # 打包 -> 复制到 installers\ -> 静默安装(NSIS) -> 启动
#   powershell scripts\deploy.ps1 -Installer msi # 改用 MSI 安装
#   powershell scripts\deploy.ps1 -SkipBuild     # 跳过打包，直接安装已有产物
#   powershell scripts\deploy.ps1 -NoLaunch      # 装完不启动
#   powershell scripts\deploy.ps1 -OpenFolder    # 装完打开 installers\ 目录
#
# 说明:
#   - 打包产物会统一复制到 <项目根>\installers\，以后找安装包只看这里
#   - 版本号自动从 src-tauri\tauri.conf.json 读取，升级版本无需改脚本
#   - 安装前自动关闭运行中的 Toolbox 实例，避免文件占用

param(
  [ValidateSet('nsis', 'msi')]
  [string]$Installer = 'nsis',
  [switch]$SkipBuild,
  [switch]$NoLaunch,
  [switch]$OpenFolder
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$bundleDir = Join-Path $root 'src-tauri\target\release\bundle'
$stagingDir = Join-Path $root 'installers'

# 1) 读取版本与产品名，动态拼安装包文件名
$conf = Get-Content (Join-Path $root 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$ver = $conf.version
$prod = ($conf.productName -replace ' ', '_')
$msiFile = "${prod}_${ver}_x64_en-US.msi"
$nsisFile = "${prod}_${ver}_x64-setup.exe"

# 2) 打包（Tauri 构建必须补全 cargo/node 的 PATH，否则 beforeBuildCommand 起不来）
if (-not $SkipBuild) {
  Write-Host "==> 开始打包 (版本 $ver)，预计 4-5 分钟..." -ForegroundColor Cyan
  $env:Path = "$env:USERPROFILE\.cargo\bin;C:\Program Files\nodejs;$env:Path"
  Push-Location $root
  try {
    & npm.cmd run tauri build
    if ($LASTEXITCODE -ne 0) { throw "打包失败，npm 退出码 $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
} else {
  Write-Host '==> 跳过打包，使用已有产物' -ForegroundColor Yellow
}

# 3) 收集产物到固定目录 installers\
New-Item $stagingDir -ItemType Directory -Force | Out-Null
$msiPath = Join-Path $bundleDir "msi\$msiFile"
$nsisPath = Join-Path $bundleDir "nsis\$nsisFile"
foreach ($f in @($msiPath, $nsisPath)) {
  if (-not (Test-Path $f)) { throw "未找到安装包: $f（请先完成打包，去掉 -SkipBuild）" }
  Copy-Item $f $stagingDir -Force
}
Write-Host "==> 安装包已就位: $stagingDir" -ForegroundColor Cyan

# 4) 选定安装包并关闭运行中的实例
$setup = if ($Installer -eq 'msi') { Join-Path $stagingDir $msiFile } else { Join-Path $stagingDir $nsisFile }
$running = Get-Process toolbox -ErrorAction SilentlyContinue
if ($running) {
  Write-Host '==> 关闭运行中的 Toolbox...' -ForegroundColor Yellow
  $running | Stop-Process -Force
  Start-Sleep -Milliseconds 600
}

# 5) 静默安装（NSIS 默认 per-user 免提权；MSI 管理员终端装到 Program Files，普通终端自动降级 per-user）
Write-Host "==> 静默安装 ($Installer): $setup" -ForegroundColor Cyan
if ($Installer -eq 'msi') {
  $p = Start-Process msiexec.exe -ArgumentList "/i `"$setup`" /qn" -Wait -PassThru
} else {
  $p = Start-Process $setup -ArgumentList '/S' -Wait -PassThru
}
if ($p.ExitCode -ne 0) { throw "安装失败，退出码 $($p.ExitCode)" }

# 6) 定位安装后的主程序（注册表 InstallLocation 优先，候选路径兜底）
function Get-ToolboxExe {
  $uninstallKeys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  $entry = Get-ItemProperty $uninstallKeys -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like "${prod}*" } | Select-Object -First 1
  $dirs = @()
  if ($entry -and $entry.InstallLocation) { $dirs += ($entry.InstallLocation -replace '"', '') }
  if ($entry -and $entry.DisplayIcon) { $dirs += (Split-Path ($entry.DisplayIcon -replace '"', '')) }
  $dirs += "$env:LOCALAPPDATA\Toolbox", "$env:LOCALAPPDATA\Programs\Toolbox", "$env:LOCALAPPDATA\Programs\toolbox", 'C:\Program Files\toolbox'
  foreach ($d in $dirs) {
    $d = ($d -replace '"', '').TrimEnd('\')
    if (-not $d) { continue }
    $exe = Join-Path $d 'toolbox.exe'
    if (Test-Path $exe) { return $exe }
  }
  return $null
}
$exe = Get-ToolboxExe

# 7) 启动 + 收尾
if (-not $NoLaunch) {
  if ($exe) {
    Start-Process $exe
    Write-Host "==> 已启动: $exe" -ForegroundColor Green
  } else {
    Write-Host '==> 未定位到 toolbox.exe，请手动启动' -ForegroundColor Yellow
  }
}
Write-Host ''
Write-Host '================ 部署完成 ================' -ForegroundColor Green
Write-Host "版本:     $ver"
Write-Host "安装方式: $Installer"
Write-Host "主程序:   $exe"
Write-Host "安装包:   $stagingDir"
Write-Host "  - $msiFile"
Write-Host "  - $nsisFile"
Write-Host '==========================================' -ForegroundColor Green
if ($OpenFolder) { explorer $stagingDir }
