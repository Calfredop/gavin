---
order: 5120
title: Break app/src/lib out of one flat directory
status: To Do
priority: medium
complexity: complex
---
`app/src/lib/` holds **506 entries in one flat folder** — 105 `.svelte`, ~185
`.ts` modules and 218 `.test.ts` — with only `ui/` (18), `wizardSteps/` (7) and
`fixtures/` (1) grouped. It is the first thing a visitor to the repo opens and
the last thing they can read. Nothing else in `app/` has this problem:
`src-tauri/src` is 31 modules with a `git/` submodule, `routes/` is three files,
no module is dead (every non-test module has at least one importer), and there
is not one `TODO`, `FIXME` or stray `console.log` in the whole tree.

**The names already did the classification.** A prefix classifier put 476 of 503
files into 15 domains with 27 stragglers:

| folder | modules | components | tests | total |
|---|---|---|---|---|
| `orchestration/` | 18 | 12 | 30 | 60 |
| `agents/` | 24 | 7 | 27 | 58 |
| `git/` | 16 | 20 | 16 | 52 |
| `cards/` | 18 | 5 | 22 | 45 |
| `files/` | 14 | 11 | 14 | 39 |
| `shell/` | 15 | 7 | 15 | 37 |
| `board/` | 15 | 8 | 14 | 37 |
| `core/` | 17 | 2 | 15 | 34 |
| `panes/` | 13 | 7 | 11 | 31 |
| `hub/` | 5 | 11 | 8 | 24 |
| `terminal/` | 6 | 2 | 9 | 17 |
| `review/` | 5 | 4 | 7 | 16 |
| `sidebar/` | 6 | 2 | 7 | 15 |
| `sessions/` | 3 | 3 | 5 | 11 |

The 27 stragglers are a `workspace/` lifecycle group (create / delete / tools /
root control) and cross-cutting guard tests.

## Two constraints that decide the order of work

**1. ~60 test files glob the flat directory.** They build their subject with
`import.meta.glob("./*.svelte")` (86 hits), `"./*.ts"` (12) or
`"./*.{svelte,ts}"` (12) and look sources up by bare key —
`SOURCES["./BoardCard.svelte"]`. A flat glob is precisely what a subdirectory
move breaks. Most throw `no source for X` and fail loudly, but four
(`absolutePaneMount`, `settingsSearchSurfaces`, `tooltipSurfaces`,
`terminalPaneSession`) sweep `Object.entries(SOURCES)` and would **silently pass
over a shrunken set** — a green suite proving nothing. This has to be fixed
before the first file moves.

**2. 2117 of 2182 intra-lib imports are `./sibling`** (against 49 `$lib/*`).
Moving one file rewrites that file's own imports *and* every importer's path to
it. Converting intra-lib imports to `$lib/...` first makes the importer's
location irrelevant, so each later move only touches lines that name the moved
file.

## Steps

- [ ] Land the source-map seam (nested task) — `lib/sources.ts` resolving a bare
      name to its glob key at any depth, plus a floor assertion, and every
      `import.meta.glob` guard moved onto it
- [ ] Codemod intra-lib relative imports to `$lib/...` (`./x` → `$lib/x`,
      `../routes` untouched); `npm run check` and `npm test` green with zero
      files moved — this commit must be pure text
- [ ] Agree the folder list on this card before moving anything; `ui/` and
      `wizardSteps/` stay where they are
- [ ] Move `terminal/`, `sessions/`, `review/`, `sidebar/` first — smallest, and
      they exercise the seam on a batch that is cheap to revert
- [ ] Move `board/`, `cards/`, `hub/`, `panes/`, `files/`
- [ ] Move `git/`, `orchestration/`, `agents/` — the three largest
- [ ] Decide `core/`: either a `core/` folder or the deliberate residue left at
      `lib/` root (`layoutState`, `backend`, `workspace`, `gavin`, `planBoard`
      are the five highest fan-in modules at 106/86/71/58/56 importers)
- [ ] Give the stragglers a home: `workspace/` for the lifecycle group, and a
      home for the cross-cutting guards that belong to no domain
      (`viewBoundary`, `globalStyleScope`, `appHeader`, `devCsp`,
      `viteStyleCache`, `openerScope`, `commandGate`)
- [ ] Add `app/src/lib/README.md`: one line per folder saying what lives there
- [ ] `cargo test --workspace`, `cd app && npm test && npm run check && npm run build`

## Notes

- One move per commit, one domain per commit — `git log --follow` is the only
  thing that will make this history readable later.
- The working tree is shared. This touches nearly every file in `app/src/lib`,
  so it wants a detached worktree and a quiet moment, not an afternoon beside
  four other sessions.
- No behaviour changes here. Any file that wants its logic extracted is
  `chore-app-oversized-components.md`, not this card.
