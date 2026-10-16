---
kind: task
title: "[sec] The Cursor profile's fixed --approve-mcps --trust flags pre-approve every server in a cloned repo's .cursor/mcp.json, whatever gavin's foreign-server disclosure says"
status: To Do
priority: medium
complexity: complex
labels: security, ready-for-agent
---
Fix a needs-validation lead from the 2026-10-15 security audit (run-1). It is not confirmed: the audit traced it in source and in the installed Cursor CLI's code but could not observe an approved repository server actually spawning in a gavin-launched session, because running an agent CLI and using the network were out of bounds. The failing regression test below is the proof — write it first and watch it fail. If it already passes before any change, the lead is wrong: record why under a dated "## Comments" heading and move the card to Done with no code change. Fingerprint: `app/src-tauri/src/agent_setup.rs:AGENT_PROFILES:cursor-approve-mcps-unconditional`.

Full record: `NEEDS-VALIDATION.md` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

gavin's AG-07 gate holds back its own MCP write and asks the human about servers a repository already declares. For Kimi it refuses to grant folder trust unless gavin's entry was written after that disclosure, because trusting the folder "would switch on every server the repository declares, including the ones the human has not been shown or has just refused". The Cursor row grants the same consent in its fixed launch line instead. The interactive command is `agent --approve-mcps --trust`, and the headless args are `-p --force --approve-mcps --trust --`. Every Run, rail step, workspace agent and hidden run uses that line whenever the resolved profile is cursor. A repository picks the row with `[agent] profile = "cursor"` in `.gavin-root/config.toml`, and workspace trust deliberately does not gate that choice. The row is also used for every workspace whose app-wide default agent is cursor. Nothing on the launch path checks the foreign-server scan or the recorded Keep/Isolate answer. Integration's refusal (skip gavin's write and ask) covers only gavin's write, not the launch.

The installed Cursor CLI (2026.10.01-e373342, read but not executed) shows what the flags do. `--approve-mcps` ("Automatically approve all MCP servers"), and `--force` alone as well, skip the interactive "MCP Server Approval Required" dialog. That dialog would otherwise list each server's command with Approve all / Continue without approval / Quit. At startup the CLI reads `<projectRoot>/.cursor/mcp.json` and writes every server not already approved or disabled into the per-project `mcp-approvals.json`. The approval is keyed on server name and config, so it persists: a later launch without the flags also loads those servers until their config changes. `--trust` writes the workspace-trust record without the "Workspace Trust Required" prompt. A cloned repository's stdio server commands would therefore run as the user, with no prompt from gavin or from Cursor, as soon as Cursor's lazy MCP manager loads its tool set.

## Root cause

The consent that gavin's folder-trust gate withholds for Kimi until the disclosure is resolved is granted unconditionally for Cursor, by fixed flags on the profile row (`--approve-mcps`, and `--force` on the headless line). The flags are not tied to the foreign-server scan or to the human's answer, and Cursor turns them into a persistent approval of every server the repository's `.cursor/mcp.json` declares.

## The invariant to enforce

A Cursor launch carries `--approve-mcps` only when the `.cursor/mcp.json` that launch will read declares no server gavin did not add, or the human answered Keep for exactly that set (`mcpForeignDecision(...) === "keep"`). Otherwise the interactive launch goes out without it, so Cursor's own dialog asks. The headless line cannot answer that dialog, and `--force` alone skips it, so a hidden run with an unresolved disclosure must refuse with a reason rather than silently approve or silently stall. The same holds for an unattended interactive launch that nobody will see.

## Trace (lines as of 2026-10-16; re-read before editing)

- `crates/daemon/src/gavin.rs:1869` (parse_context_config, starting 1858): a cloned repo's `[agent] profile = "cursor"` is read verbatim. An app-wide default of cursor is the other route. The repository-controlled payload is its own `.cursor/mcp.json`.
- `app/src/lib/workspace/workspaceTrust.ts:123` (trustedAgentConfig): only `command` and `file` are blanked; `profile` and `mcpFile` pass, by design (comment at 108-114).
- `app/src/lib/core/settings.ts:537` and `:547` (resolveAgentConfig): the requested profile is honoured, and with no explicit command the row's own command is used.
- `app/src-tauri/src/agent_setup.rs:1285` and `:1296` (AGENT_PROFILES cursor): `command: "agent --approve-mcps --trust"` and `headless_args: "-p --force --approve-mcps --trust --"`. The comment at 1278 says the flags exist because Cursor "stalls on MCP/workspace prompts" without them.
- `app/src/lib/cards/cardRun.ts:561` (buildHeadlessCommand) via `app/src/lib/git/gitState.ts:828`: the hidden run composes `launchCommand` plus `headlessArgs`. `agentCommitBlocker` (`gitState.ts:711`) is where a hidden run is refused today.
- `crates/daemon/src/pty.rs:164` (PtySession spawn): the launch line runs via `sh -c` in the workspace as the user.
- `app/src-tauri/src/agent_setup.rs:2311` (foreign_mcp_servers): the scan that finds servers gavin did not add, excluding gavin's own entries; it reads through `WorkspaceFiles`, so it also works for an ssh workspace.
- `app/src-tauri/src/agent_setup.rs:3166` (run_integration, Isolate): Isolate is always refused, so for Cursor the human's only gavin-side answer is Keep. An undecided set only skips gavin's write.
- `app/src-tauri/src/agent_setup.rs:2495` and `:3209` (grant_folder_trust and its `mcp_written` gate): the Kimi control this card mirrors.
- `app/src/lib/workspace/mcpServerTrust.ts:56` (mcpForeignDecision) and `app/src/lib/core/layoutState.ts:2427` (the stored `mcpForeignServersChoice`): the hash-bound answer the launch should consult.

