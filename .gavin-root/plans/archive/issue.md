---
order: 11264
title: [issue] 11 rails at once thrashed the Mac into a reboot
status: Done
complexity: complex
---
I’ve started 11 rails, between two workspaces and the app spiked at 50 GB of RAM used. This led to a hardware crash (Mac abruptly rebooted).

**What happened.** The Mac has 32 GB, so 50 GB was RAM plus swap, and the reboot was a watchdog reset under thrash. Gavin's own per-session cost is small (the daemon's screen model is under 4 MB a session, one xterm per session in the webview). The weight was 11 agent process trees at once: each Claude Code process, its MCP servers, and the builds and test runs they started, each in its own worktree with its own `target/`. On top, watchman keeps a root per checkout the other workspace's tooling ran in and never lets go of a deleted worktree's root by itself.

**Decided (do not re-litigate).** Both guards, not one: a ceiling on agent turns in flight AND a memory-pressure hold. Every "run this" request from any source (a rail step, board Run / Run all / Run selected, resume, develop, review, tools, Generate/Reorganize, commit via agent, auto-resume) goes through one gate and, when held, is queued and launched automatically when a slot frees or pressure clears. Nothing running is ever killed or stopped by gavin: a hold gates starts only, as the token pause already does. The ceiling counts agent sessions whose status is working or asking, app-wide across windows; default 4; a finished agent sitting idle frees its slot, and the pressure hold covers idle-but-fat sessions. Run all in the Kanban column, the selection bar and the Orchestration tab shows a memory estimate before starting and starts through the same queue.

- [x] Memory probe and fleet memory store (child card `issue-memory-probe.md`)
- [x] Launch gate and queue, every start routed through it (child card `issue-launch-gate-queue.md`)
- [x] Surfaces: queued marks, fleet strip, pressure banner, settings, Run all estimate (child card `issue-launch-surfaces.md`)
- [x] Full suites green (`cargo test --workspace`; `cd app && npm test && npm run check && npm run build`), the daemon's `gavin::tests` re-run alone if they fail, plus a static pre-flight grepping the exact strings the three surfaces rely on. No protocol bump anywhere: this is host and frontend work.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
