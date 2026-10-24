#requires -Version 5.1
<#
  msvc-env.ps1 — Inject the MSVC (Visual Studio Build Tools) environment into the CURRENT
  PowerShell session, so that `cargo build` can find link.exe / INCLUDE / LIB.

  Why this exists:
    - Rust's x86_64-pc-windows-msvc target needs the MSVC linker.
    - `Enter-VsDevShell` fails here with a "PATH/Path duplicate key" error, and the
      PowerShell tool blocks cmd.exe, so vcvars64.bat cannot be sourced normally.
    - This script replicates what vcvars64.bat does, by locating the toolchain itself.

  Usage (must be DOT-SOURCED so the variables land in your session):
      . D:\Personal\Projects\toolbox\scripts\msvc-env.ps1
      cargo build

  Note: environment changes are process-scoped only. Nothing is written to the system.
#>

$ErrorActionPreference = 'Stop'

function Write-Info($m) { Write-Host "[msvc-env] $m" -ForegroundColor Cyan }
function Write-Warn2($m) { Write-Host "[msvc-env] $m" -ForegroundColor Yellow }

# 1) Locate Visual Studio Build Tools (with VC tools workload)
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) { throw "vswhere.exe not found at $vswhere — Visual Studio Build Tools is not installed." }

$vsPath = & $vswhere -latest -products * `
  -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
  -property installationPath 2>$null
if (-not $vsPath) { throw "MSVC toolchain not found. Install 'Microsoft.VisualStudio.2022.BuildTools' with the VCTools workload." }
$vsPath = $vsPath.Trim()

# 2) Newest MSVC toolset
$msvcBase = Join-Path $vsPath 'VC\Tools\MSVC'
if (-not (Test-Path $msvcBase)) { throw "MSVC tools directory missing: $msvcBase" }
$msvcRoot = (Get-ChildItem $msvcBase -Directory | Sort-Object Name -Descending | Select-Object -First 1).FullName
if (-not $msvcRoot) { throw "No MSVC toolset found under $msvcBase" }

# 3) Newest Windows SDK
$sdkBase = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'
if (-not (Test-Path $sdkBase)) { throw "Windows SDK not found at $sdkBase" }
$sdkVer = (Get-ChildItem (Join-Path $sdkBase 'Include') -Directory |
           Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
           Sort-Object Name -Descending | Select-Object -First 1).Name
if (-not $sdkVer) { throw "No Windows SDK version found under $sdkBase\Include" }

# 4) Build INCLUDE / LIB / PATH (x64 native)
$msvcIncludes = @(
  (Join-Path $msvcRoot 'include')
)
$sdkIncludes = @(
  (Join-Path $sdkBase "Include\$sdkVer\ucrt"),
  (Join-Path $sdkBase "Include\$sdkVer\um"),
  (Join-Path $sdkBase "Include\$sdkVer\shared"),
  (Join-Path $sdkBase "Include\$sdkVer\winrt"),
  (Join-Path $sdkBase "Include\$sdkVer\cppwinrt")
) | Where-Object { Test-Path $_ }

$msvcLibs = @( (Join-Path $msvcRoot 'lib\x64') )
$sdkLibs = @(
  (Join-Path $sdkBase "Lib\$sdkVer\ucrt\x64"),
  (Join-Path $sdkBase "Lib\$sdkVer\um\x64")
) | Where-Object { Test-Path $_ }

$binDir = Join-Path $msvcRoot 'bin\Hostx64\x64'
if (-not (Test-Path $binDir)) { throw "MSVC x64 bin dir missing: $binDir" }

$env:INCLUDE = (($msvcIncludes + $sdkIncludes) -join ';')
$env:LIB     = (($msvcLibs + $sdkLibs) -join ';')
if ($env:Path -notlike "*$binDir*") { $env:Path = "$binDir;$env:Path" }

# 5) Verify the linker is reachable
$link = Get-Command link.exe -ErrorAction SilentlyContinue
if (-not $link) {
  Write-Warn2 "link.exe still not on PATH — check the MSVC installation."
  throw "MSVC environment injection failed: link.exe not found."
}

Write-Info "MSVC toolset : $msvcRoot"
Write-Info "Windows SDK  : $sdkVer"
Write-Info "link.exe     : $($link.Source)"

# 6) Convenience: make cargo reachable without touching the system PATH
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if ((Test-Path $cargoBin) -and ($env:Path -notlike "*$cargoBin*")) {
  $env:Path = "$cargoBin;$env:Path"
}
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if ($cargo) { Write-Info "cargo        : $($cargo.Source)" } else { Write-Warn2 "cargo not found on PATH (expected at $cargoBin)" }