## What the audit could not observe

- The approval bypass is established from the installed CLI's own code. What was not observed is an approved stdio server process actually spawning in a gavin-launched session. That needs the Cursor CLI to run, probably signed in so that its lazy MCP manager reaches its first tool-set load.

## Fix

1. Take `--approve-mcps` off the Cursor row's static `command` and `headless_args`. Keep `--trust` unless the check below shows that workspace trust alone also loads project servers without the dialog; in that case it follows the same rule as `--approve-mcps`.
2. Add a read-only host command that returns the foreign set for the file the launch's Cursor will read: `.cursor/mcp.json` at the launch's project root, which for a rail step is the worktree. Reuse `foreign_mcp_servers`. Confirm against the CLI which root it treats as `projectRoot` (cwd or the git root).
3. Add a pure decision in `mcpServerTrust.ts`, for example `cursorMcpApproval(servers, choice): "approve" | "withhold"`. It returns approve only when the set is empty or `mcpForeignDecision` is `"keep"` for exactly that hash. Compose `--approve-mcps` into the Cursor launch only on approve, at the one point every launcher shares (`resolveAgentConfig`'s output, or the step that turns it into a launch line), not in each caller.
4. On withhold:
   - A visible interactive launch goes out without the flag, so Cursor's dialog asks, and its "Continue without approval" is the real isolate. Tell the human once why the dialog appears.
   - An unattended launch (queued intent, rail step, auto-resume) refuses with a reason naming the unresolved disclosure, the way `UNREVIEWED_UNATTENDED` does for the review. A dialog in a tab nobody watches is a silent stall.
   - The headless line refuses: `agentCommitBlocker` (and any other hidden-run gate) returns "Answer the MCP server disclosure for this workspace before a hidden Cursor run". `-p` without `--force` applies nothing, and `--force` alone skips approval, so no flag combination is both useful and safe there.
5. Update the row assertions at `agent_setup.rs:3803-3804` and `:3937`. The strings in `crates/daemon/src/shell.rs:762` and `crates/daemon/src/headroom/compress.rs:1392` are fixtures and need not change.

Regression tests, written first:

- `mcpServerTrust.test.ts`: `cursorMcpApproval([], null)` is approve; with one foreign server and no choice it is withhold; Keep for that set's hash is approve; Keep for a different hash is withhold; Isolate is withhold.
- `settings.test.ts` (or wherever the composed launch line is tested): a cursor workspace whose scanned set is one undisclosed server resolves to a launch command with no `--approve-mcps`, and the headless gate returns a reason. Both fail today, since the row carries the flag unconditionally.
- Rust: the cursor row's `command` and `headless_args` no longer contain `--approve-mcps` or a bare `--force` that implies it.

## Done when

- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests in the touched crate or module, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched.
- The regression test fails before the change and passes after it.
- Follow the CLAUDE.md traps that apply: a new SQLite column needs its own `ALTER TABLE`, a widened request needs a compat-gate entry, and you commit only your own files. A new host command that a Device could reach needs its row in `crates/protocol/src/remote_commands.rs`.
- Once the fix is in, file this check with `gavin_request_human(<this card>, "test", …)` using exactly this text: "With the Cursor agent CLI signed in to a throwaway account, a gavin Run in a scratch repo whose .cursor/mcp.json declares an undisclosed server running `touch /tmp/cursor-mcp-probe` shows Cursor's 'MCP Server Approval Required' dialog and leaves no /tmp/cursor-mcp-probe after 'Continue without approval', a hidden agent commit there is refused with the disclosure reason, and after answering Keep in Settings the same Run starts with no dialog."
