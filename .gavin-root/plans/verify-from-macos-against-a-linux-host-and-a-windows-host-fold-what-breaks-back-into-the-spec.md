---
kind: task
title: Verify ssh workspaces from macOS against a Linux host and a Windows host
parent: feat-ssh-support.md
complexity: moderate
---
A verification pass on real machines, not a coding task: the owner's, or an agent with ssh reach to a Linux host and a Windows host from a macOS desktop. Read `docs/ssh-workspaces.md` and `docs/superpowers/specs/2026-09-22-ssh-workspaces-design.md` first. It needs the frontend task landed.

On each host: install `gavin-daemon` built from this branch (`cargo build --release -p gavin-daemon`), put it on PATH or note its path; confirm `ssh <host> gavin-daemon bridge` prints a `BridgeReady` line and then relays `{"type":"GetProtocolVersion"}` typed on stdin. On the Windows host also check: the ssh session's default shell (cmd.exe and PowerShell, both), that the daemon the bridge started keeps running after the ssh session ends (`Get-Process gavin-daemon`), that closing the app does not end it, and that the workspace root is written as `C:/Users/...`.

From the macOS desktop: create an ssh workspace to each host; open terminals (a shell, then `claude` or another agent); edit a card on the host and watch the board and plan tree update; kill a session; restart the local daemon from Settings (the links must survive it); pull the network (that workspace shows `remote-link-lost`; the rest of the app keeps working); Reconnect.

Record what broke, with the exact ssh stderr and the app's message, as a list in this card. Fold every rule that changed into the spec's §5 (paths and OS) and into `docs/ssh-workspaces.md`. File a card per bug.
