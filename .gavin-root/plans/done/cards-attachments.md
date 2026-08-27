---
title: Cards attachments
kind: plan
status: Done
---
Allow users to attach files to a card; it should be a reference to a fs file,
that checks if the file exits. The file should then be referenced in the prompt.

## Decided

- **Frontmatter, comma-separated** — `attachments: docs/spec.md, /Users/…/shot.png`,
  read by the existing flat `key: value` parser exactly like `labels:`.
- **Relative inside the workspace root, absolute outside it.** A relative path
  always resolves against the **workspace root**, never the session's cwd: the
  same card hands every session — worktree or not — the same bytes.
- **A missing attachment blocks the run**, board Run and rail step alike, naming
  the file. An agent handed a dead path burns a whole session before anyone notices.
- **The host stats, on demand** — the modal when it opens, the run gate just
  before spawning. The daemon does not stat attachments on scan, so the board
  card face shows a count only, never brokenness.
- **A chip opens the file in gavin's viewer**, falling back to the OS default app
  for anything not text/markdown/code (the PRD's existing rule for binaries).

The `attachments` field parses on any card kind; only task and plan cards put it
in a prompt. A note is a fine place to park a reference.

## Steps

- [x] `PlanFileInfo.attachments: Vec<String>` (`serde(default)`, so an older daemon's
      tree still parses), read in `plan_file_info`; `usable_attachment_path` in
      `crates/protocol` mirrors `usable_prd_path` — trims, rejects empty and `..`,
      keeps an absolute path as-is. Unit tests cover relative, absolute and junk.
- [x] `set_plan_field`'s allow-list gains `attachments` (single line, no newline),
      and becomes the fourth key an empty value may clear beside `status`,
      `parent` and `labels`. Daemon tests cover write, clear and reject.
- [x] `CreatePlan` gains `attachments: Option<String>`; `PROTOCOL_VERSION` bumps.
- [x] `FEATURE_MIN_VERSION.attachments` in `daemonCompat.ts` **with real
      consumers** — `min_version_for` gates request types, not fields, so an older
      daemon would drop the new `CreatePlan` field silently and bail on the new
      `SetPlanField` key. The gate is dead without them.
- [x] Tauri host `attachment_status(root, paths) -> [{ path, absolutePath, exists }]`,
      resolving relative against the workspace root; a test proves a `..` path is
      refused rather than stat'd.
- [x] `app/src/lib/attachments.ts`, pure and unit-tested: parse/format the
      frontmatter line, add/remove a path, relativise a picked absolute path
      against the root, render the prompt block. The `.svelte` files stay templates.
- [x] `composeTaskPrompt` and `composePlanPrompt` gain that block — absolute paths,
      one per line, instructed to be read first — so board Run and orchestration
      steps both get it from the one seam.
- [x] The run gate: `cardRunActions.ts` and `orchestrationState.ts` refuse to spawn
      when an attachment is missing, naming it; in a rail the step fails with that
      reason instead of starting. A test per path.
- [x] Card detail modal: an Attachments section — chips with a ✕, a `Pick…` button
      reusing `HubFilePicker`'s dialog→validate→commit shape, a broken state for a
      path that no longer resolves, and the blocked reason on a non-disabled
      ancestor (a disabled button never fires `mouseenter`).
- [x] A chip click opens the file via `openFileInSplit`; `fileTypes.ts` gains the
      text/code test that decides, with `openPath` for everything else.
- [x] Compose modal (⌘N) can attach before the card exists — `cardCompose.ts`
      carries the list into `buildCreatePlanArgs`, gated by the same reason.
- [x] `BoardCard.svelte` shows a paperclip + count from the parsed field alone.
- [x] `cargo test --workspace` and `npm test && npm run check && npm run build`
      green; `smokeChecklist.ts` gains pick, remove, broken chip, blocked run,
      ⌘N attach, and the old-daemon disabled state.
