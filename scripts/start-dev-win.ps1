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

# tauri.conf.json's beforeDevCommand runs this same script. Running it here
# first means a Rust error is the last thing on screen when it happens,
# instead of being scrolled away by vite and the app window.
#
# Through dev-sidecars.mjs and not a bare `cargo build`, for what that file
# explains: this checkout's OTHER agent sessions are each running a
# `target\debug\gavin-mcp.exe`, Windows will not let cargo unlink a running
# image, and the script parks the held ones so the fresh binaries can take
# their names. A `cargo build -p gavin-daemon -p gavin-mcp` here would fail
# on `os error 5` exactly as often as the hook used to.
Say 'building gavin-daemon and gavin-mcp'
Push-Location $Root
try {
    & node (Join-Path $App 'src-tauri\dev-sidecars.mjs')
    if ($LASTEXITCODE -ne 0) {
        # No diagnosis offered here. This used to blame missing Visual Studio
        # Build Tools, which is one cause of a failed cargo build and not the
        # one a developer on this platform actually meets -- and it buried the
        # file-in-use explanation dev-sidecars.mjs has just printed, naming the
        # pids holding the binary. Whatever the cause, the lines above it are
        # the answer; repeating a guess over them is how the wrong one sticks.
        Die 'building the sidecars failed -- see the error above. A missing linker means the Visual Studio Build Tools are not installed: take the "Desktop development with C++" workload from https://visualstudio.microsoft.com/downloads/.'
    }
}
finally { Pop-Location }

# --- the daemon, started HERE and not by the app ---------------------------

# A daemon the app spawns is a child of the app, and on Windows a child
# joins its parent's job object. `tauri dev` kills that job on every
# rebuild, so a source edit took the daemon -- and every terminal session it
# owned -- down with the app about two seconds later. An agent developing
# gavin inside gavin edits source constantly, which made that workflow
# impossible rather than merely noisy.
#
# The app cannot fix this from the inside. It asks for
# CREATE_BREAKAWAY_FROM_JOB and tauri dev's job REFUSES it -- the app records
# that refusal in its daemon log rather than pretending it detached.
# Starting the daemon HERE, before the app exists, is what actually works: it
# is a child of this script, it never enters that job, and the app finds it
# already listening and adopts it instead of spawning one of its own.
#
# Only when nothing is listening. A daemon that outlived the last dev session
# is exactly the one worth keeping -- that is the whole point of it outliving
# the app.
# The DEV pipe specifically. A debug build binds daemon-dev.sock, which
# `pipe_name_for_path` tags `gavin-daemon-dev-sock`; a release install binds
# daemon.sock and is tagged `gavin-daemon-sock`. Matching the release tag here
# would see the STABLE daemon, decide one is already listening, and start the
# dev app with no dev daemon at all -- and since the release tag is a prefix of
# the dev one, it has to be the specific pattern rather than the general one.
$listening = @([System.IO.Directory]::GetFiles('\\.\pipe\') | Where-Object { $_ -like '*gavin-daemon-dev-sock*' })
if ($listening.Count -gt 0) {
    Say 'a daemon is already listening -- leaving it alone'
}
else {
    $state = Join-Path $env:LOCALAPPDATA 'gavin'
    New-Item -ItemType Directory -Force $state | Out-Null
    # Per build, like the pipe above: the release daemon appends to
    # daemon.log, and two daemons interleaving into one file is a log nobody
    # can read. `daemon_log_path` in app/src-tauri/src/daemon.rs picks the
    # same name when the APP spawns the daemon instead of this script.
    $log = Join-Path $state 'daemon-dev.log'
    $exe = Join-Path $Root 'target\debug\gavin-daemon.exe'
    Say "starting gavin-daemon detached from the app (output -> $log)"
    if (-not (Test-Path $exe)) { Die "cargo build reported success but $exe is missing." }

    # APPENDED, never overwritten. The app opens this same file with
    # `.append(true)` (`daemon_log_file` in app/src-tauri/src/daemon.rs), and
    # the case that motivates it is a daemon that died and was replaced:
    # truncating on start is precisely the moment the line explaining the
    # death is lost, leaving a log that can only ever describe the daemon
    # still running -- the one nobody needs explained.
    #
    # Which is why this no longer goes through `Start-Process`.
    # `-RedirectStandardOutput` is the only file redirection it offers and it
    # always opens for overwrite, and the .NET layer underneath redirects to
    # a PIPE rather than to a file, so whoever drains that pipe has to
    # outlive the daemon -- while this script exits when `tauri dev` does.
    # `cmd`'s `>>` is the redirection that opens with FILE_APPEND_DATA, and
    # the handle it hands the daemon keeps working long after the cmd that
    # made it has gone.
    #
    # The command line is built here and passed as `Arguments`, which
    # ProcessStartInfo forwards verbatim, because PowerShell's own native
    # argument quoting rewrites an embedded `"` as `\"` -- cmd reads that
    # backslash literally, so a checkout or profile path with a space in it
    # would come apart. `/s` makes cmd strip exactly the outer quotes and
    # nothing else, `start ""` supplies the empty window title `start` would
    # otherwise take the exe path for, and `/b` means no window.
    #
    # `CreateNoWindow` puts the daemon on an invisible console of its own,
    # for the reason `DETACHED_FLAGS` in daemon.rs carries `CREATE_NO_WINDOW`:
    # a daemon sharing this terminal's console dies when the terminal closes,
    # which is the "outlives the app" promise broken a second way.
    #
    # Both streams go to the one file (`2>&1`), as the app sends them. The
    # separate `.err` went with the truncation that used to write it.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
    $psi.Arguments = '/s /c "start "" /b "' + $exe + '" >> "' + $log + '" 2>&1"'
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    [System.Diagnostics.Process]::Start($psi) | Out-Null
}

# --- run -------------------------------------------------------------------

Say 'starting the app (npm run tauri dev)'
Set-Location $App
$npmArgs = @('run', 'tauri', 'dev')
if ($TauriArgs -and $TauriArgs.Count -gt 0) { $npmArgs += '--'; $npmArgs += $TauriArgs }
& npm @npmArgs
exit $LASTEXITCODE
