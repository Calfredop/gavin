# `app/src/lib`

Eighteen folders and `sources.ts`. Nothing else sits at this level: if you
are looking at a loose file here, it is the source map, and everything
else belongs to exactly one domain.

A folder holds a domain's modules, its components and its tests together.
That is deliberate — the logic lives in a plain `.ts` module with unit
tests and the `.svelte` file stays a thin template over it (see
CLAUDE.md), so the module and the template it serves are two halves of
one thing and reading either one means reading the other.

| folder | files | what lives there |
|---|---|---|
| `agents/` | 41 | What an agent is and what happens to it while it runs: model and pause state, usage probes and projection, the launch gate, queue and estimate, auto-resume, the follow-up queue, the attention inbox, the memory wall. |
| `board/` | 31 | The kanban board — columns, cards, drag, selection, filters, search, and the facets the hub board is narrowed by. |
| `cards/` | 66 | A card's whole life: compose, detail, agent binding, complexity, run, run history, run changes, best-of-N, review request, completion. |
| `core/` | 54 | What every other folder imports. `backend` (the daemon RPC surface), `layoutState`, `workspace`, `gavin`, `planBoard`, settings, the confirm gate, and the modal, dialog, keyboard, shortcut and tooltip primitives no domain owns. |
| `files/` | 43 | Anything opened from disk: the file tree, the editor and its markdown toolbar, CodeMirror, the plan explorer, the PRD viewer, the archive. |
| `git/` | 60 | Version control: status, diff, graph, commit, conflicts, discard, fork, pull requests, auto-commit, and the worktree lifecycle. |
| `guards/` | 7 | Static tests whose subject is the app as a whole rather than a domain — the dev CSP, the vite style cache, `:global()` scope leaks, the opener plugin's permissions, the Tauri command gate, the window header, the view boundary. |
| `hub/` | 22 | The workspace's own page: its tab strip, the modal that edits it, per-tab prefs, the view registry every tab resolves through, and the Home split. |
| `orchestration/` | 61 | Rails and the steps in them — the drawer, the step cards, the tool library, group templates, drag glue, rail binding. |
| `panes/` | 24 | Window management inside the app: the split layout, the tab row and its menus, drop targets, and the pointer-drag and hover-intent primitives those drags need. |
| `review/` | 17 | The Review tab — its board, its prefs, its three panes, and what launches an agent into it. |
| `sessions/` | 17 | What happens to an agent's PTY when nobody is watching: the sessions manager, orphan recovery, done-session reclaim, and which waiting session a human has already read. |
| `shell/` | 26 | The OS window: title bar and its drag gesture, traffic lights, resize edges, closing the app, the updater, the daemon banners. |
| `sidebar/` | 15 | The sidebar and the six modules behind it — expansion, search, peek, menu, prefs, per-row summary. |
| `terminal/` | 12 | The xterm panes, the registry that keeps them alive across tab switches, fit and font sizing, and the terminal's own scroll gesture. |
| `workspace/` | 27 | Workspace lifecycle: opening, creating, deleting, the setup wizard, the trust gate over the config it reads, and the workspace's tool library. |
| `ui/` | 18 | The shared visual vocabulary — `StatusBadge`, `indicators.ts`, the icon library, theme. Predates the folders above and is unchanged by them. |
| `wizardSteps/` | 7 | The setup wizard's steps. Also predates the folders; `SetupWizard.svelte` itself is in `workspace/`. |
| `fixtures/` | 1 | Test data. |

## `sources.ts`

The one file at this level. About sixty tests read their subject's SOURCE
TEXT rather than its exports — mounting the real component needs a
daemon, a window and a PTY, so the guard greps the markup instead.

Every one of them used to build its own map with
`import.meta.glob("./*.svelte")`, which answers "what sits beside me",
i.e. a fact about the directory layout rather than about the app. That
made the layout load-bearing, and four of those guards sweep the map
instead of naming a file — over a shrunken map they pass green covering
nothing.

So the glob happens once, here, recursively, and a guard asks for a
**name**: `source("TerminalPane.svelte")`, wherever it lives. Which
folder a file is in is this module's problem and nobody else's. Use it
rather than a fresh `import.meta.glob`; `sources.test.ts` pins a floor
under the map's size so a glob that stops matching fails instead of
passing.

## Imports

Intra-lib imports are `$lib/<folder>/<name>`, never `./sibling`. A
relative import is a claim about where the IMPORTER sits, which is what
made this reorganization expensive the first time; `$lib/core/backend`
says nothing about who is asking. Only paths that leave lib
(`../../package.json`, the vite plugins) stay relative.
