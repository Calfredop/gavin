---
kind: plan
title: gavin-mcp is left out of the daemon compat window
status: Done
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

- [x] Decide: should `gavin-mcp` get the same three-way band as the app, or
      stay strict? Staying strict is defensible — an agent session that half
      works may be worse than one that fails loudly and says to restart.
      Choosing that closes this card here.

**Decided 2026-08-24: gate it.** Three things settled it. (1) On a v9 daemon
9 of `gavin-mcp`'s 14 request types are plain v1 requests that would work
unmodified — they fail today only because the *connect probe* demands
equality, not because anything about them is unsafe. (2) Its refusal message
tells the user to `pkill gavin-daemon`, the destructive restart this whole
feature exists to stop recommending. (3) The "half works is worse" worry
assumes silence; gating is the opposite — a gated request never reaches the
socket and the agent gets a tool error naming the tool, the version it needs
and the version running, which is strictly more actionable than today's bare
connect failure.

## If we gate it

- [x] Replace the equality check at `crates/gavin-mcp/src/main.rs:33` with the
      three-way band, reusing `protocol::MIN_COMPATIBLE_VERSION` and the
      app's `classify` logic rather than duplicating it
- [x] Gate outgoing requests through `protocol::min_version_for` in
      `SocketTransport::request`, so a request the daemon predates never
      reaches the socket — matching the app's rule that a gated request
      produces zero bytes on the wire
- [x] Return a tool error naming both versions and the feature needing the
      newer daemon, so the agent reports something actionable rather than a
      bare transport failure
- [x] Cover it: a fake daemon pinned below a request's introduced version must
      receive nothing, and the tool call must fail naming both versions

## How it was gated

The band arithmetic did not stay in the app. `classify` was a private
function of a Tauri crate `gavin-mcp` cannot depend on, so the shared part
moved down into `protocol` — the crate both clients already depend on:

- `protocol::version_band(daemon, client, floor) -> VersionBand`
  (`DaemonNewer` / `DaemonTooOld` / `Usable { degraded }`). The app's
  `classify` and `gavin-mcp`'s `connect` are now both thin wrappers around
  it. Wording stayed with each client, because the recovery genuinely
  differs — the app can say "update the app"; `gavin-mcp` cannot.
- `protocol::gate_request(req, daemon_version) -> Result<(), GatedRequest>`,
  the shared predicate over `min_version_for`. `GatedRequest` carries the
  two numbers as a typed error rather than a formatted string, which is
  what lets `gavin-mcp` name the *tool* the agent called — the transport
  only ever sees a `Request`, and `gavin_get_orchestration` makes four.

What an agent now sees on a v9 daemon:

> `gavin_get_orchestration needs gavin daemon protocol v10, but the running
> daemon is v9 (this gavin-mcp speaks v12) — restart the daemon from the
> gavin app to use it`

…while `gavin_get_tree`, `gavin_create_plan` and the other v1 tools simply
work. The old `pkill gavin-daemon` advice is gone from both refusal paths.

Two structural details worth keeping:

- The connection and its negotiated version live in one `Connection` value,
  so a version can never outlive the socket it was negotiated on. `connect`
  is the only constructor and always probes, so every reconnect
  re-negotiates. This is the app's documented gap (`send_command_reconnecting_at`
  keeps serving a stale verdict after a reconnect) closed on this side.
- A gate refusal is exempt from the one-reconnect retry. Nothing was sent,
  so nothing can be fixed by reconnecting, and retrying would discard the
  one message that says which version is missing.

Verified: full workspace suite green (198 app / 247 daemon / 23 gavin-mcp /
49 protocol, 0 failures). Both new mechanisms were mutation-checked —
deleting the gate fails 2 tests, collapsing the band back to strict equality
fails 3 — so the coverage is load-bearing rather than decorative. No new
clippy warnings (the repo is deliberately not default-rustfmt; house style
was matched instead of reformatting).

Lives on branch `feat/gavin-mcp-ops` (worktree
`gavin-feat-gavin-mcp-ops`), **uncommitted** — three files:
`crates/protocol/src/lib.rs`, `crates/gavin-mcp/src/main.rs`,
`app/src-tauri/src/session.rs`. Nothing else in the tree was touched.

Phase 2's re-exec (spec §3) is still the answer for the daemon-**newer**
direction; the `DaemonNewer` arm here is the hard error it will replace.

## Context

- Spec: `docs/superpowers/specs/2026-08-24-daemon-version-compat-ota-design.md`
- Phase 1 plan: `docs/superpowers/plans/2026-08-24-daemon-compat-window.md`
- Phase 2 plan: `docs/superpowers/plans/2026-08-24-ota-updates.md`

In the main checkout those three files are **untracked** — left uncommitted
because an orchestration merge was in flight and committing would have swept
it up.
