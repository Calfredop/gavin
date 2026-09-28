---
order: 12288
kind: task
title: [fix] gh pipelines
status: Done
---
All github pipelines are failing; do full audit and if not possible to fix, remove them.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

## Audit (2026-09-22)

Two workflows. **Release** has never run — it triggers on a `v*` tag and
none exists — so nothing there was failing; it is audited statically
below. **CI** had failed 43 of 49 runs (the rest cancelled) and had
never been green, always on the same three steps, one per job:

| Job | Failing step | Cause | Fix |
|---|---|---|---|
| Linux | `cargo build` | `libc::getpeereid` does not exist on Linux (glibc/musl never had it) | `peer_uid` split by OS: `getpeereid` on macOS/BSD, `getsockopt(SO_PEERCRED)` on Linux; socketpair test covers both |
| Windows | `npm run check` | 6 type errors in two tests — not Windows-specific, red on macOS too | `contextMenu.test.ts` casts its duck-typed nodes; `criticalReview.test.ts` reads through `$lib/sources` instead of untyped `node:fs` |
| Audit | `cargo audit` | rustls 0.23.44, RUSTSEC-2026-0285 (from 2026-09-14) | `Cargo.lock` → 0.23.45 |

The Linux job had never got past `cargo build`, so every step after it
had never run anywhere. Reproduced in an `ubuntu:24.04` container
(runner user, the job's own apt list), which surfaced what the build
error was hiding:

- `npm audit --omit=dev` (audit job's last step, also never reached):
  devalue 5.8.2, GHSA-9rgm-9g3h-6x36 → lockfile to 5.9.4.
- `cargo test --workspace`: 7 daemon tests, **6 of them red on macOS
  too** — `cargo test --workspace` has not been green on any platform:
  - five `shell::tests` shim tests fed a Windows `PATH` (`C:/tools`) to
    `split_paths`, which splits on `:` off Windows; they now join PATH
    the host's way with drive-less dirs.
  - `save_tool_accepts_every_kind_the_app_can_author` expected 7 tools
    after `be2b442` added an 8th kind; now counts off the list.
  - `proc::children_of_a_leaf_is_empty` (Linux only): dash forks
    `sh -c "sleep N"` where macOS's bash execs it; the leaf `exec`s.
- `npm test`: `indicatorSurfaces` flags the collapsed sidebar's waiting
  pip (`5173468`), which is the hub-tab pip's exact case — aria-hidden,
  named by the button's tooltip and aria-label; added to the allow-list.

Release: `macos-13` was retired on 2025-12-04, so its x86_64 leg would
never get a runner → `macos-15-intel` (same OS as the aarch64 leg).
Every file it references exists, and `actionlint` is clean on both
workflows. It still cannot go green until the signing secrets exist —
that is its preflight gate working, not a defect.

Commits: c388ffc (peer uid), bb28965 (daemon tests), f7fadb5 (check
errors), 8a700e2 (sidebar pip), 75299b7 (rustls + devalue), b5374fc
(release runner). Nothing was removed: every failure had a fix.

## Verified

In a detached worktree at 662e977 plus exactly these commits:
`ubuntu:24.04` container running the Linux and audit jobs' steps —
build, fs-watcher module alone, `cargo test --workspace` (with
`--no-fail-fast`, so no crate hid behind another), `npm run check`,
`npm run build`, `cargo audit`, `npm audit --omit=dev` all green. On
macOS the same Rust suite (app 504, daemon 452, mcp 57, protocol 111)
and the fs-watcher module (107). `cargo check --tests` for
`x86_64-pc-windows-msvc` compiles the daemon, MCP and protocol crates.
Not verified: an actual GitHub run (nothing was pushed), and anything
on a real Windows host.

## Still red until someone else's work lands

The Linux job's `npm test` gate: 11 tests in 7 files — mocks missing
`agentDefaultsStore` / `workspaces`, `detect_agent_binaries`
unclassified in `commandGate`, two guards still reading
`WorkspaceToolsHubView.svelte` for markup that now lives in
`ToolsExplorerView.svelte`. Their fix already sits UNCOMMITTED in
the main checkout (edited 2026-09-22 09:13–09:14, owner unknown — the
CRLF card calls these "not this card's"): `bestOfNActions`,
`commandGate`, `orchestrationGavinTool`, `toolPlatformGate`,
`codeReviewActions`, `criticalReviewActions`, `workspaceToolsActions`
(`.test.ts`). With those edits applied on top of this card's commits,
`npm test` is 265/265 files, 5803/5803 tests. Once they are committed
and pushed, CI should be green on all three jobs.

Not failures, worth knowing: `actions/checkout` and `setup-node` v4
target Node 20 and are being forced onto Node 24 (a warning
annotation); the Windows job's `npm test` still reports the ten CRLF
source-grep failures, but that step is `continue-on-error`.
