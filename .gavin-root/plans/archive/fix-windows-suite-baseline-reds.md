---
kind: task
title: [fix] the four Rust suite reds that keep cargo test from being a gate on Windows
status: Done
priority: medium
complexity: simple
---
`cargo test -p protocol` is 3 red and `cargo test -p gavin-mcp` is 1 red on every Windows run recorded on [feat-windows-port-on-a-windows-machine](./feat-windows-port-on-a-windows-machine.md) §1 — on `main` and on every branch, since 2026-09-11. None is a product bug, and while they stand no rail can use `cargo test` as a gate on this machine and the Windows CI job's `cargo test` steps stay `continue-on-error`. Fix the tests, not the code.

Measure first and record the exact names here: `cargo test -p protocol` and `cargo test -p gavin-mcp` on this checkout.

**protocol — the three Linux `XDG_DATA_HOME` tests** in the test module of `crates/protocol/src/lib.rs`. The prescribed remedy below is still the right shape, but **the mechanism this card originally stated is stale** — corrected by the 2026-09-22 board audit, which read the code rather than re-deriving from the card:

The tests are no longer asserting a Linux rule against a Windows `app_support_dir`; that was fixed by parameterising the function as `resolve_app_support_dir(home, xdg, localappdata, userprofile, os)`, and it takes `HostOs` explicitly now. They still fail, for a different and more interesting reason — `crates/protocol/src/lib.rs:2893-2896`:

```rust
let xdg = xdg_data_home.filter(|x| !x.is_empty()).map(PathBuf::from).filter(|x| x.is_absolute());
```

On Windows `Path::is_absolute()` is **false** for a rootful-but-prefixless POSIX path like `/data/gavin-home`, so every test feeding an absolute POSIX `XDG_DATA_HOME` falls through to the `HOME` branch. Exactly three:

- `linux_honours_an_absolute_xdg_data_home` (`lib.rs:5042-5046`) — expects `/data/gavin-home/gavin`, gets `/home/x/.local/share/gavin`.
- `an_absolute_xdg_data_home_is_enough_on_its_own` (`lib.rs:5076-5081`) — `home = None`, so the fallthrough is `Err` and `.unwrap()` panics.
- `the_socket_fits_sun_path_under_a_long_xdg_data_home` (`lib.rs:5262-5278`) — same `.unwrap()` panic.

The neighbours are safe and must stay untouched: `linux_defaults_to_the_xdg_default_when_the_variable_is_unset` (`:5036`), `an_empty_or_relative_xdg_data_home_is_ignored…` (`:5048`) and `macos_keeps_application_support_and_ignores_xdg` (`:5026`) never reach `is_absolute`, and `PathBuf` equality compares components, so `\` vs `/` does not bite. The module compiles fine on Windows (`SUN_PATH_MAX` is unconditional at `:2719`, `check_sun_path` is `#[cfg_attr(not(unix), allow(dead_code))]` at `:2995`) — these are three failures, not a build break.

Note the whole test module is currently ungated: `grep '#\[cfg'` past line 4900 returns nothing. So the fix is to gate each of the three to the platform whose rule it states (`#[cfg(target_os = "linux")]` or `#[cfg(unix)]`), **or** — arguably better, since the function is `HostOs`-parameterised and so genuinely cross-platform — make `is_absolute` judged against the `HostOs` being asked about rather than the host running the test. Decide which, and say in the commit body which of the two each test was. Never weaken a claim to make it pass.

**gavin-mcp — `create_plan_resolves_relative_context_and_maps_arguments`** in `crates/gavin-mcp/src/main.rs` compares a path against a hardcoded forward slash. Compare through the spelling the daemon actually reports (`protocol::wire_path`), or build the expected string the way the code does and normalise both sides — whichever the test is really claiming.

Confirmed unchanged on 2026-09-22: `main.rs:3001` still reads `assert_eq!(context_folder, "/ws/.");` while the value comes from `resolve_against_root` (`main.rs:268-275`), which is `root.join(p)` — so `\ws\.` on Windows. No `protocol::wire_path` anywhere near it.

