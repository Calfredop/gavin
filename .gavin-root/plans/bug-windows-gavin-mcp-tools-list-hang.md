---
kind: task
title: [bug] Windows gavin-mcp hangs on tools/list (Cursor MCP)
status: In Progress
priority: high
labels: windows
---
# Fix: Cursor MCP "Error loading MCP, unable to list tools" on Windows

## Problem

On Windows, Cursor fails to load the Gavin MCP server with:

> Error loading MCP, unable to list tools.

`gavin-mcp` answers `initialize` immediately, then **never returns** from `tools/list` when `GAVIN_SESSION_SOCKET` is the usual filesystem path:

`%LOCALAPPDATA%\gavin\daemon.sock`

Cursor times out listing tools and surfaces that error. Existing agent tabs that loaded MCP before a daemon restart stay broken until MCP is reloaded / a new session is started.

## Environment (repro machine)

- OS: Windows 10/11
- Gavin installed under `%LOCALAPPDATA%\Programs\Gavin\` (`Gavin.exe`, `gavin-daemon.exe`, `gavin-mcp.exe`)
- Cursor project MCP from `.cursor/mcp.json` (stdio → `gavin-mcp.exe`, env `GAVIN_SESSION_*`)
- Observed after a Gavin update/reinstall; a full Gavin restart sometimes recovers `tools/list` for a fresh probe, but the underlying path/pipe mismatch is still wrong and can regress

## What is actually listening

`gavin-daemon` logs:

`gavin-daemon listening on C:\Users\<user>\AppData\Local\gavin\daemon.sock`

But on Windows:

1. **No** `daemon.sock` file appears under `%LOCALAPPDATA%\Gavin` / `gavin`
2. The live endpoint is a **named pipe**: `\\.\pipe\gavin-daemon-sock-<hash>` (example hash seen: `1ea8c76cbf57866f`)
3. `UnixDomainSocketEndPoint` connect to the filesystem `daemon.sock` path fails with connection refused
4. Opening the named pipe succeeds

## Smoking-gun reproduction (PowerShell)

With Gavin running and `GAVIN_SESSION_*` set (as when an agent is launched from Gavin):

```powershell
function Probe-ToolsList([string]$socket) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "$env:LOCALAPPDATA\Programs\Gavin\gavin-mcp.exe"
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $psi.Environment['GAVIN_SESSION_ID'] = $env:GAVIN_SESSION_ID
  $psi.Environment['GAVIN_SESSION_TOKEN'] = $env:GAVIN_SESSION_TOKEN
  $psi.Environment['GAVIN_SESSION_SOCKET'] = $socket
  $p = [Diagnostics.Process]::Start($psi)
  $outTask = $p.StandardOutput.ReadToEndAsync()
  $errTask = $p.StandardError.ReadToEndAsync()
  $p.StandardInput.WriteLine('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0.0.1"}}}')
  $p.StandardInput.WriteLine('{"jsonrpc":"2.0","method":"notifications/initialized"}')
  $p.StandardInput.WriteLine('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')
  $p.StandardInput.Flush()
  if (-not $p.WaitForExit(5000)) { $p.Kill(); $null = $p.WaitForExit(2000) }
  $out = $outTask.Result
  "socket=$socket"
  "has_tools_list=$($out -match '"id":2')"
  "tool_count=$(([regex]::Matches($out, '"name"\s*:\s*"gavin_')).Count)"
  if ($errTask.Result) { "stderr=$($errTask.Result.Trim())" }
}

# Broken (hangs / no id:2 within timeout) when the Windows path→pipe mapping fails:
Probe-ToolsList $env:GAVIN_SESSION_SOCKET

