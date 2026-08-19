# Orchestration Home (Mission Control) — Design Spec

Sub-project **6 of 6** — the capstone — of the agent-orchestration phase. Phase
decisions live in
`docs/superpowers/brainstorms/2026-08-06-agent-orchestration-brainstorm.md`; this
sub-project is governed by **D11** (Mission Control grid + per-feature icon tabs,
minimal-underline nav — chosen from visual mockups), **D12** (main agent session:
manual start, home-only, outside the page trees), and its own **D31–D34**.

**Goal:** the workspace home becomes the place you run agents from — the main
agent session on screen beside live summaries of the PRD, plans and board, with
every other surface one click away.

**Out of scope:** adopting the agent session into a page's layout; multiple
concurrent main agents per workspace; live mini-board interaction (drag/edit on
the home); nav restyling (the tab row is already flat-with-underline, matching
D11).

---

## 1. The Home tab and layout

A new `home` hub view (`requiresRoot: true`), **first** in `HUB_VIEWS`.

**Front door (D33).** `getActiveView` returns `ws.activeView ?? "terminal"`
today; it becomes `ws.activeView ?? (ws.rootPath ? "home" : "terminal")`. This is
a **fallback only** — clicking any tab (including the Terminal ghost button)
sets and persists `activeView`, so an explicit choice always wins and workspaces
that already have one are untouched. Unrooted workspaces are unaffected.

**Grid** (D11's mockup): main agent session dominant left; right column holding
the PRD summary above the board summary; a status-tile row spanning underneath.

**Summaries stay summaries** — no watchers, no duplicated interaction logic:

- **PRD panel**: the first ~15 non-empty lines, read on mount and again when Home
  is re-activated. Clicking opens the PRD tab.
- **Board panel**: column names with counts, derived from the already-reactive
  `kanbanState` + `gavinTrees` via `boardSummary` (built on the existing
  `mergePlanCards`, never a second projection). Clicking opens the Board tab.

**Four tiles** mirroring the tabs — PRD, CLAUDE.md, Plans, Board — each with one
live status line and a click-through to its tab. Tile data comes from the same
pure functions as the panels, so a tile and its panel can never disagree.

## 2. The main agent session (D12)

`Workspace` gains two persisted fields, both `#[serde(default)]` so existing
configs load unchanged:

- **`mainSessionId: Option<String>`** — the running agent, deliberately outside
  every page tree.
- **`agentCommand: Option<String>`** (D34) — the launch command, defaulting to
  `claude` when unset.

Adding them breaks the three Rust `Workspace` literal sites and the camelCase
shape test, exactly as `rootPath` did; all are updated in the same task.

**Idle state:** a command field (pre-filled from `agentCommand`, persisted on
change) and a **Start main agent** button. Start calls `createSession(root,
command)`, stores `mainSessionId`, persists, and embeds `TerminalPane` — directly
reusable, since it already takes `sessionId`/`visible`/`focused` and exports
`fit()`. **Stop** kills the session and clears the field. No auto-launch, ever.

Three failure paths are designed for, not discovered:

1. **The restart gap.** Bootstrap's Attach loop walks **page trees only**, and
   this session lives outside them — so after a restart it would render a
   permanently blank terminal (the Milestone-C failure, precisely). Bootstrap
   must Attach every workspace's `mainSessionId` as well.
2. **Stale ids.** The same pass reconciles: if the daemon does not know the id,
   or reports it `exited`, the field is **cleared, never replaced**. Spawning an
   agent is a deliberate, billable act — it returns to the Start button rather
   than silently respawning. (This is the one place gavin deliberately does *not*
   follow its usual "replace a stale session id" rule.)
3. **Natural exit.** `handleSessionExited` searches page trees and returns early
   for anything it cannot find, so an exiting main session would leave a dead id
   on screen. It gains a branch clearing `mainSessionId` on the owning workspace.

**Sizing:** the embedded terminal needs `fit()` when Home becomes visible and on
container resize — the same measurement trap CodeMirror had in sub-4, solved the
same way (a `ResizeObserver` plus a visibility effect).

## 3. Summary data, testing, risks

One new pure module, `homeSummary.ts`, feeds both the panels and the tiles:

- `boardSummary(board, tree)` → per-column `{ name, freeFormCount, planCount }`
  plus totals, built on `mergePlanCards`.
- `planSummary(tree)` → total plans, context count, per-status tally.
- `prdExcerpt(content, maxLines)` → first N non-empty lines, so truncation is a
  tested rule rather than a template accident.

The CLAUDE.md tile uses the `exists` flag `read_file_for_viewer` already returns
(sub-4) — no new backend.

**Testing** (no component tests — vitest here cannot preprocess `.svelte`):

- **`homeSummary.ts`** — all three functions, including an empty board, an absent
  tree, and a PRD shorter than the excerpt limit.
- **`workspace.ts`** — `getActiveView`'s rooted default, and that an explicit
  `activeView` still wins.
- **`layoutState.ts`** — `handleSessionExited` clearing `mainSessionId` on the
  owning workspace and leaving other workspaces alone.
- **Rust** — `config.rs` roundtrip + absent-field defaults for both new fields;
  bootstrap reconciliation: a live main session is kept and Attached, an unknown
  or exited one is cleared.
- **Manual** (new checklist section): a rooted workspace lands on Home; Start
  spawns a live agent; it survives an app restart still scrolling (the Attach
  gap); Stop returns to idle; killing the agent from a terminal returns to idle;
  each tile navigates; the summaries track board and PRD changes.

**Risks:** the Attach gap (most likely to bite, with a direct Milestone-C
precedent); terminal sizing inside a grid cell; and a second workspace's agent
running unseen while you are on another workspace's Home — surfaced by the
sidebar's existing status dots rather than a new indicator.

## 4. What this completes

With Home shipped, the phase's original nucleus is fully built: a workspace bound
to a repo, a PRD leading development, plans as files projected onto boards,
agents reading and writing all of it through MCP, and a home screen to run them
from. Remaining known gaps after this are the accumulated manual smoke passes and
the deferred niceties already logged in the session log.
