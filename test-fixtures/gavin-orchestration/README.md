# Gavin orchestration smoke test — fixture guide

Exact commands and expected output for the manual passes. The **in-app
Checklist tab** (dev Smoke Test workspace) is the tick-off list — 69 items
across all six sub-projects plus the kanban rework — and this file is its
companion for the parts that need a shell.

Sections A–D below cover Foundations and Plans ⇄ Kanban step by step. Everything
the later sub-projects need is seeded by one click; see **Seeded fixture** below
for what lands where and which items each file exists to serve.

**Timing note:** board reactions to file changes arrive within **~3 seconds**
(500 ms watch debounce + 2 s rescan floor) — that delay is by design, not a bug.

**Setup once:**
1. Build/run the current code — and make sure the **daemon** is current too:
   `pkill gavin-daemon` before launching, so the app spawns a fresh one (an old
   daemon predates the gavin protocol and every step below fails confusingly).
   Your existing terminal sessions restart with fresh shells; that's expected.
2. `sh test-fixtures/gavin-orchestration/setup.sh`, then launch the app.

**Tick-off companion:** the dev Smoke Test workspace has a **Checklist** hub tab
covering the same ground with per-workspace saved progress. Use it to track a
pass; use this file for the exact commands and expected output.

Dev builds ship a built-in **Smoke Test** workspace (auto-created at launch,
absent from release builds; closing it just makes the next dev launch recreate
it empty) — use it for everything below instead of creating a workspace by
hand. Once its root is bound, its hub shows a green **Seed demo data** button
that writes the whole fixture in one click (re-click = reset); steps below note
where seeding replaces hand-typed commands.

All shell commands below run from a terminal *inside gavin* whose cwd you
control with `cd`. `PLAYGROUND` means the absolute path printed by setup.sh.

---

## Seeded fixture

**Seed demo data** writes this tree into the bound root. Re-clicking resets it,
so a mangled file is one click from healthy.

```
.gavin-root/
  PRD.md                      real prose, ~20 lines  → home's PRD excerpt
  plans/
    demo.md                   To Do · high           → plan-card, edit-plan-card
    stray.md                  Shipped                → auto column (plan-auto-column)
    broken.md                 unterminated fm        → ⚠ badge (plan-warning)
    drag-one/two/three.md     In Progress · urgent/medium/low
                                                     → drag-placeholder, plan-reorder
    shipped-note.md           Done                   → non-zero Done count
  docs/architecture.md, glossary.md                  → explorer Docs group
  specs/board-behaviour.md                           → explorer Specs group
src/auth/.gavin/
  plans/login.md              To Do · high           → board icon, context board
  plans/session-expiry.md     In Progress · medium   → proves the board is filtered
  docs/auth-notes.md
services/billing/.gavin/
  plans/invoices.md           To Do · medium         → third context in the counts
  specs/pricing.md
src/api/handler.rs            plain .rs              → edit-modes (no Formatted)
src/api/                      NO .gavin              → explorer's "+ context" target
big.log                       just over 1 MiB        → edit-truncated (no Edit mode)
```

Board after seeding: **To Do 4 · In Progress 4 · Done 1**, plus a dashed auto
column **Shipped 1**. Ten plans across three contexts — those are the numbers the
home's tiles and board panel should show.

**Deliberately absent:** `CLAUDE.md` (the `edit-creates` item needs the first
save to create it) and `.mcp.json` (the `mcp-setup` item writes it). Don't add
them by hand before running those items.

Three plans share the *In Progress* column specifically so you can drag one
**downward** past the other two — the placeholder off-by-one the kanban rework
fixed. None of them carry an `order:` line: the first reorder materializing one
is itself part of the assertion.

---

## A. Root binding (Foundations)

- [ ] **A1 — No-root banner.** Open the built-in **Smoke Test** workspace's hub
      (the Kanban tab). Expect: a slim banner — "No root folder set …
      **Set root…**" (and no Seed button yet).
- [ ] **A2 — Unfiled is exempt.** Switch to the Unfiled workspace's hub.
      Expect: **no** banner, ever.
- [ ] **A3 — Init flow.** Back in Smoke Test: Set root… → pick the
      `playground` folder → modal "Initialize gavin in this folder?" →
      **Initialize**. Expect: banner becomes a path chip (`…/playground ⚙`)
      plus the green **Seed demo data** row, and on disk
      `playground/.gavin-root/` now holds `PRD.md`, `config.toml`, `plans/`,
      `docs/`, `specs/` (each subfolder with a `.gitkeep`). `PRD.md` starts
      with `# Smoke Test — Product Requirements`.
- [ ] **A4 — Persistence.** Quit and relaunch the app. Expect: the chip is
      still there (no banner flash), and `config.json`
      (`~/Library/Application Support/com.gavin.app/config.json`) contains the
      workspace's `rootPath`.
- [ ] **A5 — Stale root heals.** In Finder/terminal, rename `playground` to
      `playground-x`. Expect within ~3 s: warning banner "Root not found: …".
      Rename it back. Expect: chip returns on its own — the binding is never
      auto-cleared.
- [ ] **A6 — Re-bind is silent when initialized.** Click ⚙ → pick `playground`
      again. Expect: **no** init modal (`.gavin-root` already exists), chip
      unchanged.

## B. Plan cards on the workspace board

Open a terminal in the Smoke Test workspace and `cd` to `PLAYGROUND`.
**Fast path:** click **Seed demo data** — it creates B1's `demo.md`, B3's
`stray.md`, B6's `broken.md`, and C1's `src/auth` context (plus everything in
**Seeded fixture** above) in one go; then treat the file-creation commands in
those steps as already done.

