---
kind: task
title: [sec] agent & workspace-content surface
parent: review-security-audit.md
complexity: intricate
---
Audit the boundary between gavin and the agents it runs, against adversary 2 of `docs/security/00-threat-model.md` (read it first), and write `docs/security/03-agent-surface.md`. This is the gavin-specific boundary and nothing defends it today: an agent is a user, and a cloned repo's markdown is an agent's prompt.

## Cover

- **`crates/gavin-mcp`**: it connects to the same socket with the same unlimited protocol, so any agent holding `gavin_*` tools can do whatever the daemon can — including `gavin_spawn_session`. Read every tool handler in `crates/gavin-mcp/src/main.rs`: what it exposes, what it validates, and whether the MCP tool set needs to be narrower than the wire protocol.
- **Card bodies as prompts.** `.gavin*/plans/*.md` bodies reach an agent verbatim through `compose_agent_prompt` (`app/src-tauri/src/session.rs`); `attachments:` frontmatter hands it more files; the `gavin:auto-commit` block (`app/src/lib/autoCommit.ts`) is text an agent is told to obey; orchestration tool bodies and `builtin:*` steps carry instructions too. What can a repo that ships hostile cards make a fresh agent do, on the first Run, before the human reads anything?
- **Repo-declared execution.** `[worktree] setup` in `config.toml` (`app/src-tauri/src/worktree_setup.rs`) runs commands the repo names, in a visible session. When, with what confirmation, and what a hostile repo puts there.
- **MCP config gavin writes into the repo.** `agent_setup.rs` writes project-scoped `.mcp.json`, `.codex/config.toml`, `.gemini/settings.json`, `opencode.json`. Two questions: what a repo that already ships those files does to a fresh clone's agents (a `command` pointing anywhere), and whether gavin's own writes can be redirected.
- **State an agent can write that the scheduler trusts.** `plan.status`, checklist ticks, `ClaimCardForSession`, `SetStepRun`, rail runs — what an agent writing In Progress/Done on the wrong card, or ticking items it did not do, does to orchestration (`orchestration.ts`, `orchestrationState`).
- Say plainly, per item, where **"the agent is trusted"** is the current design and where it is an oversight.

## Rules

- **Reproduce the headline**: a card body that redirects an agent, or a repo-shipped MCP config that a fresh clone's agent picks up — against a throwaway workspace and a throwaway daemon under a temp `$HOME`. Never the live daemon, never `pkill`, never the human's real workspaces.
- **A reproduction, or an admission** for every high-severity finding.
- **Describe, do not weaponise.** Impact and a minimal repro; no polished payloads.
- **Mark each finding** `vulnerability` or `boundary`.

## Output

`docs/security/03-agent-surface.md`: a findings table (id, severity, adversary, vulnerability/boundary, reproduced yes/no), then one section per finding, then the smallest set of changes that would make an agent a *narrower* user than the human. Do not fix anything. Do not file cards — the parent plan does that after the dedupe pass.
