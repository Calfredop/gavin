# Gavin Agent Orchestration — Brainstorm Session Log

**Started:** 2026-08-06 · **Status:** in progress — collecting decisions one question at a time.

This is the working log for the next major phase of gavin: turning the workspace home into
the platform that orchestrates coding agents working inside the workspace's directory. It
captures the vision, what already exists, the proposed decomposition, and every open
question with its eventual decision. Final outputs will be one design spec per sub-project
in `docs/superpowers/specs/`, each followed by its own plan → implementation cycle.

## 1. The nucleus (user's vision)

- The **workspace home page** becomes the orchestration platform for coding agents working
  in the physical workspace. It hosts:
  - a **PRD editor/viewer** — the PRD lives at root level and is the main lead of
    development;
  - a **CLAUDE.md editor/viewer** (or the picked agent's equivalent file);
  - a **main coding agent session**, injected with all of gavin's features plus the PRD
    and the CLAUDE.md (or equivalent).
- The main agent session and spawned ones are injected with the concept of creating a
  *(sentence cut off in the original message — see Q1)*.
- All gavin-related files (prompts, tasks, plans, docs, specs, config) live in two folder
  types:
  - **`.gavin-root/`** at the workspace root (most likely the repo root) — that
    workspace's config, plans (subfolder), docs, specs, **and the PRD**;
  - **`.gavin/`** in logical context folders (a feature, a library, …) — same inner
    structure, scoped to that context.
- A **plan explorer**: a simplified file tree dedicated to `.gavin*` folders, `.md` files
  only, with an md editor/viewer.
- **Plan status is managed via kanban**:
  - the root-level board covers all plans in the workspace;
  - **each terminal session can have its own board**, bound to the session's folder
    having a `.gavin` folder.
- **Creating a `.gavin` folder** (new feature / subfeature / lib …) works two ways: from
  a file explorer integrated into the workspace home, and by a coding agent via an
  injected skill.

## 2. What exists today (verified against the code, 2026-08-06)

All four original roadmap items are shipped; the platform builds on:

- **Workspaces** are `{ id, name, pages[], activePageId, activeView? }` — **no
  filesystem root**. Sessions have cwds; workspaces are purely organizational, so
  `.gavin-root` needs a brand-new "workspace ⇄ root directory" binding. A pinned
  `__unfiled__` pseudo-workspace always exists (non-closable) and presumably can't have
  a root.
- **Hub navigation is already pluggable**: `workspaceViews.ts` defines
  `HUB_VIEWS: { id, label, icon, component }[]` — currently just Kanban. A workspace's
  `activeView` toggles between `"terminal"` and hub views. This is the natural extension
  point for Home / plan explorer / PRD views.
- **Kanban** lives in daemon-owned SQLite keyed by `workspace_id` (`Board { columns,
  labels }`; cards carry title/description/priority/labels). Cards already have an
  optional `sessionLink { sessionId, cwd, command }`: a card can **spawn a terminal
  session** with a cwd + command, shows a live status dot, jump-to-session, and
  re-launch. This is the seed of "spawned agent sessions."
- **Sessions** are daemon-owned PTYs surviving app restarts; `createSession(cwd?,
  command?)` exists end-to-end. Per-session **git status** (repoRoot, branch, dirty,
  ahead/behind) is already computed by the daemon — repo-root detection exists.
- **File viewer** (read-only): markdown via marked+DOMPurify, code via highlight.js,
  1 MB cap, live reload via parent-directory watching, open-externally, cmd+click on
  paths/URLs in terminal output. **No editing anywhere yet** — "editor" is a new
  capability.
- **Persistence**: app-side `config.json` (workspaces, layouts, file tabs); daemon data
  dir holds `kanban.sqlite` and session state.

## 3. Proposed decomposition (sub-projects)

Ordered by dependency; each gets its own spec → plan → implementation cycle.

1. **Foundations: workspace root + `.gavin` discovery** — bind a workspace to a root
   directory (creation flow, migration for existing workspaces, Unfiled exempt); the
   on-disk convention itself (`.gavin-root/` and `.gavin/` layout, config format, PRD
   location); a scanner + watcher that finds every `.gavin*` folder under the root and
   keeps the app's picture live.
2. **Markdown editing** — grow the read-only file viewer into an editor (save, dirty
   state, external-change conflicts). Shared by PRD, CLAUDE.md, and plan files.
3. **Plan explorer** — the `.gavin*`-scoped md tree browser + editor/viewer, likely as
   a hub view.
4. **Orchestration home** — the composed home page: PRD panel, agent-file panel, main
   agent session, plan explorer, board. Layout/navigation design for the hub.
5. **Plans ⇄ kanban** — the plan-status model (source of truth!), the root board
   aggregating all plans, per-session folder-bound boards.
6. **Agent integration layer** — launching the main agent session with everything
   injected (PRD, agent file, gavin concepts), spawned sessions inheriting the same,
   the "create-.gavin"/plan-first skill, possibly a gavin MCP server exposing
   boards/plans as tools.

## 4. Open questions (the backlog — asked one at a time)

| # | Question | Status |
|---|----------|--------|
| Q1 | The cut-off sentence: agents are "injected with the concept of creating a" — creating what? | **asking** |
| Q2 | Source of truth for plan status: md frontmatter (files are truth, boards are a view), SQLite (boards are truth), or bidirectional sync? Note agents can only touch files. | open |
| Q3 | Injection mechanism: skill files written into the repo, a gavin MCP server, launch-command flags/prompt — or a combination? | open |
| Q4 | Agent scope: Claude Code only for v1 (with an adapter seam for "picked agent equivalent"), or pluggable from day one? | open |
| Q5 | Workspace ⇄ root binding: chosen at workspace creation? Inferred from sessions? Migration for existing workspaces; Unfiled exempt? Exactly one root per workspace? | open |
| Q6 | Editor tech: plain textarea vs CodeMirror; edit/preview toggle vs side-by-side for md? | open |
| Q7 | PRD convention: one `PRD.md` (exact name?) in `.gavin-root/`? Template/scaffold on creation? | open |
| Q8 | Per-session board binding: session cwd exact match vs nearest-ancestor `.gavin`; where does that board render (hub? pane tab? drawer)? | open |
| Q9 | `.gavin` creation UX: how much "file explorer" does the home really need vs a "new feature folder" dialog? | open |
| Q10 | Relationship between the existing free-form workspace board and plan-derived boards: one merged board, or plans as a distinct board/lane? | open |

## 5. Decisions log

*(appended as answers land; each links back to its Q#)*

— nothing decided yet —
