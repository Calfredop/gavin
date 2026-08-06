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
  *(resolved — see D1: all of it — plans before coding, `.gavin` context folders, and
  kanban cards/status for their work; the full gavin workflow as one injected
  discipline)*.
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

## 3. Decomposition (sub-projects) — **APPROVED as build order, D13**

Each gets its own spec → plan → implementation cycle, in this order:
1 Foundations → 2 Plans⇄kanban → 3 MCP+skill → 4 Markdown editing →
5 Plan explorer → 6 Orchestration home. (Numbering below predates the
approved order; the mapping is: below-1→1, below-5→2, below-6→3, below-2→4,
below-3→5, below-4→6, below-7 folded into 3.)

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
5. **Plans ⇄ kanban** — the plan-status model (frontmatter per D2), the root board
   aggregating all plans, per-session folder-bound boards.
6. **Gavin MCP server** *(promoted to day one by D3)* — daemon-hosted MCP tools for
   plan CRUD/status, PRD read, `.gavin` folder creation, board access, and session
   spawning; `gavin-mcp` stdio shim + `.mcp.json` registration.
7. **Agent integration layer** — launching the main agent session with everything
   injected (PRD, agent file, the D1 skill, MCP registration), spawned sessions
   inheriting the same.

## 4. Open questions (the backlog — asked one at a time)

| # | Question | Status |
|---|----------|--------|
| Q1 | The cut-off sentence: agents are "injected with the concept of creating a" — creating what? | **answered → D1** |
| Q2 | Source of truth for plan status: md frontmatter (files are truth, boards are a view), SQLite (boards are truth), or bidirectional sync? Note agents can only touch files. | **answered → D2** |
| Q3 | Injection mechanism: skill files written into the repo, a gavin MCP server, launch-command flags/prompt — or a combination? | **answered → D3** |
| Q4 | Agent scope: Claude Code only for v1 (with an adapter seam for "picked agent equivalent"), or pluggable from day one? | **answered → D4** |
| Q5 | Workspace ⇄ root binding: chosen at workspace creation? Inferred from sessions? Migration for existing workspaces; Unfiled exempt? Exactly one root per workspace? | **answered → D5** |
| Q6 | Editor tech: plain textarea vs CodeMirror; edit/preview toggle vs side-by-side for md? Save model: explicit vs autosave? | **answered → D8** |
| Q7 | PRD convention: one `PRD.md` (exact name?) in `.gavin-root/`? Config file format? | **answered → D9** |
| Q8 | Per-session board binding: session cwd exact match vs nearest-ancestor `.gavin`; where does that board render (hub? pane tab? drawer)? | **answered → D7** |
| Q9 | `.gavin` creation UX: how much "file explorer" does the home really need vs a "new feature folder" dialog? | **answered → D10** |
| Q11 | Home-page composition: how do PRD, agent file, main session, plan explorer, and board share the home's real estate? | **answered → D11** |
| Q12 | Main agent session lifecycle: manual start vs auto-start; where does it live in the model (page tree vs home-only)? | **answered → D12** |
| Q10 | Relationship between the existing free-form workspace board and plan-derived boards: one merged board, or plans as a distinct board/lane? | **asking** |

## 4b. Sub-project progress

- **1 Foundations — spec written & approved section-by-section (2026-08-06):**
  `docs/superpowers/specs/2026-08-06-agent-orchestration-foundations-design.md`
  (convention, root binding, daemon-owned scanner/watcher, error posture, tests).

## 5. Decisions log

