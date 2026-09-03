---
order: 7168
kind: task
title: Proposed memories as note cards
status: Done
priority: medium
---
Let an agent propose a durable fact about the repo as a note card, and let the human adopt it into the workspace instructions file with one action.

Read first: `app/src-tauri/src/agent_setup.rs` (the marker-fenced `<!-- gavin:start -->` block it merges into CLAUDE.md / AGENTS.md on "Set up / update" — adopted memories must survive that re-merge, so they need their own sub-section inside the block that the merge preserves), `app/src/lib/AgentFileHubView.svelte` + `fileEditing.ts` (the instructions-file editor, created on first save), the card detail modal's action row, and `.claude/skills/gavin/SKILL.md` (the convention has to be written down where agents read it).

Behaviour:
- Convention: `kind: note`, label `memory`, body = one sentence-sized fact plus an optional "Why" line. Add `memory` to the board's label vocabulary in this workspace.
- The card detail modal shows "Adopt into <instructions file name>" on a note labelled `memory`. Adopting appends the body as a bullet under a `### Learned` heading inside the gavin block, opens nothing, and sets the card Done (it files under `plans/done/`).
- `agent_setup.rs`'s merge keeps the `### Learned` section byte-for-byte when it rewrites the block; add a Rust test for that.
- The gavin skill gains a short "Proposing a memory" paragraph naming the convention.

Out of scope: any automatic extraction from transcripts; the app never proposes memories itself — agents do, via ordinary card creation.

Done when: the Rust merge test and a `.ts` unit test for the adopt action are green; the Tauri crate's `cargo test` and `cd app && npm test && npm run check` pass; a smoke item is added to `smokeChecklist.ts`.

Borrowed from Cursor's Memories (sidecar proposes, human approves) (2026-09-03 feature scan).
