# Gavin orchestration smoke test — Foundations + Plans ⇄ Kanban

Covers the two shipped sub-projects end to end in ~10 minutes. Run top to
bottom; each step names its expected result. Timing note: board reactions to
file changes arrive within **~3 seconds** (500 ms watch debounce + 2 s rescan
floor) — that delay is by design, not a bug.

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
that writes the B1/B3/B6/C1 fixture files in one click (re-click = reset);
steps below note where seeding replaces hand-typed commands.

All shell commands below run from a terminal *inside gavin* whose cwd you
control with `cd`. `PLAYGROUND` means the absolute path printed by setup.sh.

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
`stray.md`, B6's `broken.md`, and C1's `src/auth` context in one go; then treat
the file-creation commands in those steps as already done.

- [ ] **B1 — Card materializes.** (Seeded, or:)
      `printf -- '---\ntitle: Demo plan\nstatus: To Do\npriority: high\n---\n# Demo plan\n' > .gavin-root/plans/demo.md`
      Expect on the hub board within ~3 s: a **dashed** card "Demo plan" in
      *To Do*, with a file glyph, an orange priority dot, and a context badge.
      (Without a `title:` key the card would show the filename stem, `demo` —
      by design.)
- [ ] **B2 — Drag writes the file.** Drag the card to *In Progress*. Expect:
      it stays there (no snap-back), and
      `cat .gavin-root/plans/demo.md` shows `status: In Progress` with every
      other byte untouched.
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
- [ ] **B7 — Free-form cards untouched.** Add a normal card via "+ Add card".
      Expect: solid border, deletable, drags with position — completely
      unchanged behavior, and plan cards always render after free-form ones.

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
      git-ignored, nothing to revert.

---

**If a step fails:** note the step id and what happened instead; everything
here is covered by automated tests except the rendered UI itself, so a failure
is most likely a wiring/visual issue worth a targeted fix.
