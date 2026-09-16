#Requires -Version 5.1
<#
.SYNOPSIS
    Build the Windows NSIS installer for Gavin and open the output folder.

.DESCRIPTION
    Runs `npm run bundle` from app/ -- that is
    `tauri build --config src-tauri/tauri.bundle.conf.json -- --locked`,
    which stages gavin-daemon / gavin-mcp beside Gavin.exe and produces
    the setup .exe under target\release\bundle\nsis\. See
    app/src-tauri/BUNDLING.md for why that --config flag must stay.

    Defaults to THIS checkout so a local fix (MCP env passthrough, Cursor
    flags, ...) lands in the installer you are about to run. Pass -Stable
    to rebuild the sibling gavin-stable worktree instead (the recipe in
    .gavin-root/plans/chore-stable-release-install-on-windows.md).

    Stops only Gavin / gavin-daemon / gavin-mcp processes whose Path is
    under this build's target\release\, so the linker can replace them.
    Never kills by bare process name, and never touches an install under
    Programs\Gavin -- upgrading that is running the new setup.exe.

.PARAMETER Stable
    Build in ..\gavin-stable instead of this checkout. Re-cuts that
    worktree to this repo's main tip first (same as start-stable-win.ps1).

.PARAMETER SkipNpmCi
    Skip `npm ci` even when node_modules is missing. Useful when you
    already installed deps and only want the Rust/Tauri half.

.PARAMETER DryRun
    Print the build root and the expected installer path; do not build.

.PARAMETER NoOpen
    Do not open Explorer on the nsis folder when the build finishes.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\build-windows-installer.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\build-windows-installer.ps1 -Stable
#>
[CmdletBinding()]
param(
    [switch]$Stable,
    [switch]$SkipNpmCi,
    [switch]$DryRun,
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot

function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "warning: $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "error: $m" -ForegroundColor Red; exit 1 }
function Have($n) { return [bool](Get-Command $n -ErrorAction SilentlyContinue) }

# --- which tree ------------------------------------------------------------

if ($Stable) {
    $BuildRoot = Join-Path (Split-Path -Parent $Root) 'gavin-stable'
    if (-not (Test-Path (Join-Path $BuildRoot '.git'))) {
        Die ("no worktree at $BuildRoot.`n" +
            "Create one with:`n  git worktree add --detach $BuildRoot main`n" +
            "or drop -Stable to build this checkout.")
    }
}
else {
    $BuildRoot = $Root
}

$App = Join-Path $BuildRoot 'app'
$ReleaseDir = Join-Path $BuildRoot 'target\release'
$NsisDir = Join-Path $ReleaseDir 'bundle\nsis'

if ($DryRun) {
    Say "dry run: would build in $BuildRoot"
    Say "installer would land in $NsisDir"
    exit 0
}

# --- prerequisites ---------------------------------------------------------

if (-not (Have 'node')) {
    Die 'node not found. Install Node 22+ from https://nodejs.org, then open a new terminal.'
}
if (-not (Have 'npm')) {
    Die 'npm not found. It ships with Node.'
}
if (-not (Have 'cargo')) {
    Die 'cargo not found. Install Rust (MSVC toolchain) from https://rustup.rs.'
}

$hostLine = @(& rustc -Vv | Where-Object { $_ -like 'host: *' })
if ($hostLine.Count -gt 0 -and $hostLine[0] -notlike '*windows-msvc*') {
    Warn "rustc host is '$($hostLine[0] -replace '^host: ', '')'. Gavin expects *-pc-windows-msvc."
}

# --- optional stable worktree refresh --------------------------------------

if ($Stable) {
    if (-not (Have 'git')) {
        Die 'git not found; -Stable needs it to re-cut the worktree.'
    }
    $mainTip = (git -C $Root rev-parse main).Trim()
    $stableHead = (git -C $BuildRoot rev-parse HEAD).Trim()
    if ($stableHead -ne $mainTip) {
        Say "moving gavin-stable from $stableHead to main ($mainTip)"
        git -C $BuildRoot checkout -m --detach $mainTip
        if ($LASTEXITCODE -ne 0) {
            Die "could not move $BuildRoot to $mainTip -- resolve it by hand."
        }
    }
    else {
        Say "gavin-stable already at main ($mainTip)"
    }
}

# --- unlock release binaries in THIS build tree ----------------------------

$running = Get-Process -Name 'Gavin', 'gavin-daemon', 'gavin-mcp' -ErrorAction SilentlyContinue |
    Where-Object {
        $_.Path -and $_.Path.StartsWith($ReleaseDir, [System.StringComparison]::OrdinalIgnoreCase)
    }
if ($running) {
    Say ('stopping processes locking this release output: ' +
        (($running | ForEach-Object { "$($_.ProcessName) (pid $($_.Id))" }) -join ', '))
    $running | Stop-Process -Force
    Start-Sleep -Milliseconds 500
}

# --- deps + bundle ---------------------------------------------------------

Push-Location $App
try {
    if (-not $SkipNpmCi -and -not (Test-Path (Join-Path $App 'node_modules'))) {
        Say 'npm ci (no node_modules yet)'
        npm ci
        if ($LASTEXITCODE -ne 0) { Die 'npm ci failed.' }
    }

    Say 'npm run bundle -- sidecars + NSIS installer (several minutes)'
    npm run bundle
    if ($LASTEXITCODE -ne 0) { Die 'npm run bundle failed -- see output above.' }
}
finally {
    Pop-Location
}

# --- find and open ---------------------------------------------------------

if (-not (Test-Path $NsisDir)) {
    Die "bundle finished but $NsisDir is missing."
}

$setup = Get-ChildItem -Path $NsisDir -Filter '*-setup.exe' -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $setup) {
    Die "no *-setup.exe under $NsisDir."
}

# Sidecars must also exist in target\release\ (same names the installer
# copies beside Gavin.exe). Refuse a half-bundle before the human runs it.
foreach ($side in @('gavin-daemon.exe', 'gavin-mcp.exe', 'Gavin.exe')) {
    if (-not (Test-Path (Join-Path $ReleaseDir $side))) {
        Die "$side missing under $ReleaseDir after bundle."
    }
}

Say ("installer: " + $setup.FullName)
Say 'Install tip: quit Gavin, stop its daemon if needed, run the setup,'
$programs = Join-Path $env:LOCALAPPDATA 'Programs\Gavin'
$defaultInst = Join-Path $env:LOCALAPPDATA 'Gavin'
Say ("  and choose $programs (not the default $defaultInst).")
Say 'Then: scripts\start-stable-win.ps1 -SkipBuild   (or the Start menu entry)'

if (-not $NoOpen) {
    # /select highlights the setup exe in the folder.
    Start-Process explorer.exe -ArgumentList '/select,', $setup.FullName | Out-Null
}
