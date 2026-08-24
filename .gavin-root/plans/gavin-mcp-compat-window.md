---
kind: plan
title: gavin-mcp is left out of the daemon compat window
status: To Do
---
The app can now talk to an older daemon; `gavin-mcp` still cannot. Decide
whether to close that gap.

## What's true today

Phase 1 of the daemon compatibility work (branch
`worktree-daemon-compat-window`) gave the **app** a supported version window:
`MIN_COMPATIBLE_VERSION = 5` through `PROTOCOL_VERSION = 12`. Against a daemon
inside that window the app connects, shows a banner, and refuses to put any
request on the wire that the daemon predates.

`gavin-mcp` never got that treatment. `crates/gavin-mcp/src/main.rs:33` still
demands exact equality and bails otherwise.

So on a v9 daemon: the app works with a caveat, while every `gavin_*` tool in
every running Claude session fails outright. Same daemon, two different answers.

**This is not hypothetical — it happened during the session that wrote this
card.** `gavin_get_board` and `gavin_create_plan` both returned "the gavin
daemon is newer than this gavin-mcp", which is why this card was authored as a
file by hand instead of through the MCP tools.

## Why it wasn't just fixed

Strictness is the *safe* direction — refusing to connect cannot corrupt
anything, and an ungated `gavin-mcp` sending a too-new request would close the
daemon connection outright. It was left alone deliberately rather than
overlooked. Note also that several version-sensitive requests
(`GetOrchestrationByRoot`, `GitDirtyPaths`, `NameSession`) are sent *only* by
`gavin-mcp`, never by the app — so this is the client where gating would carry
real weight.

Phase 2's planned re-exec only addresses the daemon-**newer** direction
(`gavin-mcp` replaces itself with the updated binary). It does nothing for a
daemon that is **older** than `gavin-mcp`.

## The decision

- [ ] Decide: should `gavin-mcp` get the same three-way band as the app, or
      stay strict? Staying strict is defensible — an agent session that half
      works may be worse than one that fails loudly and says to restart.
      Choosing that closes this card here.

## If we gate it

- [ ] Replace the equality check at `crates/gavin-mcp/src/main.rs:33` with the
      three-way band, reusing `protocol::MIN_COMPATIBLE_VERSION` and the
      app's `classify` logic rather than duplicating it
- [ ] Gate outgoing requests through `protocol::min_version_for` in
      `SocketTransport::request`, so a request the daemon predates never
      reaches the socket — matching the app's rule that a gated request
      produces zero bytes on the wire
- [ ] Return a tool error naming both versions and the feature needing the
      newer daemon, so the agent reports something actionable rather than a
      bare transport failure
- [ ] Cover it: a fake daemon pinned below a request's introduced version must
      receive nothing, and the tool call must fail naming both versions

## Context

- Spec: `docs/superpowers/specs/2026-08-24-daemon-version-compat-ota-design.md`
- Phase 1 plan: `docs/superpowers/plans/2026-08-24-daemon-compat-window.md`
- Phase 2 plan: `docs/superpowers/plans/2026-08-24-ota-updates.md`

In the main checkout those three files are **untracked** — left uncommitted
because an orchestration merge was in flight and committing would have swept
it up.