*(appended as answers land; each links back to its Q#)*

- **D1 (Q1, 2026-08-06):** The injected concept is the **full gavin workflow** — all
  three: agents create **plans before coding** (a plan .md in the nearest
  `.gavin*/plans/`), create **`.gavin` context folders** when starting a new
  feature/subfeature/lib, and create/update **kanban cards/status** so boards mirror
  their actual work. This discipline is injected into the main session and every
  spawned one alike.
- **D2 (Q2, 2026-08-06):** **Files are truth.** Plan status lives in each plan .md's
  frontmatter (`status:`, priority, …); plan boards are projections the scanner builds
  from `.gavin*/plans/*.md`; dragging a card between columns writes the frontmatter
  back to the file. Agents update status by editing the file — no new protocol; the
  file watcher keeps boards live. Status is git-versioned and travels with the repo.
  The existing SQLite kanban remains for free-form, non-file-backed cards
  (coexistence → Q10).
- **D3 (Q3, 2026-08-06):** **MCP server from day one** (user overrode the staged
  recommendation — they want agent-side orchestration power immediately). The gavin MCP
  server is part of this phase's core, likely hosted by the daemon with a thin
  `gavin-mcp` stdio shim registered in the repo's `.mcp.json`. Tools: plan CRUD +
  status, PRD read, `.gavin` folder creation/listing, board access, **session
  spawning** (agents can orchestrate). The injected skill (D1) is still built alongside
  it — MCP provides the levers, the skill teaches the discipline; both ship day one.
- **D4 (Q4, 2026-08-06):** **Claude Code first, behind an agent-profile seam.** The
  workspace config stores a chosen agent profile — instructions filename (CLAUDE.md),
  skill mechanism, MCP registration format, launch command — and every feature reads
  the profile. V1 ships only the Claude Code profile; more agents are additive later.
- **D5 (Q5, 2026-08-06):** **Root binding is optional + explicit.** Folder picker at
  workspace creation and a "Set workspace root" affordance on the home for existing
  workspaces. No root → workspace behaves exactly as today; orchestration features
  light up when a root is set. Unfiled never has a root. Exactly one root per
  workspace in v1. Stored in app-side config.json.
- **D6 (Q10, 2026-08-06):** **One merged board.** Plan cards (file-backed projections)
  join the existing free-form board. **Column ↔ status matched by name**
  (slug-insensitive): a plan card renders in the column whose name matches its
  frontmatter `status:`; dragging it to another column writes that column's name into
  the file; a status with no matching column surfaces as an automatic extra column.
  Free-form cards stay in SQLite, untouched. Per-session boards reuse the same
  projection filtered to one `.gavin` folder.
- **D7 (Q8, 2026-08-06):** **Per-session board = nearest-ancestor `.gavin`, rendered
  as a sibling split/tab.** Binding walks up from the session's live cwd to the
  closest `.gavin`, capped at the workspace root — stable while cd-ing deeper. A board
  icon on the pane (visible only when a binding exists) opens the board as a split/tab
  next to the terminal, reusing the non-terminal-tab machinery the file viewer
  introduced. It shows only that folder's plan cards (D6 projection, filtered).
- **D8 (Q6, 2026-08-06):** **CodeMirror 6 + debounced autosave.** CM6 with markdown
  highlighting is the shared editor for PRD/CLAUDE.md/plans; preview renders through
  the existing marked+DOMPurify pipeline. Autosave ~1s after typing stops; external
  change with a clean editor reloads silently, with a dirty editor raises a conflict
  prompt. This minimizes conflict windows against concurrent agent writes.
- **D9 (Q7, 2026-08-06):** **`PRD.md` fixed** at `.gavin-root/PRD.md`, scaffolded from
  a template when the root is initialized. **Config format is TOML** (`config.toml`)
  for both `.gavin-root/` and `.gavin/` folders.
- **D10 (Q9, 2026-08-06):** **Creation lives in the plan explorer.** The explorer tree
  gains "new `.gavin` here / new plan / new doc" actions, with a real-folder picker
  only inside the create-`.gavin` flow. No general-purpose file manager.
- **D11 (Q11, 2026-08-06):** **Home = Mission Control + full-page tabs (A+B hybrid),
  minimal-underline nav.** One hub tab per feature — Home, PRD, CLAUDE.md, Plans,
  Board (+ the existing Terminal toggle) — each with a lucide icon (HUB_VIEWS already
  carries `icon`). The Home tab is a Mission Control grid: main agent session
  dominant left, PRD peek + mini board stacked right, and a status-tile shortcut row
  under the grid mirroring the tabs (tiles carry live status). Nav style: flat bar
  with an accent underline on the active tab; Terminal as a ghost button at the
  right. Confirmed via visual-companion mockups (`.superpowers/brainstorm/…/content/
  home-layout*.html`, `nav-bar-styles.html`).
- **D12 (Q12, 2026-08-06):** **Main agent session: manual start, home-only.** Home's
  terminal panel shows "Start main agent" when none runs; starting creates a normal
  daemon PTY at the workspace root running the agent profile's launch command, and
  the workspace remembers `mainSessionId`. It lives outside the page trees — embedded
  in Home, expandable from there. If it exits, the panel returns to the start state.
  No auto-launch, ever (agent launches cost money and attention).
- **D13 (2026-08-06):** **Decomposition + build order approved:** 1 Foundations
  (root binding, `.gavin` convention, scaffolding, scanner+watcher) → 2 Plans⇄kanban
  (frontmatter status, merged board, per-session boards) → 3 MCP server + skill
  injection (agents join before new UI) → 4 Markdown editing (CodeMirror 6) →
  5 Plan explorer → 6 Orchestration home (capstone). Each is its own
  spec → plan → implementation cycle.