- [ ] **B1 — Card materializes.** (Seeded, or:)
      `printf -- '---\ntitle: Demo plan\nstatus: To Do\npriority: high\n---\n# Demo plan\n' > .gavin-root/plans/demo.md`
      Expect on the hub board within ~3 s: a **dashed** card "Demo plan" in
      *To Do*, with a file glyph, an orange priority dot, and a context badge.
      (Without a `title:` key the card would show the filename stem, `demo` —
      by design.)
- [ ] **B2 — Drag writes the file.** Drag the card to *In Progress*. Expect:
      it stays there (no snap-back), and
      `cat .gavin-root/plans/demo.md` shows `status: In Progress` (plus an
      `order:` line when you dropped it at a position among other plan cards)
      with every other byte untouched.
- [ ] **B3 — Auto column.** (Seeded as `stray.md`, or:)
      `printf -- '---\nstatus: Shipped\n---\n# Stray\n' > .gavin-root/plans/stray.md`
      Expect: a dashed **auto column** headed `Shipped` appears after the real
      columns. Drag the card into *Done*. Expect: the auto column dissolves and
      the file now says `status: Done`.
- [ ] **B4 — Agent-style live edit.**
      `printf -- '---\ntitle: Demo plan\nstatus: To Do\npriority: high\n---\n# Demo plan\n' > .gavin-root/plans/demo.md`
      (simulates an agent rewriting the file). Expect: the card moves back to
      *To Do* by itself within ~3 s.
- [ ] **B5 — Detail modal + priority write.** Click the demo card. Expect: a
      read-only modal (title, `playground · demo.md`, full path, status). Change
      Priority to `urgent` → `cat` the file: only the `priority:` line changed.
      "Open externally" opens your editor.
- [ ] **B6 — Broken frontmatter degrades, never crashes.** (Seeded as
      `broken.md`, or:)
      `printf -- '---\nstatus: To Do\nno closing marker\n' > .gavin-root/plans/broken.md`
      Expect: a card in the **first** column with a ⚠ badge; its modal explains
      the frontmatter has issues. The board stays fully functional.
- [ ] **B7 — Free-form cards.** "+ Add card" opens an inline title field
      (Enter adds and keeps the field, Esc closes, empty adds nothing). The
      created card has a solid border, is deletable, drags with position, and
      plan cards always render after free-form ones.
- [ ] **B8 — Trello-grade drag.** While dragging any card: a tilted floating
      copy follows the cursor, a dashed placeholder marks the landing slot
      (verify a **downward** same-column move lands exactly there — the old
      off-by-one), neighbors slide smoothly, Esc cancels, and dragging near the
      board's edges auto-scrolls. A clean click still just opens the modal.
- [ ] **B9 — Plan reorder writes order:.** Drag a plan card above another plan
      card in the same column. Expect: the order sticks, survives the ~3 s
      watcher echo, and `git diff` shows only `order:` lines (the first reorder
      in a column materializes `order:` for its plan block).
- [ ] **B10 — Column reorder + composer.** Drag a column by its header — it
      lands exactly at the placeholder in both directions. "+ Add column"
      opens an inline name field with the same composer keys as B7.
- [ ] **B11 — Save failure surfaces.** `pkill -x gavin-daemon`, then drag a
      free-form card. Expect: the card snaps back and a dismissible "Couldn't
      save" banner appears; after **Restart daemon & retry** the next drag
      succeeds and clears it.

## C. Per-session context boards

- [ ] **C1 — Context + icon.** (Seeded — just `cd src/auth` — or:)
      `mkdir -p src/auth/.gavin/plans` then
      `printf -- '---\nstatus: To Do\n---\n# Login flow\n' > src/auth/.gavin/plans/login.md`
      and `cd src/auth`. Expect: within ~3 s a **kanban icon** appears at the
      right end of the pane's tab bar (tooltip "Open board · auth"). (`cd ..`
      to `src` — icon changes to the root context; `cd auth` again.)
- [ ] **C2 — Board tab.** Click the icon. Expect: a split opens with a tab
      labeled **`auth · board`** showing the workspace's columns but **only**
      auth's plan card (no free-form cards, no root plans). The tab is not
      renameable (double-click does nothing).
- [ ] **C3 — Drag there too.** Drag "Login flow" to *In Progress*. Expect: file
      updated, card stays. The same card also moved on the hub board (same
      files, same truth).
- [ ] **C4 — Restart survival.** Quit and relaunch. Expect: the `auth · board`
      tab is still in the layout and functional (a brief "context…" flash while
      the first tree push arrives is acceptable).
- [ ] **C5 — Missing context.** `rm -rf PLAYGROUND/src/auth`. Expect within
      ~3 s: the board tab shows "This context no longer exists." Close the tab:
      **no** "terminal sessions will end" prompt mentions it (a board tab is
      not a session).

## D. Cleanup

- [ ] Close the Smoke Test workspace (expect: the close prompt counts only
      real terminal sessions; the workspace respawns empty on the next dev
      launch — by design). Then `rm -rf` the `playground` folder — it is
      git-ignored, nothing to revert (that also removes the ~1 MiB `big.log`
      the seeder generates).

---

**If a step fails:** note the step id and what happened instead; everything
here is covered by automated tests except the rendered UI itself, so a failure
is most likely a wiring/visual issue worth a targeted fix.
