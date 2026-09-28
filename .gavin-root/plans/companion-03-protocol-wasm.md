---
kind: task
title: Companion 03: protocol crate compiles to WASM
status: To Do
labels: ready-for-agent
parent: companion.md
complexity: moderate
---
Blocked by: none (can start immediately)

Part of `companion.md`. Read the spec (section "The shared protocol crate") first.

## What to build

A refactor that makes the later work easy. The shared protocol crate cannot compile to `wasm32-unknown-unknown`, for three reasons:

- its local transport module is compiled on every platform, yet has only Unix and Windows implementations;
- random ids read the operating system's random source;
- the platform data paths read the environment and canonicalise through the filesystem.

Put those operating-system-specific parts behind a Cargo feature, on by default for the daemon, the app host and gavin-mcp, so the Companion core can depend on the rest from WASM. Existing consumers must see no behaviour change.

## Acceptance criteria

- [ ] The protocol crate checks for `wasm32-unknown-unknown` with the OS feature off
- [ ] `cargo test --workspace` passes unchanged. Re-run the daemon's `gavin::tests` alone before calling a failure a regression.
- [ ] The pairing SAS and its pinned test vector stay available without the OS feature
- [ ] CI runs the WASM check
