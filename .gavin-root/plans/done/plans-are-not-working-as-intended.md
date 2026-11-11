---
order: 16384
kind: task
title: Plans are not working  as intended
status: Done
complexity: intricate
---
Starting a plan card doesnt behave as expected. It runs the plan card in an agent that doesnt complete the plan, especially if it has nested cards. The expected behaviour is to start the plan and it should take it to the end, using full gavin potential (rail, start session…)

## Found (2026-11-11)

- A plan with nested tasks orchestrated them only with an explicit `children:` line. Without it, Run started ONE agent with a prompt that never mentions the nested tasks (arena-roguelike `sounds-fake-audience`, 2026-11-06: the human had to say "handle the plan like a rail as gavin intend").
- The one-session plan prompt never told the agent to finish: no "set it to the done column", unlike the task prompt.
- Resume / Launch as new session on an orchestrated plan mid-children started one plan agent beside the rail.

## Checklist

- [x] A plan with nested tasks orchestrates them by default (`sequence`; `children: parallel` still opts into all-at-once): Run, rail steps, the plan's own prompt
  `childrenModeOf` in `orchestration.ts` is the one rule; ADR 0014. Run asks the first-Run review for each child still to run and the plan up front, since the rail can only stall on an unreviewed card. A daemon older than v80 stalls the rail step with the version reason, and board Run there still runs one session.
- [x] Resume and Launch as new session on a plan with children still to run go to its rail
  `pressGoesToRail`; an automatic resume still reopens the session it was asked about.
- [x] One-session plan prompts (run, resume) say to finish and set the done column; no mid-run promotion
- [x] Children control, board mark, nested run states, Companion follow the new default
  The control is Sequence / Parallel (no line reads as Sequence); `nested-with-parent` is always live.
- [x] MCP tool text, shipped skills, CONTEXT.md, ADR record the default
- [x] Suites green (app, companion, cargo for gavin-mcp)
  2026-11-11, shared tree: app 8582 tests, check 0 errors, build; Companion 934 tests, check 0 errors, build; gavin-mcp 136; Tauri host 912 + the one `git::watch` fs-watcher test, green when re-run alone.
- [ ] Human test: In the running app, press Run on a plan with two nested tasks and NO `children:` line: it asks to review each unread card, makes a rail named after the plan, runs each child as its own tab one after the other, then the plan's own session, and the plan ends in Done.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
