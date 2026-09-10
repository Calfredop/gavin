---
order: 14336
kind: task
title: [fix] start-dev-win.ps1 truncates daemon.log on every start
status: To Do
complexity: trivial
---
`scripts/start-dev-win.ps1` starts the daemon with
`Start-Process -RedirectStandardOutput $log`, and PowerShell opens that
file for overwrite. The app opens the same `%LOCALAPPDATA%\gavin\daemon.log`
in append mode on purpose (`daemon_log_file` in `app/src-tauri/src/daemon.rs`):
the interesting case is a daemon that died and was replaced, and truncating
on start is exactly when the line explaining the death is lost. On this
machine the log holds one script start and one app start, and nothing about
what killed the first daemon.

Make the script append. `Start-Process` cannot; the usual route is to start
the daemon through `cmd /c start /b "" "<exe>" >> "<log>" 2>&1`, or to
open the file with `[System.IO.File]::Open(..., Append)` and hand the handle
to a `System.Diagnostics.Process` with `UseShellExecute = $false` and
redirected output. Either way the daemon must stay a child of the script
and not of `tauri dev`, which is the reason the script starts it at all.
Keep the `.err` file or fold it into the same log; the app sends both
streams to one file.

`start-dev-win.ps1` is modified and uncommitted in the shared tree right
now; land that first or do this on top of it.
