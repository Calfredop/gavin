#Requires -Version 5.1
<#
.SYNOPSIS
    Start the installed, stable Gavin on Windows -- not the dev tree's.

.DESCRIPTION
    The counterpart of start-dev-win.ps1 for the release install described
    in .gavin-root/plans/chore-stable-release-install-on-windows.md: a
    Gavin built from a pinned commit and installed outside the checkout, so
    that no edit and no `cargo build` in the dev tree can reach it or the
    daemon it owns.

    In order: find the stable Gavin.exe, refuse one that has no
    gavin-daemon.exe / gavin-mcp.exe beside it (the app would spawn nothing
    and write an MCP path that does not exist), say which daemon is already
    listening so a dev daemon is not adopted by surprise, then start the app
    detached from this terminal.

    It does NOT start the daemon. The packaged app spawns it detached --
    DETACHED_PROCESS, its own process group, and out of any job that permits
    breakaway -- appending to %LOCALAPPDATA%\gavin\daemon.log (a debug build
    binds its own pipe and writes daemon-dev.log beside it). Starting it
    here would make it this script's child instead, and a PowerShell
    redirect would truncate that log on every run.

    Run it from your own terminal or a shortcut. A Gavin started from inside
    `tauri dev` joins that job and dies with it, and one started from an
    agent's tool call hands that agent's CLAUDE_* environment to every tab
    (.gavin-root/plans/issue-launcher-env-leaks-into-sessions.md).

.PARAMETER Path
    The Gavin.exe to start. Defaults to %LOCALAPPDATA%\Programs\Gavin (the
    folder to choose in the installer), then the installer's own default,
    then the stable worktree's release output beside this checkout.

.PARAMETER DryRun
    Do every check and say what would be started, without starting it.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\start-stable-win.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\start-stable-win.ps1 -Path D:\Gavin\Gavin.exe
#>
[CmdletBinding()]
param(
    [string]$Path,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot

function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "warning: $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "error: $m" -ForegroundColor Red; exit 1 }

# --- which Gavin -----------------------------------------------------------

$candidates = @()
if ($Path) {
    $candidates += $Path
}
else {
    # The folder to choose in the installer, then the installer's own
    # default, then the stable worktree's release output, which is also
    # outside the dev checkout and therefore also safe from its builds.
    #
    # The installer defaults to %LOCALAPPDATA%\Gavin, and that is the
    # daemon's state directory (%LOCALAPPDATA%\gavin, case-insensitively):
    # the binaries land beside daemon.log and the three SQLite files. It
    # works -- the uninstaller deletes only what it installed and removes
    # the folder only when empty -- but Programs\Gavin keeps them apart.
    $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Gavin\Gavin.exe')
    $candidates += (Join-Path $env:LOCALAPPDATA 'Gavin\Gavin.exe')
    $candidates += (Join-Path (Split-Path -Parent $Root) 'gavin-stable\target\release\Gavin.exe')
}
$exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) {
    Die ("no stable Gavin found. Looked for:`n  " + ($candidates -join "`n  ") +
        "`nBuild one with 'npm run bundle' in the stable worktree and install it, or pass -Path.")
}
$exe = (Resolve-Path $exe).Path
$dir = Split-Path -Parent $exe

# The dev tree's own output is the one thing this script must never start:
# every cargo build replaces it, and tauri dev's job kills it.
if ($exe -like (Join-Path $Root 'target\*')) {
    Die "$exe is inside the dev checkout. Use start-dev-win.ps1 for that build."
}

# --- the sidecars ----------------------------------------------------------

# resolve_daemon_binary_path and resolve_mcp_binary_path both join against
# the app's own directory. Missing sidecars are not a degraded start, they
# are an app with no daemon and a workspace config naming a file that does
# not exist -- so this is a refusal, not a warning.
foreach ($side in @('gavin-daemon.exe', 'gavin-mcp.exe')) {
    if (-not (Test-Path (Join-Path $dir $side))) {
        Die "$side is not beside $exe. See section 1 of .gavin-root/plans/feat-windows-port-on-a-windows-machine.md."
    }
}

# --- who is listening already ----------------------------------------------

# The app adopts whatever daemon is listening on ITS endpoint, and after
# per-build isolation that can only ever be a release daemon: a debug build
# binds daemon-dev.sock and is tagged `gavin-daemon-dev-sock`, a different
# pipe this app never looks at. So the question is asked of the PIPE rather
# than of `Get-Process -Name gavin-daemon`, which answers for every daemon on
# the machine and cannot tell which endpoint any of them is serving.
#
# The release tag is a prefix of the dev one, hence the second clause.
$pipes = [System.IO.Directory]::GetFiles('\\.\pipe\')
$stable = @($pipes | Where-Object { $_ -like '*gavin-daemon-sock*' -and $_ -notlike '*gavin-daemon-dev-sock*' })
$dev = @($pipes | Where-Object { $_ -like '*gavin-daemon-dev-sock*' })
if ($stable.Count -eq 0) {
    Say 'no release daemon is listening; the app will spawn its own from beside itself'
}
else {
    Say 'a release daemon is already listening; the app will adopt it'
}
# No longer a warning. A dev daemon used to be a hazard here because the
# stable app would adopt it and then lose every session when tauri dev tore
# its job down. It cannot be adopted now, and Restart daemon in either app
# kills only the pid owning the endpoint it connected to.
if ($dev.Count -gt 0) {
    Say 'a dev daemon is listening too, on its own pipe. It will not be adopted, and this app cannot stop it.'
}

if ($env:CLAUDECODE) {
    Say "started from an agent's tool call. A daemon built since the launcher-env fix strips that agent's session identity and its non-interactive git pins from every tab it opens; an installed build older than that still passes them through."
}

# --- go ---------------------------------------------------------------------

if ($DryRun) {
    Say "dry run: would start $exe"
    exit 0
}
Say "starting $exe"
Start-Process -FilePath $exe -WorkingDirectory $dir | Out-Null
Say "daemon log: $(Join-Path $env:LOCALAPPDATA 'gavin\daemon.log')"
