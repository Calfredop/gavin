# Gavin — Product Requirements

> This PRD is the lead document for development in this workspace. The main agent
> session reads it first; plans in `.gavin*/plans/` should trace back to it.

## Vision

Gavin is a desktop app for **vibe coding**: driving several AI coding agents at
once, in real terminals, without losing track of what each one is doing or what
it was asked to do. It is built for one developer running a fleet of agents
across one or more repos.

Agent work otherwise fragments into a dozen terminal windows, a chat scrollback
and a mental to-do list. Gavin makes the work itself the durable object — a card
on a kanban board that is a markdown file inside the repo — and gives the human
and the agents the same view of it.

### Principles

Settled decisions. Breaking one needs a new decision, not a patch.

- **The work outlives the window.** A Rust daemon owns every PTY and all durable
  state, so sessions survive the app closing or crashing. Cards, plans, specs and
  this PRD are plain markdown under `.gavin*/`, committed alongside the code.
- **Agents are first-class users.** What the human does on the board, an agent
  does over MCP against the same daemon. A card's body is the prompt; a plan's
  checklist is its progress bar.
- **Agents run where they can be seen.** A session an agent spawns opens as a
  visible tab on a page. Hidden runs exist only where a tab would be pure noise
  (the Git tab's "commit via agent"), and they go through one shared seam.
- **The human keeps the wheel.** Committing, merging and switching a dirty
  checkout stop and ask rather than proceeding.

## Architecture

- `crates/protocol` — wire types, `PROTOCOL_VERSION` (13), `MIN_COMPATIBLE_VERSION`
  (5) and `min_version_for`: the supported daemon window.
- `crates/daemon` — `gavin-daemon`: PTYs, SQLite registry, the `.gavin*` filesystem
  watcher, orchestration state. Newline-delimited JSON over a Unix socket.
- `crates/gavin-mcp` — the MCP server behind the `gavin_*` tools.
- `app/` — SvelteKit (SPA) + Svelte 5 + xterm.js. `app/src-tauri` — the Tauri host:
  a thin socket client to the daemon, plus git, file viewer/editor, agent profiles.

The client/server split is the load-bearing decision: the daemon persists
independently of the GUI. Design history is in
`docs/superpowers/{brainstorms,specs,plans}/`.

## What is built

- **Terminal core** — workspaces → pages → tabs, split panes, per-session status
  (idle / working / waiting for input) with OS notifications, restart recovery.
- **Kanban board** — markdown cards (note / task / plan), statuses from the column
  names, labels, priority, nesting and promotion, multi-select, search and filter,
  run actions, `plans/done/` on Done and an explicit `plans/archive/`.
- **Plan explorer** — Plans / Docs / Specs / Archive tree, markdown editing in
  CodeMirror 6, live-reloading file viewer.
- **Git tab** — local changes, sync / branches / worktrees, history graph, 3-pane
  conflict merge, commit via a hidden agent run.
- **Orchestration** — rails of steps (a card or a tool), bound to a worktree or a
  branch, each rail spawning a page of its own; a scheduler that runs steps through
  agents and reconciles dead sessions.
- **Workspace plumbing** — settings, init wizard, agent profiles that write real MCP
  config, keyboard shortcuts, daemon restart from Settings, and a daemon version
  compatibility window with a banner and per-feature gating.
- **Home hub** — PRD excerpt, board and plan summaries, sidebar workspace/page recaps.

## Current focus

1. **Land the tree.** `main`'s working tree carries ~100 dirty entries — several
   sessions' finished features (archive, page recap, rail scheduler fixes, commit
   via agent, nested-task status). Until they are committed, `git log` cannot
   answer "is this in?". Commit per feature, own files only.
2. **Clear the merge debt.** `feature/multimcp` (9de344a), and the uncommitted O15
   (rail↔branch binding) and O16 (rail spawns its page) work in the
   `Orchestration/opts-01` worktree. That merge owes a protocol bump plus a
   `FEATURE_MIN_VERSION` entry *with a real consumer* for `Rail.branch`.
3. **Close the `gavin-mcp` compat gap** (`plans/gavin-mcp-compat-window.md`). The
   app tolerates an older daemon; `gavin-mcp` still demands exact equality, so one
   version of skew takes every `gavin_*` tool down in every running agent session.
4. **Orchestration hardening** — the open cards: a rail icon on a card that sits in
   a rail, an orchestration recap on Home, agent-driven rail organisation, archiving
   closing the card's sessions, and the tab-rename skill regression.
5. **Confirming the rendered surface.** The suites cannot reach it, and gavin no
   longer tracks it: the smoke checklist and its dev-only workspace are retired,
   so there is no list to tick and no smoke items to file on a card. Looking at
   what a change does in the running app is the owner's, done when a change
   warrants it rather than accumulated as a backlog.

## Out of scope

- **True process reattachment after a device restart.** Restoring workspace, layout
  and cwd with a fresh shell is the accepted behaviour.
- **OS file drag-and-drop into the app.** Tauri's `dragDropEnabled` is off so that
  in-page HTML5 drag-and-drop works at all.
- **Viewing binary or media files in-app.** Anything but text / markdown / code
  opens in the OS default application.
- **Automating the visual pass.** The surface is WKWebView with no harness, and
  the dev server has no Tauri `invoke`, so the board is empty in a browser. An
  agent's contribution is a static pre-flight, not a simulated pass.
