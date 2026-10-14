---
kind: task
title: [feat] touched files: record shell writes with an agent hook
status: Done
priority: medium
attachments: app/src-tauri/src/agent_edits.rs,app/src/lib/review/reviewState.ts,app/src-tauri/src/agent_setup.rs
complexity: complex
---
Follow-up to `bug-touched-files` (commit 3ba74db0). The Review tab now narrows a card's touched files to the checkout's changed files that the run's own transcript names (`app/src-tauri/src/agent_edits.rs`, `narrowToTranscript` in `app/src/lib/review/reviewState.ts`). Edit-tool calls are exact. Shell commands are a heuristic: a file is credited when a command that may write names it, so

- a file a command writes WITHOUT naming it (a formatter over the tree, codegen, a script) is missed, and
- a file a writing command only read is wrongly credited.

## Goal

Record what each `Bash` call actually changed, per session, and use that alongside the transcript.

## Shape (agreed in conversation; refine before building)

- **Hook, not MCP.** The gavin MCP server never sees other tool calls. Use the CLI's own hooks: Claude Code `PreToolUse`/`PostToolUse` matched to `Bash`, and Kimi's equivalent. gavin already writes Kimi hooks (`ensure_kimi_launch_config`, `GAVIN_ATTENTION_HOOKS` in `agent_setup.rs`). Claude Code hooks would be new: decide between the user's settings file and a per-launch `--settings`, and never clobber the human's own hooks.
- **Before/after snapshot per shell call:** before the call, the set of dirty paths with their modification times (`git status --porcelain -z` plus stat); after it, the same. Paths that appeared or changed in between belong to that session. Record them with the session/conversation id.
- **Where it's stored:** a daemon table keyed by conversation id, written by a small request from the hook script. That's a new protocol request, so bump the version and add the `min_version_for` + `FEATURE_MIN_VERSION`/`featureBlockedReason` wiring per CLAUDE.md. A new table needs its migration proven against an old-schema DB (the `pre_v*` test pattern).
- **Merge:** a card's touched files = (transcript edit-tool paths) ∪ (hook-recorded shell writes), cut to the checkout's changed files. When a run has hook records, they replace the shell-command name heuristic for that run; with none (older runs, Codex, ssh), today's behaviour stands unchanged.

## Constraints

- Hooks must never block or fail the agent's turn: observation only, every failure silent, stdin drained. The Kimi attention script is the model.
- Cost: one dirty-file scan before and one after each shell call. Measure it on this repo and keep it cheap (e.g. skip the before-snapshot when the command is plainly read-only — `may_write` in `agent_edits.rs`).
- Known limit to document, not solve: two agents writing during the same call window both get credited.
- Codex has no hook; it stays on the transcript reader.

## Done when

- A run that ran `npm run format` (or `sed -i` through a script) lists the files that changed, and a `cat`-only run lists none of what it read.
- Older runs and Codex runs show exactly what they show today.
- Suites green; a human test filed for the Review tab after rebuild + daemon restart.

## Plan (settled 2026-10-13)

Decisions, each measured rather than assumed:

- **Claude Code: per-launch `--settings`, inserted by the daemon at spawn.** Probed `claude -p` 2.1.296: hooks from `--settings` run ALONGSIDE a project settings file's hooks (both fired), so the human's own hooks are untouched and nothing is written into their settings. The daemon is the one seam every launch passes (card, rail, best-of-N, resume, MCP spawn), it already rewrites a Codex line for Headroom the same way, and the registry keeps the line that was asked for.
- **The hook names `$GAVIN_SHELL_WRITES`**, which a v72 daemon sets on every PTY beside `GAVIN_MCP` (the same gavin-mcp, the one beside the daemon hosting the tab), so nothing build-specific is baked into any config. Its own variable because kimi's `config.toml` is shared by every build on the machine: under an older daemon `GAVIN_MCP` names a gavin-mcp with no `shell-writes`, and the hook must do nothing there, as it does outside a gavin tab.
- **Kimi: two more entries in the global `config.toml`** next to the attention hooks, running a gavin-owned `gavin-shell-writes` script in the kimi home. kimi 2.1.1 pipes the same payload shape (`session_id`, `tool_input.command`, `tool_call_id`); its PostToolUse is fire-and-forget.
- **A failing command fires `PostToolUseFailure`, not `PostToolUse`** (measured), so both are hooked.
- **Per call, not per run.** The hook's `tool_use_id` equals the transcript's `tool_use.id` (measured; kimi's wire carries `toolCallId`). A shell command the hook observed is judged by its record; one it did not (older run, hook skipped, daemon down) keeps the name heuristic. Older runs and Codex are unchanged by construction.
- **Cost:** `git status -uall` is ~30 ms here; a read-only command (`may_write` false, now in `protocol`) takes no snapshot at all.

- [x] protocol: `shell_writes` module (subcommand, hook commands, `may_write` moved from agent_edits), `RecordShellWrites` + `ShellWrites` (v72), `min_version_for`, version tests
- [x] daemon: `shell_writes` table in kanban.sqlite (pruned at 90 days) + pre-v72 test; dispatch; agent/remote allow tables; `--settings` added to a Claude Code launch line
- [x] gavin-mcp: `shell-writes pre|post` subcommand: drain stdin, snapshot dirty paths + mtimes, diff, record; every failure silent
- [x] host: kimi hook entries + script; `shell_writes` command; agent_edits merges hook records per call
- [x] app: `FEATURE_MIN_VERSION.shellWrites` read by reviewState before asking; backend calls; tests
- [x] Verify: suites; a real `claude -p` through an isolated daemon (format script + cat)
- [x] Human test filed for the Review tab after rebuild + daemon restart
- [ ] Human test: After rebuilding (app install step, so gavin-mcp is replaced) and restarting the daemon at v72: run one Claude Code card whose agent runs a formatter or script that names no file (e.g. `npm run format`) and one that only `cat`s dirty files, then press Refresh in the Review tab — the first lists exactly the files the formatter changed, the second none of what it read, and an older card shows the same files as before.

## Outcome (2026-10-13)

Verified end to end: a real `claude -p` launched through an isolated v72 daemon as a `claude-code` profile ran `sh format.sh` (rewrites two files and generates a third, naming none) and `cat src/read.ts` in a checkout that already held a co-tenant's edit and a dirty file. The daemon recorded the format call with exactly `src/a.ts`, `src/b.ts`, `src/generated.ts`; the `cat` call was never snapshotted; neither dirty bystander was credited; the registry kept the launch line without `--settings`; the hook's `tool_use_id` equals the transcript's.

Cost on this repo: ~30 ms per snapshot (one `git status -uall` plus a stat per dirty file), two per writing shell call; 0 for a read-only command. `post` adds one daemon round trip, bounded at 0.5 s connect / 2 s answer so a stuck daemon costs the record, never the turn.

Known limits, documented in `crates/gavin-mcp/src/shell_writes.rs` and `agent_edits.rs`, not solved:
- Anything else writing in the same checkout during a watched call's window (another agent, the human, a watcher) is credited to that call too. The window opens before any permission prompt.
- A background command's writes after it returns land in whichever call is open then. kimi's PostToolUse is fire-and-forget, so a write can move between two calls of one run, never between runs.
- A run whose `claude` line already passes `--settings`, a Windows launch, and Codex get no hook and keep the transcript's name heuristic.

Not committed: CLAUDE.md leaves commits to the human. Files: `crates/protocol/src/{lib.rs,shell_writes.rs,remote_commands.rs}`, `crates/daemon/src/{shell_writes.rs,kanban.rs,server.rs,pty.rs,main.rs,headroom/compress.rs}`, `crates/gavin-mcp/src/{main.rs,shell_writes.rs}`, `app/src-tauri/src/{agent_edits.rs,agent_setup.rs,session.rs,lib.rs,commands.rs}`, `app/src/lib/core/{backend.ts,daemonCompat.ts}`, `app/src/lib/review/{reviewState.ts,reviewState.test.ts}`, `app/src/lib/guards/commandGate.test.ts`.
