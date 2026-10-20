---
title: Session Diff shows only this agent's touched files
status: Done
priority: high
---
The Diff chip on a session tab opens the per-run Changes view (`RunChangesModal` / `runChangesState`). Today that view is a checkout-wide `git_run_changes` against the run's `baseSha`. In a shared working tree every co-tenant's dirty files appear — the opposite of the chip's label ("See what this run changed").

The Review tab already fixed this: measure the checkout, then narrow with `card_run_touched_files` (transcript + shell-write hook) via `narrowToTranscript` (now shared in `transcriptNarrow.ts`). Reuse that path in the session Changes view.

## Behavior

1. Load as today: `git_run_changes` against the run's `baseSha` (and peer `until_sha` bound when present).
2. When the card binding has a `conversationId`, narrow the file list with the same transcript reader Review uses (`card_run_touched_files` + `shellWrites`).
3. **Transcript answered** → show only that agent's files. Skip TypeSafe `attributeRun` (those files are already the agent's; a guess must not hand one to a neighbour) — same rule as Review.
4. **Transcript silent** (no conversation id, host too old, transcript gone/unreadable, or the read fails) → keep the full checkout list **and** show an honest quiet strip: these are everything dirty since the baseline in this checkout, not only this agent.
5. Empty after narrowing → Review's copy: "Nothing this run's agent touched is changed in the checkout."
6. **Discard stays whole-checkout** (`reset --hard` to baseline). Do not imply discard is file-scoped when the list is narrowed; keep / strengthen the existing co-tenant confirm copy.

No protocol bump — `card_run_touched_files` and shell-writes already exist.

## Approach

- Lift `narrowToTranscript` (and the shell-writes helper it needs) out of `reviewState.ts` into a shared module both Review and Changes call.
- Thread `workspaceId` + `conversationId` into `openRunChanges` / `RunChangesView` from the card binding (call sites: `RunChangesModal`, `CardTabPane`, and wherever Card detail opens Changes).
- Persist `source: "transcript" | "checkout"` on the view; banner when `checkout`.
- Unit tests in `runChangesState` (and the shared helper) mirroring Review's narrow / fallback / empty-after-narrow cases.

## Non-goals

- Changing discard to touch only listed files.
- Replacing the checkout diff with a transcript-only file list that ignores what is still dirty (candidates stay the checkout's changed files).
- Changing the Review tab's behavior beyond sharing the helper.

## Checklist

- [x] Extract `narrowToTranscript` (+ shell-writes read) from `reviewState.ts` into a shared module; Review keeps calling it unchanged
- [x] Thread `workspaceId` and `conversationId` through `openRunChanges` / `RunChangesView` from the card binding at every Changes open site
- [x] `refreshRunChanges` narrows when possible; records `source`; falls back to checkout list + honest strip when not
- [x] Skip `attributeRun` when `source === "transcript"`; empty-after-narrow copy matches Review
- [x] Discard confirm still describes a whole-checkout reset (no file-scoped implication when narrowed)
- [x] Tests: transcript narrow, checkout fallback + source, empty after narrow, Review still green against the shared helper
- [ ] Human test: two agents in the shared checkout dirty different files; each session Diff lists only its own when transcripts are readable, and shows the honest strip + full dirty tree when conversation id / transcript is missing