# Works — lists ~17 gavin_* tools — when pointed at the live pipe:
$pipe = (Get-ChildItem \\.\pipe\ | Where-Object Name -like 'gavin-daemon-sock-*' | Select-Object -First 1).Name
Probe-ToolsList "\\.\pipe\$pipe"
```

Expected after the fix: **both** probes return `has_tools_list=True` and a non-zero `tool_count` within a few seconds. Never hang.

## Root cause (hypothesis to verify in code)

On Windows, the daemon advertises / clients receive a Unix-style socket path (`...\daemon.sock`) but actually listen on `\\.\pipe\gavin-daemon-sock-<hash>`.

`gavin-mcp` (and/or the shared daemon client) attempts to connect using the filesystem path in a way that **blocks indefinitely** instead of:

- connecting via the Windows named-pipe mapping derived from that path, or
- failing fast with a clear error

`initialize` does not need the daemon (or does not block on it); `tools/list` does → Cursor reports "unable to list tools."

Relevant binaries/strings observed: `gavin-mcp` knows about `\\.\pipe\gavin-`, `GAVIN_SESSION_SOCKET`, Hello / `HelloAck`, and version skew messages (`daemon is newer than this gavin-mcp`, `re-execing into the updated gavin-mcp`). Fix the connect path, not Cursor.

## Required fix

1. **Windows daemon client in `gavin-mcp` (and any shared IPC client):** when `GAVIN_SESSION_SOCKET` (or the default `%LOCALAPPDATA%\gavin\daemon.sock`) is set, connect to the same named pipe the daemon creates — do not hang on a missing/unusable AF_UNIX file path.
2. **Fail fast:** if the daemon is unreachable, return an MCP error for `tools/list` within a short timeout (1–2s), with stderr naming the socket/pipe attempted. Never block forever.
3. **Keep the public env contract:** Cursor/`mcp.json` should keep using `GAVIN_SESSION_SOCKET=...\daemon.sock`. Do not require users to paste `\\.\pipe\...` into MCP config.
4. **Optional hardening:** if the daemon is restarted, existing MCP stdio children should either reconnect or exit so Cursor can relaunch them; document "reload MCP / new agent tab" if a reload is still required.

## Out of scope

- Changes in the arcadia-redux / customer app repo
- Asking users to hardcode named pipe paths in `.cursor/mcp.json`
- Reworking MCP tool schemas

## Acceptance

- [ ] On Windows, with Gavin open and daemon running, `gavin-mcp` + default `GAVIN_SESSION_SOCKET=...\daemon.sock` returns `tools/list` with the full built-in tool set in < 2s
- [ ] Cursor project MCP loads without "unable to list tools"
- [ ] Named pipe still works if someone passes `\\.\pipe\gavin-daemon-sock-*` explicitly
- [ ] If the daemon is down, `tools/list` errors quickly with a readable message (no hang)
- [ ] Cold start: quit Gavin completely, start again, open a **new** Cursor agent from Gavin → MCP tools appear without manual pipe surgery
- [ ] Human test: On Windows, with Gavin open: rebuild/install this tree's gavin-mcp, set GAVIN_SESSION_SOCKET to %LOCALAPPDATA%\gavin\daemon.sock, run the card's Probe-ToolsList — expect has_tools_list=True and non-zero tool_count in under 2s (no hang). Then confirm Cursor project MCP loads without "unable to list tools".
- [ ] Human test: On Windows: quit Gavin completely so no gavin-daemon is running, then Probe-ToolsList against %LOCALAPPDATA%\gavin\daemon.sock — tools/list may still return (it is local), but the first tools/call that needs the daemon must error within ~2s with a message naming the sock path and \\.\pipe\gavin-…; never hang. Then cold-start Gavin and open a new Cursor agent from Gavin — MCP tools appear without pasting a pipe path.

## Notes from investigation (2026-10-05)

- Second `gavin-daemon` correctly reports another instance already listening on `daemon.sock` even when no sock file exists — pipe is the real transport.
- Workaround that unblocked a hung client: set `GAVIN_SESSION_SOCKET=\\.\pipe\gavin-daemon-sock-<hash>` (hash may change; not a product fix).
- After one full Gavin restart, default-path `tools/list` worked again in an out-of-process probe, but **already-open Cursor chats** still had no `gavin` MCP namespace until MCP reload / new session — call that out in release notes if reload remains necessary.

## Fix landed (code, awaiting Windows human tests)

`tools/list` itself never talks to the daemon — it returns the static tool list. The hang was on the Windows connect path when a later probe/`tools/call`/`prepare` touched the daemon:

1. **`win32_pipe_name`** — a `GAVIN_SESSION_SOCKET` that is already `\\.\pipe\…` is opened as-is; re-hashing that string used to invent a second pipe nobody listens on (breaking the probe workaround and acceptance #3).
2. **2s connect budget** — `ERROR_PIPE_BUSY` used to loop forever with `WaitNamedPipeW`; connect now fails with a timeout that names the sock path and the pipe.
3. **gavin-mcp probe timeout** — version-probe reads are capped at 2s and connect errors name `path (pipe \\.\pipe\…)`.

Unit tests cover the pass-through and the error labels. Reload MCP / open a new agent tab after installing the build — existing Cursor stdio children will not pick it up.
