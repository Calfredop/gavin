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

- `crates/protocol` — wire types, `PROTOCOL_VERSION` (41), `MIN_COMPATIBLE_VERSION`
  (5) and `min_version_for`: the supported daemon window.
- `crates/daemon` — `gavin-daemon`: PTYs, SQLite registry, the `.gavin*` filesystem
  watcher, orchestration state. Newline-delimited JSON over a Unix socket on
  macOS and Linux, and over a Windows named pipe (`\\.\pipe\gavin-…`, named
  from a hash of the state directory so each user gets their own) on Windows.
- `crates/gavin-mcp` — the MCP server behind the `gavin_*` tools.
- `app/` — SvelteKit (SPA) + Svelte 5 + xterm.js. `app/src-tauri` — the Tauri host:
  a thin socket client to the daemon, plus git, file viewer/editor, agent profiles.

The client/server split is the load-bearing decision: the daemon persists
independently of the GUI. Design history is in
`docs/superpowers/{briefs,brainstorms,specs,plans}/`; the security model is in
`docs/security/`.

## What is built

- **Terminal core** — workspaces → pages → tabs, split panes, per-session status
  (idle / working / waiting for input / failed, plus `unknown` from a newer
  daemon) with OS notifications, restart recovery, orphan recovery, and a launch
  wall that gates, queues and estimates what is about to start.
- **Kanban board** — markdown cards (note / task / plan), statuses from the column
  names, labels, priority, nesting and promotion, multi-select, search and filter,
  run actions, `plans/done/` on Done and an explicit `plans/archive/`.
- **Plan explorer** — Plans / Docs / Specs / Archive tree, markdown editing in
  CodeMirror 6, live-reloading file viewer.
- **Git tab** — local changes, sync / branches / worktrees, history graph, 3-pane
  conflict merge, commit via a hidden agent run.
- **Orchestration** — rails of ordered **stages**, each stage holding one or more
  steps (a card or a tool) and running them `parallel` or in `sequence`; rails
  bound to a worktree and/or a branch, each spawning a page of its own, each able
  to carry a `trigger` that arms it without a human (`rail-done`,
  `all-rails-done`); a scheduler that runs steps through agents and reconciles
  dead sessions; reusable **group templates**.
- **Tool library** — reusable units of work droppable onto a rail: workspace-owned
  or global custom tools (agent prompt, command, script) plus a fixed catalog of
  built-ins (commit, run-tests, merge, push, open-pr, await-pr, until,
  manual-review, code-review, reconcile-repo, notify, browser-test, start-rail…),
  with its own hub tab.
- **Review tab** — finished work per card, code review and critical review filing
  their findings back as cards.
- **Attention** — an inbox of what is waiting on the human, a next-waiting jump,
  auto-resume, agent pause, a model fallback chain and queued follow-ups.
- **TypeSafe features** — turn verdicts (telling a prose question, a blocker or a
  failure from a finished turn), change attribution in a shared tree, commit↔card
  links, and a by-meaning fallback for settings search.
- **ssh workspaces** — the daemon runs where the workspace lives and the desktop
  drives it over `ssh <host> gavin-daemon bridge`; sessions, board, tree,
  orchestration, tools, card runs, the Git tab and the Files tree all route to the
  host.
- **Agent economics** — usage, cost and limit tracking per profile, complexity →
  model routing, Best-of-N.
- **Windows and Linux ports** — named-pipe transport and ConPTY on Windows, XDG
  data directories and AppImage/deb bundling on Linux, CI on `windows-latest` and
  `ubuntu-latest`.
- **Workspace plumbing** — settings, init wizard, agent profiles that write real MCP
  config, superpowers install, keyboard shortcuts, daemon restart from Settings,
  worktree setup scripts, a workspace-removal wizard with OS-trash and restore,
  an updater, machine memory-pressure gating, and a daemon version compatibility
  window with a banner and per-feature gating.
- **Home hub** — PRD excerpt, board, plan and orchestration summaries, sidebar
  workspace/page recaps, and an app-level hub with a "waiting on you" inbox.

## Current focus

Rewritten 2026-09-22 by a board audit. The five items that stood here were all
stale: the tree is clean, every branch is merged into `main`, the compat card
named a file that had been archived, and all five "orchestration hardening"
items had shipped.

1. **Repair the agent toolchain on this machine.** `.mcp.json` is committed and
   carries ONE absolute path to `gavin-mcp`, and the installer move left it
   pointing at a binary that no longer exists — so every agent session in this
   repo now starts with a dead `gavin` MCP server and no `gavin_*` tools. The
   button-press repair re-breaks the Mac, which is the argument for the card:
   make the command machine-independent. Alongside it, `gavin-mcp` still fails
   closed when the daemon is newer, so a rebuild takes the tools down in every
   running session until each one restarts; the spec asks for a self re-exec.
2. **Close the Windows port.** The code has landed and CI builds it; what is left
   is a desktop pass in front of the running app and four fixes an agent can
   make — `gavin::tests` 10 red, four Rust baseline reds that keep `cargo test`
   from being a gate, npm CLI shims eaten by `cmd.exe`, and `tauri dev` unable to
   rebuild a sidecar a sibling session holds. Compiling is not running.
3. **Finish ssh workspaces.** Sessions, board, tree, orchestration, tools, card
   runs (v40), the Git tab and the Files tree (v41) all route to the host.
   Network git sync, the git watcher, conflict resolution and tree mutations are
   still gated off, and nothing has been verified from macOS against a real Linux
   or Windows host.
4. **Make what waits on the human visible, and honest.** The turn verdict tells a
   prose question from a finished turn, but only the rails, auto-resume, the
   attention inbox and the follow-up queue read it — a tab badge, a sidebar row
   and a board card still show a waiting agent as idle, and the "finished"
   notification fires before the verdict lands. The Decisions tab gathers all of
   it in one place.
5. **Remote access, phase 2.** Phase 1 (client identity and roles on the local
   socket) landed. The trust store, the pairing handshake, revocation and the
   Settings section do not exist yet — `trust.rs` and `pairing.rs` are unwritten.
   It must not open a listener or dial a relay.

**On confirming the rendered surface.** The suites cannot reach it, and the
retired smoke checklist is not coming back as a routine UI backlog. But checks
that genuinely need a person — another machine, a real install, a judgement
call — are being brought back as card items (`Human test:`), gathered on the
Decisions tab, rather than living only in an agent's memory of what it could not
verify. Looking at what a change does in the running app stays the owner's.

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
