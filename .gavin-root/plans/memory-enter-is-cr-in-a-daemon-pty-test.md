---
order: 19456
labels: memory
kind: note
title: Typing into a session in a test means CR, not LF
status: To Do
---
A daemon test that types a line into a session must end it with `\r`,
not `\n` — see `type_line` in `server.rs`'s test module.

Why: Enter is a carriage return on the wire, which is what xterm.js
sends and what the daemon passes through untranslated. A session with a
COMMAND runs through Git for Windows' `sh.exe`, whose MSYS tty layer
forgives `\n`, which is why most of the suite gets away with it. A
session with NO command — every recovered one — gets
`interactive_shell()`, i.e. `cmd.exe`, a console reading key events
where `\n` is Ctrl-J: the line is typed, never submitted, and the test
waits out its whole 30s budget for output from a command that never ran.
