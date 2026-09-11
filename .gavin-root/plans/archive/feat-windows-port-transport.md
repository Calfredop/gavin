---
kind: task
title: [feat] IPC transport abstraction (unix socket / named pipe)
labels: windows
parent: feat-windows-port.md
---
Replace gavin's direct use of `std::os::unix::net` with one transport module so the workspace compiles on Windows.

Today `UnixListener` / `UnixStream` are imported unconditionally in `crates/daemon/src/server.rs`, `crates/daemon/src/gavin.rs`, `crates/daemon/src/main.rs`, `crates/gavin-mcp/src/main.rs`, `app/src-tauri/src/daemon.rs` and `app/src-tauri/src/session.rs`. Rust's std has no `std::os::unix` on Windows targets, so all three processes fail to build.

Add `protocol::transport` (or a small `gavin-transport` crate) exposing `Listener::bind(&Endpoint)`, `Stream::connect(&Endpoint)`, `Stream: Read + Write + Send`, `try_clone`, `shutdown`, `set_read_timeout`, and a `pair()` helper for tests: the daemon tests use `UnixStream::pair()` heavily. On Unix wrap `std::os::unix::net`. On Windows use named pipes, either the `interprocess` crate's local sockets or `CreateNamedPipeW` from the `windows` crate if you would rather add no dependency, with the endpoint `\\.\pipe\gavin-<user>`. `Endpoint` is derived from `protocol::socket_path()` so every call site stays one line.

The wire format must not change: newline-delimited JSON through `read_message` / `write_message` in the protocol crate. Keep the `peer_addr`-based reconnect tests in session.rs working, or rewrite them against the abstraction. Gate the `PermissionsExt` chmod on the socket in daemon main.rs / server.rs under `#[cfg(unix)]`.

Do not touch proc.rs, pty.rs or path handling; those are sibling items on the parent card.

Done when `cargo test --workspace` is green on macOS (re-run `gavin::tests` alone if it flakes) and `cargo check -p protocol -p gavin-daemon -p gavin-mcp --target x86_64-pc-windows-msvc` passes. Add the target with rustup; `check` needs no linker. Then tick the parent's "Transport" item.
