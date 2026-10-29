---
labels: memory
kind: note
title: An isolated daemon on macOS needs a short HOME
status: To Do
---
On macOS, start an isolated gavin-daemon with a short HOME such as /tmp/gvX: its socket is $HOME/Library/Application Support/gavin/daemon-dev.sock and must fit 103 bytes, and XDG_DATA_HOME (which the error suggests) is ignored there.
Why: a temp HOME under a long scratch or $TMPDIR path makes the daemon exit at bind with "socket path is N bytes".
