---
order: 1024
title: [feat] workspace tools
status: To Do
---
A set of workspace wide tools, launchable from the hub. Some examples: deploy
pipeline, agent repo consolidation, agent repo reconciliation — something
similar to orchestration tools.

The library already exists: `orchestrationTools.ts` ships fourteen built-ins
across three authorable kinds, `toolsState.ts` stores per-workspace and global
ones, and `ToolLibraryDialog` edits them. What does not exist is any way to
**run** one. A tool is reachable only as a step on an orchestration rail, so
"commit the dirty tree" means building a rail and binding it to a checkout.
This is the launcher: a **Tools** hub tab per workspace, the same library, one
click, and a run gavin remembers.

Decisions taken — do not re-derive:

- **A new workspace hub tab**, sibling of Orchestration, `requiresRoot`. Not
  the app hub: these act on one workspace's checkout.
- **The same library, filtered.** No second store and no second dialog. The tab
  offers `agent` / `command` / `script` only — `gavin`, `until` and `pr` are
  completion rules that need a rail to send backwards, and rail-shaped
  built-ins like Merge assume the rail's branch.
- **One tool, one session.** A multi-step deploy is written as one `script`
  tool; bash already sequences. Sequencing stays orchestration's job.
- **Runs are tracked in the daemon**, so a failure nobody watched is still
  visible after a restart. Last run per tool, shown inline on its row — no
  second panel, no history list.
- **A tool carries its own working directory**, set in the library dialog and
  defaulting to the workspace root.
- **Rails are unchanged.** Tools spec T6 stands: a rail step runs in
  `worktreePath ?? rootPath` and ignores the tool's cwd. Rail conflict
  detection is computed off that checkout, so a step that quietly jumped out of
  its worktree would let two rails collide with nothing to warn about.
- **`PROTOCOL_VERSION` 29 → 30.** Tracked runs are new request types. The bump
  takes effect only after a daemon rebuild and restart, which is the owner's
  call — every `gavin_*` MCP tool fails closed until then.

- [ ] Protocol: bump `PROTOCOL_VERSION` to 30. A `ToolRun` wire type mirroring
      `CardRun` (id, tool id, session id, command, launch cwd, conversation id,
      started/ended, exit code, outcome), and three new requests —
      `StartToolRun`, `SetToolRunOutcome`, `ToolRuns` — each at
      `min_version_for` 30. Separately, `SaveTool`'s tool record gains
      `cwd: Option<String>`: that one **widens an existing request**, which
      `min_version_for` cannot see.
- [ ] Daemon store: a `tool_runs` table in `orchestration.rs` with `card_runs`'
      columns keyed on tool id, plus its index; and `orch_tools` gains `cwd`
      by `ALTER TABLE` after `PRAGMA table_info` — a column added only to
      `CREATE TABLE IF NOT EXISTS` never reaches a live database. Extend the
      two sweeps `card_runs` already has: `abandoned` for anything left running
      at startup, and `exited` + exit code from `finish_runs_for_session`.
      Store tests over a tempdir, including the migration against a DB built at
      the old shape.
- [ ] Host + `backend.ts` wrappers for the three requests; `Tool` and
      `ToolRecord` gain `cwd`.
- [ ] The compat gate, **with a real consumer** — the entry alone is a dead
      gate. `FEATURE_MIN_VERSION` gains `toolRuns: 30` and `toolCwd: 30`. The
      Tools tab greys Run and says why against an older daemon; the dialog's
      working-directory field is disabled with a reason, because a v29 daemon
      accepts the save and silently drops the field. Hang each reason on a
      non-disabled ancestor — a disabled element never fires `mouseenter`.
- [ ] `orchestrationTools.ts`: the `cwd` field, `toRecord` validation, and
      `resolveToolCwd(tool, rootPath)` — relative resolves against the root,
      absolute is kept as-is. `ToolLibraryDialog.svelte` gains the field with a
      folder picker via `dialog:allow-open`, the only OS dialog still
      permitted. Unit tests.
- [ ] A test that pins the rail's behaviour: a tool with a cwd launched as a
      rail step still runs in the rail's checkout, with the comment saying why.
- [ ] `workspaceTools.ts` — the pure module: which library tools are runnable
      standalone, the last-run summary per tool (outcome, relative age, session
      id), and its badge shape and tone through `ui/indicators.ts`, the app's
      one badge vocabulary. Unit tests; the component keeps no rules.
- [ ] `toolRunsState.ts` — the store: fetch on tab mount, and re-read when a
      session exits. The daemon closes a command or script run by itself and
      pushes nothing, so without that re-read the row the human is looking at
      says `running` forever.
- [ ] `WorkspaceToolsHubView.svelte` plus a `{ id: "tools", label: "Tools",
      requiresRoot: true }` entry in `hubViewMeta.ts` after `orchestration`,
      bound in `workspaceViews.ts`. Rows carry kind, description, cwd, the
      last-run chip and Run; "Manage tools…" opens the existing
      `ToolLibraryDialog`. Update the tab-strip and keyboard-router tests that
      enumerate the tabs.
- [ ] `workspaceToolsActions.ts` — the launch, modelled on
      `codeReviewActions.confirmReview`, which is the existing
      standalone-launch seam: prompt for params when the tool has any (defaults
      prefilled), build the line with `buildToolCommand` / `buildRunCommand`
      exactly as the rail does, `createSession` at the resolved cwd,
      `handleAgentSessionSpawned`, `revealSession`, name the tab after the
      tool, arm failure detection for `agent` kinds, and file `StartToolRun`.
- [ ] The verdict, reusing the rail's rules so a tool means the same thing
      wherever it runs: a command or script run passes on exit 0 and fails on
      anything else (the daemon's hook); an agent run passes when its session
      goes `idle` — its turn ended — and fails when failure detection fires. No
      auto-resume: there is no rail to advance.
- [ ] Two built-in `agent` tools in `BUILTIN_TOOLS`: **Consolidate repo**
      (commit the dirty tree feature by feature, only the files each change
      touches, never `git add -A`, never push) and **Reconcile repo** (report
      branches and worktrees against `{{base}}`, default `main`: what is
      merged, what is behind, what is abandoned). Deploy stays the human's to
      author — a pipeline is per-project.
- [ ] Amend `docs/superpowers/specs/2026-08-21-orchestration-tools-design.md`
      rather than starting a new spec: T11 (a tool carries a cwd; the rail's
      checkout still wins) and T12 (a tool runs standalone from the Tools tab,
      with a tracked run).
- [ ] Suites green — `cargo test --workspace`, and in `app/`: `npm test && npm
      run check && npm run build`. Then add to `smokeChecklist.ts`: a command
      tool's row settles on passed or failed; an agent tool's settles on turn
      end; a tool with a cwd runs there; the same tool on a rail still runs in
      the rail's checkout; and the tab explains itself against an older daemon.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
