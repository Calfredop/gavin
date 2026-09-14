---
kind: task
title: Orchestration critical-review step
status: Done
parent: feat-critical-review.md
complexity: complex
---
Add an orchestration tool/step that runs Critical review on the **whole rail** (same fan-out and card filing as the critical-review dialog).

When the rail reaches the step, launch N reviewers on the rail's combined diff; file findings as cards; honour the auto-build-findings-rail toggle (default off). Prefer complete-then-advance once reviewer sessions exit (clear stall/skip only if that matches other wait-style tools and you must).

Wire into the tool library; tests for scheduling/completion. Keep it distinct from `builtin:code-review` (single agent) and Manual review (human pause).
