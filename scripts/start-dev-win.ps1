#Requires -Version 5.1
<#
.SYNOPSIS
    Start the Gavin desktop app in dev mode on Windows.

.DESCRIPTION
    The Windows half of the primary dev flow in docs/dev-setup.md: prerequisite
    checks, `npm ci` when the checkout has no node_modules, the daemon and MCP
    binaries the app auto-spawns as siblings of its own binary, then
    `npm run tauri dev`.

    The checks that only warn are the ones the app can start without: it will
    open and give you a terminal, but the named feature will not work.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\start-dev-win.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\start-dev-win.ps1 --release
#>
[CmdletBinding()]
param(
    # Forwarded to `tauri dev` after a `--` separator.
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$TauriArgs
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$App = Join-Path $Root 'app'

function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "warning: $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "error: $m" -ForegroundColor Red; exit 1 }
function Have($n) { return [bool](Get-Command $n -ErrorAction SilentlyContinue) }

# --- the three that are not optional ---------------------------------------

if (-not (Have 'node')) {
    Die "node not found. Install Node 22 or newer from https://nodejs.org, then open a new terminal so PATH picks it up."
}
if (-not (Have 'npm')) {
    Die "npm not found. It ships with Node -- check the Node install."
}
if (-not (Have 'cargo')) {
    Die "cargo not found. Install Rust from https://rustup.rs (take the MSVC toolchain, not GNU), then open a new terminal."
}

$hostLine = @(& rustc -Vv | Where-Object { $_ -like 'host: *' })
if ($hostLine.Count -gt 0 -and $hostLine[0] -notlike '*windows-msvc*') {
    Warn "rustc's host toolchain is '$($hostLine[0] -replace '^host: ', '')'. Gavin is built against *-pc-windows-msvc; the GNU toolchain is untested here."
}

# --- the ones that only cost a feature -------------------------------------

# Tauri draws through WebView2, not a bundled Chromium. Windows 11 ships the
# runtime, but a stripped image or an LTSC build can be without it, and the
# failure is a window that never paints rather than an error.
$webview2 = @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)
if (-not ($webview2 | Where-Object { Test-Path $_ })) {
    Warn "the WebView2 runtime was not found in the registry. If the app window opens blank, install it from https://developer.microsoft.com/microsoft-edge/webview2/."
}

# Emitted command lines keep their POSIX shape on every OS and run through Git
# for Windows' sh.exe -- crates/daemon/src/shell.rs resolves it by walking up
# from `git --exec-path`, so the same walk is what this check has to do. A
# terminal tab you type into is %COMSPEC% and does not depend on this.
if (-not (Have 'git')) {
    Warn "git not found. Gavin runs agent and tool command lines through Git for Windows' sh.exe; without Git for Windows those sessions cannot start. Plain terminal tabs are unaffected."
}
else {
    $execPath = (& git --exec-path) | Select-Object -First 1
    $shell = $null
    if ($execPath) {
        $dir = ($execPath -replace '/', '\').TrimEnd('\')
        for ($i = 0; $i -lt 5; $i++) {
            $dir = Split-Path -Parent $dir
            if (-not $dir) { break }
            foreach ($rel in @('usr\bin\sh.exe', 'bin\sh.exe')) {
                $candidate = Join-Path $dir $rel
                if (Test-Path $candidate) { $shell = $candidate; break }
            }
            if ($shell) { break }
        }
    }
    if (-not $shell -and -not (Have 'sh')) {
        Warn "no sh.exe found near '$execPath' and none on PATH. Agent and tool sessions need Git for Windows' POSIX shell; a git without it (or a git shim) will not do."
    }
}

# --- dependencies ----------------------------------------------------------

if (-not (Test-Path (Join-Path $App 'node_modules'))) {
    Say 'installing frontend dependencies (npm ci)'
    Push-Location $App
    try {
        & npm ci
        if ($LASTEXITCODE -ne 0) { Die 'npm ci failed.' }
    }
    finally { Pop-Location }
}

# tauri.conf.json's beforeDevCommand builds these two as well. Building them
# here first means a Rust error is the last thing on screen when it happens,
# instead of being scrolled away by vite and the app window.
Say 'building gavin-daemon and gavin-mcp'
Push-Location $Root
try {
    & cargo build -p gavin-daemon -p gavin-mcp
    if ($LASTEXITCODE -ne 0) {
        Die "cargo build failed. A missing linker means the Visual Studio Build Tools are not installed -- take the 'Desktop development with C++' workload from https://visualstudio.microsoft.com/downloads/."
    }
}
finally { Pop-Location }

# --- run -------------------------------------------------------------------

Say 'starting the app (npm run tauri dev)'
Set-Location $App
$npmArgs = @('run', 'tauri', 'dev')
if ($TauriArgs -and $TauriArgs.Count -gt 0) { $npmArgs += '--'; $npmArgs += $TauriArgs }
& npm @npmArgs
exit $LASTEXITCODE
