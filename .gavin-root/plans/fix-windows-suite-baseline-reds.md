---
order: 15360
kind: task
title: [fix] the four Rust suite reds that keep cargo test from being a gate on Windows
status: To Do
priority: medium
complexity: simple
---
`cargo test -p protocol` is 3 red and `cargo test -p gavin-mcp` is 1 red on every Windows run recorded on [feat-windows-port-on-a-windows-machine](./feat-windows-port-on-a-windows-machine.md) §1 — on `main` and on every branch, since 2026-09-11. None is a product bug, and while they stand no rail can use `cargo test` as a gate on this machine and the Windows CI job's `cargo test` steps stay `continue-on-error`. Fix the tests, not the code.

Measure first and record the exact names here: `cargo test -p protocol` and `cargo test -p gavin-mcp` on this checkout.

**protocol — the three Linux `XDG_DATA_HOME` / `HOME` tests** in the test module of `crates/protocol/src/lib.rs` (the `linux_*` / `*xdg_data_home*` family around `app_support_dir`). They assert the Linux data-directory rule on a platform where `app_support_dir` reads `%LOCALAPPDATA%`; `windows_ignores_xdg_and_home_the_way_macos_does` is the test that already carries the Windows claim. For each one: if the function under test has a platform branch, gate the test to the platform whose rule it states (`#[cfg(target_os = "linux")]` or `#[cfg(unix)]`, the way the macOS test is gated); if the rule is meant to hold everywhere, make the expectation platform-aware instead. Never weaken a claim to make it pass; say in the commit body which of the two each test was.

**gavin-mcp — `create_plan_resolves_relative_context_and_maps_arguments`** in `crates/gavin-mcp/src/main.rs` compares a path against a hardcoded forward slash. Compare through the spelling the daemon actually reports (`protocol::wire_path`), or build the expected string the way the code does and normalise both sides — whichever the test is really claiming.

Then the whole set, one crate at a time (a parallel workspace run gets killed for memory on this machine): `cargo test -p protocol`, `cargo test -p gavin-mcp`, `cargo test -p gavin-daemon -- --test-threads=4` with no `--skip` at all (after [the gavin::tests card](./gavin-tests-is-10-red-on-windows-and-this-card-s-filter-is-why-nobody-had-seen-it.md) it is 0 red), `cargo test -p app`. Record the four counts here with the commit they were taken at. Commit only the files you touched.