Then the whole set, one crate at a time (a parallel workspace run gets killed for memory on this machine): `cargo test -p protocol`, `cargo test -p gavin-mcp`, `cargo test -p gavin-daemon -- --test-threads=4` with no `--skip` at all (after [the gavin::tests card](./gavin-tests-is-10-red-on-windows-and-this-card-s-filter-is-why-nobody-had-seen-it.md) it is 0 red), `cargo test -p app`. Record the four counts here with the commit they were taken at. Commit only the files you touched.

## Result — fixed at `5fb6f363` (branch `win/suite-reds`, 2026-09-23)

**Measured first, before any edit.** The four reds were exactly the ones this card names:

- `cargo test -p protocol` — 112 passed / 3 failed: `tests::linux_honours_an_absolute_xdg_data_home`, `tests::an_absolute_xdg_data_home_is_enough_on_its_own`, `tests::the_socket_fits_sun_path_under_a_long_xdg_data_home`.
- `cargo test -p gavin-mcp` — 56 passed / 1 failed: `tests::create_plan_resolves_relative_context_and_maps_arguments`, `left: "/ws\.", right: "/ws/."`.

**protocol — all three took the second remedy, not the gate.** `is_absolute` is now judged against the `HostOs` being asked about, via a private `xdg_path_is_absolute` (a leading `/`, which is what the XDG spec's "absolute" means) rather than `Path::is_absolute`. `#[cfg]`-gating each test would have bought a green Windows run by deleting the coverage: the XDG layout is the one thing a Windows developer cannot otherwise exercise, and the seam exists precisely so they can — its own doc comment says it was split out so the per-OS rule could be tested at every value without `set_var`. Gating would also have left the host dependency in place to mislead the next reader. **No shipped behaviour changes on any platform:** the XDG branch is unreachable on Windows (the Windows branch returns first), and on unix a leading `/` is exactly what `is_absolute` means. The three named neighbours were not touched, and the totals confirm nothing was skipped: 112 + 3 = 115.

**gavin-mcp — the test, not the code.** Checked first whether the backslash was a product bug, since `wire_path`'s doc says every path gavin puts on the wire uses forward slashes. It is not: `wire_path` appears nowhere in `gavin-mcp`, and every outgoing path — `root_path` included — is a plain `to_string_lossy` of a native path. Normalising through `protocol::wire_path` would therefore have asserted a rule the binary does not follow. The expectation is now built the way the code builds it (`root.join(".")`), which keeps the claim the test's name makes — a relative context folder is resolved against the root — without claiming a separator.

**The whole set, one crate at a time, at `5fb6f363`:**

| suite | result |
|---|---|
| `cargo test -p protocol` | **115 passed / 0 failed** (was 112/3) |
| `cargo test -p gavin-mcp` | **57 passed / 0 failed** (was 56/1) |
| `cargo test -p gavin-daemon -- --test-threads=4` (no `--skip`) | **584 passed / 0 failed / 1 ignored** in 57s |
| `cargo test -p app` | **526 passed / 0 failed / 1 ignored** in 42s |

Two provenance notes on the daemon number, so it is not read as more than it is. The worktree also carried another session's uncommitted `crates/daemon` work (`gavin.rs`, `main.rs`, `server.rs`, new `testing.rs`), which is what the suite ran against and which this commit deliberately does not include — 584 is that tree's number, not a clean `win/suite-reds` one. And the first unfiltered run came back 583/1: `server::tests::a_resize_never_answers_a_question_the_agent_asked` (`server.rs:9032`). It passes 3/3 alone and the suite re-ran 584/0, so it is a parallelism-timing flake in `server::tests` — a second one beside the documented `gavin::tests` flakiness, worth its own card if it recurs, and not in that other session's diff (their hunks stop at 7263).

**Still open before Windows CI's `cargo test` steps can drop `continue-on-error`:** not this card's four. `ci.yml` records a `server::tests` **deadlock** on Windows (observed twice on 2026-09-11, ~22 failures with 200+ threads at zero CPU), which is why those steps carry `timeout-minutes` as well — a hang that `continue-on-error` cannot help with. Flipping the gate is a separate call.
