---
order: 5120
kind: task
title: [bug] the daemon refuses four of the seven tool kinds
status: Done
---
`save_tool` in `crates/daemon/src/orchestration.rs` still guards its kind
with `matches!(tool.kind.as_str(), "agent" | "command" | "script")` and
bails with "unknown tool kind {kind}" for anything else.

The app has authored all SEVEN kinds since 2026-09-04 (`TOOL_KINDS` in
`orchestrationTools.ts`, and the library dialog draws a chip per kind), so
duplicating "Wait for the pull request", "Manual review", "Loop until a
check passes" or "Start rail" and pressing Save fails at the daemon —
after the human has typed. Found while adding tool icons (v33); not
fixed there because it is a different bug.

1. Reproduce it first: save a `review`-kind tool through the library
   dialog and capture the error the dialog shows.
2. Widen the guard. It exists to refuse a kind the daemon cannot run, so
   decide deliberately whether it should list all seven or drop out of
   the kind business entirely — the daemon branches on `kind` nowhere
   else, and the app already refuses a body a kind cannot express
   (`validateTool`). A guard the app has outgrown twice is worth
   replacing rather than extending, but that is a judgement to argue in
   the commit message either way.
3. Cover it: a store test per kind that round-trips a save, so the next
   kind added to the app fails HERE rather than in the human's hands.
