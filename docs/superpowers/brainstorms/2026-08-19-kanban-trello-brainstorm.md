# Kanban Trello-quality rework — session log (2026-08-19)

Focused improvement session on the kanban board, from
`docs/superpowers/briefs/2026-08-19-kanban-trello-brief.md`. Decisions are
numbered K1… to keep them distinct from the phase log's D-sequence
(`2026-08-06-agent-orchestration-brainstorm.md`), which still governs.

## Decisions

- **K1 (2026-08-19):** **Hand-rolled pointer-event drag engine** (recommended,
  approved) over fixing HTML5 DnD or adopting `svelte-dnd-action`. Rationale:
  kanban drag kinds are never consumed outside the board surfaces (Sidebar/Pane
  only exclude them), Svelte 5's built-in `animate:flip` provides FLIP reflow
  with zero deps, and all index/hit-test math lands in pure `.ts` modules — the
  repo's only real verification lever since components can't be unit-tested.
  HTML5 DnD kinds (`kanban-card`/`kanban-column`/`plan-card`) are removed from
  `dragDrop.ts` and dead guards cleaned up.
- **K2 (2026-08-19):** **Full polish scope approved:** auto-scroll at edges,
  inline composers, hover affordances + column counts, **plus** (owner
  addition) rich animations and a Trello-style **tilt on the dragged card**.
- **K3 (2026-08-19):** **Manual plan-card ordering IS in scope** (user override
  of the defer recommendation): new integer `order:` frontmatter field, written
  through the existing surgical field writer; daemon allow-list gains `"order"`
  with i64 validation; sort key (order ?? +∞, contextFolder, fileName).
- **K4 (2026-08-19):** **Plan cards stay their own orderable block** after the
  free-form cards (recommended, approved) — no interleaving with free-form
  cards this session; that would force fractional ranks onto the SQLite
  position model. Interleave remains possible later without wasted work.
- **K5 (2026-08-19):** **BoardPane reuses KanbanColumn** via a `planOnly` mode;
  auto-column rendering also shared. One rendering path, both surfaces.
- **K6 (2026-08-19):** **Persist failures roll back + banner; staleness fixed
  by focus/visibility refetch** guarded against in-flight mutations.
- **K7 (2026-08-19):** **Index contract pinned:** `moveCard`/`reorderColumn`
  keep remove-then-insert; the engine supplies post-removal indices by
  construction; regression tests pin the brief's `[A,B,C]` worked example.
- **K8 (2026-08-19):** **Deferred:** keyboard-accessible card moves (the eight
  a11y warnings still get fixed — focusable cards, Enter opens), free-form
  fractional ranks, plan/free-form interleaving.

## Incidents

- Concurrent session detected in the same working tree during brainstorming
  (`app/package.json` gained CodeMirror deps — sub-4 file viewer work). This
  session adds no dependencies and its file set barely overlaps; flagged at the
  spec review gate.

## Execution notes (2026-08-19)

- All 20 plan tasks executed inline, one commit per task, on `main`.
- **Deviation from plan Task 10:** plan cards kept their complete HTML5 drag
  path until Task 12 instead of half-migrating — `draggable="true"` plus
  pointer handling on the same element lets the browser's native drag hijack
  the pointer stream, so each intermediate commit stays fully functional.
- **planCommitFromMerged** (plan Task 13's shared helper) was pulled forward
  into Task 12 so the hub never carried a duplicate to be deleted one task
  later; it landed in `planDrop.ts` with its own tests.
- Task 6's regression tests passed immediately as the plan predicted: the
  off-by-one lived in the *callers* (pre-removal indices), never in
  `moveCard`/`reorderColumn`.
- Baseline "eight a11y warnings" resolved to three remaining after the
  rewrites (rename span, nameDraft initial-capture, unused prop) — the other
  five died with the deleted HTML5 markup. Kanban files now carry 0 warnings;
  the repo's remaining 31 live in Sidebar/Pane/TitleBar (pre-existing, out of
  scope).
- Final automated evidence: `cargo test` 256 pass; `npx vitest run` 366 pass
  (baseline 291); `npx svelte-check` 0 errors; `vite build` clean.
- **Outstanding:** the interactive smoke pass (Board interaction section of
  the in-app checklist, fixture README B7–B11) needs a human at the app — a
  GUI drag can't be driven from this session.

## Incident: drop left the board stuck in drag state (2026-08-20)

- Owner's first manual pass: releasing a dragged card did nothing — preview
  and placeholder persisted. Root cause: all pointer listeners sat on the
  board root, relying on bubbling or `root.setPointerCapture()` retargeting.
  Tauri renders in **WKWebView**, which pairs the release with the original
  pointerdown target; that target (the dragged card's wrapper) leaves the DOM
  at drag activation, so WebKit dropped the `pointerup` instead of
  retargeting it (Chromium retargets — the engine was designed against
  Chromium behavior). Moves kept flowing (hit-tested fresh), which is why the
  drag itself looked fine.
- Fix (`kanbanDragGlue.ts`, `kanbanDrag.ts`): gesture events attach to
  **window** (capture phase, filtered by pointerId) for the drag's duration —
  the pattern every battle-tested pointer-DnD library uses — with
  `setPointerCapture` kept as best-effort only. Plus a unit-tested
  self-healing rule: a tracked move arriving with `buttons === 0` means the
  platform ate the release, and stands in for the drop.
- Lesson for this codebase: never assume Chromium event semantics — the app
  ships on WKWebView, where DOM removal under an active pointer breaks
  element-level delivery.

**Correction (2026-08-20, second report + screenshot):** the stuck-after-drop
symptom was NOT lost pointerup delivery. The owner's screenshot showed the
dragged card back in its list with no placeholder — dragState had cleared, so
`endPointer` ran and the release was delivered. The stuck element was the
**drop-settle preview**: its rAF supersession guard compared the raw settle
object against the `$state` variable it was assigned to, and **Svelte 5
proxies objects on `$state` assignment**, so the identity check was always
unequal, the landing step never ran, and the tilted preview persisted after
every card/plan drop. Fixed with a plain token counter (primitives are never
proxied). The window-listener + buttons===0 hardening from the first attempt
stays — it is the standard delivery pattern and unit-covered — but its
"WKWebView drops the pointerup" claim is downgraded to unverified hypothesis.
Process lesson: the first fix shipped without reproducing the symptom or
demanding evidence; the screenshot falsified it in one glance.
