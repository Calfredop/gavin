---
status: In Progress
kind: task
title: Card runs on ssh workspaces (prompt composed and MCP config written on the host)
parent: feat-ssh-support.md
complexity: complex
---
Read `docs/superpowers/specs/2026-09-22-ssh-workspaces-design.md` (§7) first. An ssh workspace's daemon runs on the host (`app/src-tauri/src/remote.rs` links to it), and its board, tree and sessions already go there. Running a card does not: `agent_setup.rs::compose_agent_prompt` reads the card file from the desktop's disk, and `setup_agent_integration` writes the MCP config and the agent instructions file into the desktop's copy of the repo. On an ssh workspace neither file is on this machine, and the agent plus its `gavin-mcp` run on the host.

Make a card run work on an ssh workspace:

1. **Composition on the host.** Either add daemon requests that read a card body and the root config so the app composes from what the host daemon returns, or move composition behind one request the host daemon answers. Decide against the spec's §7 and record the decision in a short spec under `docs/superpowers/specs/`. Do not shell out over ssh per file: the link is the one channel. Any new request type is a `PROTOCOL_VERSION` bump with a `min_version_for` arm, a `FEATURE_MIN_VERSION` entry in `app/src/lib/core/daemonCompat.ts` AND a `featureBlockedReason` consumer on the Run button (CLAUDE.md: a bump that widens a request needs both). The bump only takes effect after the human rebuilds and restarts; verify against an isolated daemon under a temp data directory, the way `crates/daemon/tests/bridge.rs` does.
2. **MCP config on the host.** `setup_agent_integration` for an ssh workspace must write the workspace's MCP config on the host, pointing at the host's `gavin-mcp` and the host's socket, through the same daemon (`SetRootConfigField` exists; the MCP file write needs a request, or an existing one widened). `ssh.daemonPath` names where `gavin-daemon` is on the host; `gavin-mcp` sits beside it.
3. **Launch.** `create_session` is routed by `workspaceRoot`, so once the prompt is composed the run launches on the host; `link_card_session` and `card_runs` are routed by workspace id. Check `cardRunActions.ts` passes the workspace's root as `workspaceRoot` on every launch path (board Run, develop, rail steps, best-of-N).
4. Remove the card-run gating the frontend task added for ssh workspaces once this works.

Tests: daemon tests for every new request (`crates/daemon`), app tests for the routed composition, then `cargo test -p protocol`, `cargo test -p gavin-daemon --test bridge`, `cargo test -p app`, `cd app && npm test && npm run check`. Commit only the files you touched.
