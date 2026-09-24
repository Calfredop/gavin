---
order: 5120
kind: note
title: Stopping a daemon reaches one pid, not every gavin-daemon
labels: memory
---
`cargo test -p app` and `cargo test --workspace` are safe to run beside live sessions: stopping a daemon only ever reaches the pid serving that one endpoint.

Why: the app reads the owner off the connection (`Stream::server_pid`), asks it to stop, and on failure terminates that pid alone — `taskkill /F /IM gavin-daemon.exe` and `pkill -x gavin-daemon` are gone from the code and survive only in comments. `stopping_one_endpoint_leaves_a_daemon_on_another_alone` asserts it. This is about what the APP does; running `pkill gavin-daemon` yourself still takes every session on the machine.
