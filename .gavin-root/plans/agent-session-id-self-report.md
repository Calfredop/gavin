---
kind: task
title: Agent self-reports its own session id over MCP
parent: feat-agent-session-name-mcp.md
complexity: moderate
---
Read `.gavin-root/plans/feat-agent-session-name-mcp.md` (the parent plan, for
the full design) and `.gavin-root/plans/archive/tab-naming-and-link-build.md`
(the original feature this extends — same shape of change, across the same
files) before touching anything.

**The gap.** `card_sessions.conversation_id` is today only ever written by
gavin *minting* a uuid at launch (`AgentProfile::session_id_args`), which only
Claude Code supports. Agents that generate their own session id (codex,
gemini, opencode) have no way to hand it back, so `conversation_id` stays
null for them and resume falls back to a written reconstruction instead of
the real conversation.

**The fix.** Extend `gavin_name_session` to accept a second, optional
argument carrying the agent's own native session id, and have the daemon
write it into that session's `card_sessions.conversation_id` row.

Name the new field `agent_conversation_id` everywhere — MCP param, protocol
field, variable names, comments. `Request::NameSession` already has a
`session_id` field for *gavin's own* tab/PTY session (from
`GAVIN_SESSION_ID`); the thing being added here is a different id belonging
to the agent's own CLI, and the two must never be spelled the same way or a
future reader will conflate them.

Steps:

- `crates/protocol/src/lib.rs`: add `agent_conversation_id: Option<String>` to
  `Request::NameSession`. Bump `PROTOCOL_VERSION` and add a roundtrip test.
  Add a one-line comment on the field explaining it is never produced by the
  app itself, only by `gavin-mcp` — see the compat note below.
- `crates/gavin-mcp/src/main.rs`: `gavin_name_session` tool gains the optional
  `agent_conversation_id` parameter, trimmed the same way `name` already is.
  Update the tool's description so an agent reads when and why to pass it
  (once a caller profile supports self-report — that vocabulary lands in the
  sibling card, so keep this generic: "when your CLI generates its own
  session id and told you what it is").
- `crates/daemon/src/server.rs` (`manager.name_session`) and
  `crates/daemon/src/kanban.rs`: when `agent_conversation_id` is present,
  look up any `card_sessions` row bound to this gavin session id and set its
  `conversation_id` column to it. Check whether `kanban.rs` already exposes a
  setter you can reuse (look at how `conversation_id` gets written on launch)
  before adding a new one. A session with no bound card is a no-op — there is
  nothing to link it to yet.
- Compat note to write as a comment near the new protocol field, not just
  here: this widened payload needs no `FEATURE_MIN_VERSION` /
  `featureBlockedReason` UI gate, because it is only ever produced by
  `gavin-mcp`, which already fails closed on *any* protocol version mismatch
  (stricter than the app's own compat window) — so there is no combination of
  daemon/gavin-mcp versions where this field gets silently dropped rather
  than the whole tool refusing outright.
- Tests, mirroring `tab-naming-and-link-build.md`'s pattern: `NameSession`
  roundtrip with `agent_conversation_id` set and absent; a daemon test that
  `card_sessions.conversation_id` gets updated when a bound session reports
  one; a no-op test for an unbound session; empty/whitespace-only ids treated
  as absent (same trimming discipline `name` already gets).

Out of scope — leave for the sibling cards under the same parent: do not
touch `AgentProfile`, `config.rs`, or any skill/prompt wording.

Verify: `cargo test --workspace` (re-run the daemon's `gavin::tests` module
alone if the full-suite run flakes — known fs-watcher timing issue, not a
regression from this change).

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
