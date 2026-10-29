---
order: 5120
kind: task
title: [perf] companion workspace sync
status: Done
---
When entering a workspace, the load of the session is very slow. The sessions show as a list of hashes until full load which is, like said, very slow

## What was slow

Everything a phone asks is answered one at a time, in the order asked: the
shell keeps one request in flight (`companion-shell/src/shell/connection/connection.ts`,
`liveConnection`'s `queue`), each one a full Relay round trip, and the desk runs
forwarded commands on one thread (`app/src-tauri/src/forwarding.rs`, `serve`).
On connect the bundle asked for every workspace's board, tree and worktree setup
(three round trips per workspace) BEFORE it asked for the session names, and it
awaited the names together with `get_session_baselines`, which waits on every
linked ssh host for up to 5 s. Until both landed, each row fell back to
`sessionLabel`'s `id.slice(0, 8)`, which is the list of hashes.

## What changed (Companion only, no protocol change)

- [x] `state/workstation.ts`: names and baselines are asked right after the
      workspace list, before the board/tree fan-out, with names first and
      landing on their own (`loadSessionNames` / `loadBaselines`); theme next.
- [x] `loadCards` asks for the open workspace's board and tree before the others.
- [x] `sessionLabelsRead` store + `phoneSessionLabel` (`surfaces/sessionList.ts`):
      while the labels are unread, a session known only by its id reads
      "Reading its name…" instead of the id, in the list and the terminal header.
- [x] Tests: request order, open-workspace-first, the read flag across
      connections, the placeholder rule. `companion:test` 926 green, `companion:check` 0 errors.
- [ ] Human test: On the iPhone over the Relay, open a Workstation with several workspaces and enter one: session names appear within a moment (no 8-character ids), and anything still unread says "Reading its name…"

## Not done (follow-up if still slow)

The one-request-in-flight wire is the real ceiling: total connect time is still
the sum of every round trip, just in a better order. Pipelining requests over
the Device stream (ids already exist on the bundle channel) would need the shell
and the daemon's Device loop to stop pairing a request with the next reply.
