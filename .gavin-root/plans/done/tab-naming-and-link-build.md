---
title: Tab naming & card link — build
status: Done
priority: high
---
Implementation checklist for the task card `tab-naming-and-link.md`: an agent
that names its own tab the moment it starts, and a tab that can jump back to
the card it is running.

## Design

**Naming.** A new MCP tool `gavin_name_session(name)` renames the calling
session's tab. The agent learns *which* session it is from `GAVIN_SESSION_ID`,
injected into every PTY the daemon spawns — the MCP server is a grandchild of
that PTY, so it inherits it. The daemon pushes `SessionNamed` on the
connection **attached to that session** — not on a watched root, the way every
other agent-facing request routes: an orchestration agent stands in its rail's
worktree, which matches no watcher, while the app showing a tab is by
definition attached to it. The Tauri relay emits `session-named`, and
`layoutState` reuses the existing `setSessionName` path, so an agent rename and
a human rename land in exactly the same place.

The instruction lives in the always-on gavin skill (a first numbered step) and
is repeated as the opening line of every composed card prompt — run, resume,
task and plan — because that is the one place an orchestration launch and a
board Run both pass through.

**Link.** `card_sessions` already binds a card path to a session id for both
the board's Run and an orchestration launch, so the tab reverse-looks-up its
card. The button jumps to the Orchestration tab when the card sits on a rail
and to the Kanban tab otherwise, and in both cases opens that card's detail
modal — deep-linked through a `requestedCardDetail` store, the same pattern as
`requestedExplorerPath` ("Open in Plans tab"). The Orchestration tab gains a
`CardDetailModal` it never had.

## Restart required

`PROTOCOL_VERSION` goes 8 → 9 (a pre-v9 daemon cannot parse `NameSession`
at all). The running daemon and app must be rebuilt and restarted before
any of this works; until then the version probe says so in as many words.

## Steps

- [x] `GAVIN_SESSION_ID` injected by `PtySession::spawn` (create + restore paths), with a test
- [x] Protocol: `Request::NameSession` + `Response::SessionNamed`, roundtrip tests
- [x] Daemon: `name_session` pushes on the session's attached connection, with a test
- [x] gavin-mcp: `gavin_name_session` tool (reads the env var, trims/caps the name), with tests
- [x] Tauri relay emits `session-named`; `layoutState` listener renames the tab
- [x] Skill + prompts: name-your-tab-first in `gavin_skill.md`, `.claude/skills/gavin/SKILL.md` and all four `cardRun.ts` composers, with tests
- [x] `cardTabLink.ts`: session → card lookup, rail detection, target view, request store — with tests
- [x] `Pane.svelte`: link button on a bound terminal tab
- [x] `KanbanBoard.svelte` + `OrchestrationHubView.svelte` consume the request and open the detail modal
- [x] Smoke checklist entries, `npm run test`, `npm run check`, `cargo test` green
- [ ] Manual smoke pass

## Verification, 2026-08-22

Re-ran green against the working tree: `npm run test` 934/934 in 62 files,
`npm run check` 0 errors, `cargo test` 215/216 — the single failure,
`gavin::tests::deleting_a_context_folder_pushes_a_tree_without_it`, is a
pre-existing load-sensitivity in the fs-watcher tests (its 10s read timeout
starves when all 216 tests run concurrently). It passes alone and passes with
its whole `gavin::tests` module (61 tests), and this card touches nothing in
`gavin.rs`.

**The naming half is confirmed end to end in the running app**, not just in
tests. This very session called `gavin_name_session("tab naming and link")`,
and its `GAVIN_SESSION_ID` (`d11d16c1-…`, exported by the PTY) now carries
that exact name in the app's persisted `config.json` — so the whole chain ran:
MCP tool → daemon `NameSession` → `SessionNamed` pushed on the attached
connection → Tauri `session-named` → `layoutState` → `setSessionName` →
persist. Nine other live agent tabs are named for their work too, so the
prompt/skill instruction lands on real launches.

For the link half the live preconditions hold: `card_sessions` binds this
session to `tab-naming-and-link.md`, and that card sits on the "Generic fixes"
rail — so this tab is itself a case of the rail branch, and its link should
target the Orchestration tab rather than the board.

Left for the human, the part no agent can see: that the ↗ actually renders on
a bound tab, that clicking it lands on the right hub tab with the detail modal
already up (`run-tab-card-link`, `run-tab-card-link-rail`), and that an
unbound terminal shows no link at all.
