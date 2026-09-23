---
order: 13312
kind: plan
title: [feat] Decisions tab
status: Done
complexity: moderate
---
A new tab in the workspace hub listing everything waiting on the human
before work can move: sessions waiting on you, decisions an agent filed,
human tests, rail review gates and cards stalled on their first-run
review. Each is presented under its card — or its session, when there is
no card — the way the Review tab presents finished work.

Original ask: *"A new tab in workspace's hub, where all decisions and
human tests need to be taken are reported. The criteria should be similar
to review, but each decision should be presented by it's card/session.
Basically all pending sessions should be here, but also decision that
needs to be taken in order for the task/plan to proceed, or human tests."*

## Settled in the interview (2026-09-22) — do not re-decide

- **Human tests come back, as card items.** This reverses PRD current
  focus #5's "gavin no longer tracks it", but only for checks that really
  need a person — another machine, a real install, a judgement call —
  never as a routine UI smoke backlog.
- **Markers.** `- [ ] Decision: <question>`, with an optional indented
  `Options: A) … B) …` line, and `- [ ] Human test: <what to check>`.
  The spellings already on cards — `Human:`, `Human, …:`, `Owner…:`,
  `Manual …:` — parse as human tests.
- **Filing.** An MCP tool, `gavin_request_human(card, kind:
  "decision"|"test", text, options?)`; the daemon writes the marker line.
  gavin-mcp claims the card for the filing session (`claim_card`), so the
  card's binding IS the filer. Re-filing an identical test whose last
  result is a failure re-arms it (appends `Ready for re-test (date)`)
  instead of duplicating it.
- **Answering, in the tab.** A decision: pick an option and/or write a
  note → ticked, with `Answer (date): …` written under it. A test: Pass →
  ticked, `Result (date): passed`. Fail → `Result (date): failed — <note>`,
  box stays unticked, the item shows as "failed · with the agent" and
  leaves the waiting-on-you count. "Fail and close" (forced by the human)
  ticks it with the failed result.
- **Notify.** After any answer the app queues one message (`QueueInput`)
  to `cardSessionFor(card)` when that session is live and not
  interrupted. Otherwise nothing is sent, and the answer waits in the
  card for the next agent to read.
- **Layout.** Left list: one row per card with open items (with its
  session's state), per waiting session with no card, per rail review
  gate, per unreviewed card — longest wait first. Right: the selected
  subject's items with their answer controls on top; below, the Review
  tab's `ReviewAgentPane` (Session | Plan) reused as-is. No touched-files
  or diff columns — those stay Review's.
- **Also listed.** Rail `review` gates (Skip / Mark done), unreviewed
  cards (open the card's review), and prose questions the TypeSafe turn
  verdict reads as asking/blocked (a follow-up, below). The tab wears the
  hub strip's attention pip whenever anything waits.
- **Placement.** `requiresRoot`, between Tools and Review in
  `HUB_VIEW_META`; the pure half in a new `app/src/lib/decisions/`
  folder.
- **Unchanged.** The app hub's "Waiting on you" inbox and the ⇧⌘A
  next-waiting button stay session-only.
- **Out of scope.** An MCP tool that blocks until the human answers;
  storing a filer per item; any change to the Review tab.

## Checklist

- [x] Wire half — task card `decisions-tab-wire.md` (its own rail step)
- [x] The tab — task card `decisions-tab-view.md` (its own rail step,
      after the wire half)
- [x] Teach the agents `gavin_request_human` and both markers:
      `app/src-tauri/src/gavin_skill.md`, `gavin_resume_skill.md` (a
      resume reads answers and failed results first) and
      `gavin_develop_skill.md`, plus this repo's
      `.claude/skills/{gavin,gavin-resume,gavin-develop}/SKILL.md`; the
      template-drift guards stay green
- [x] Amend PRD current focus #5 and CLAUDE.md's "How UI work is
      structured" paragraph: a rendered check that needs a person is
      filed as a `Human test:` item, never as a smoke backlog
- [x] Verdict follow-up — nested task `decisions-tab-verdict.md` (the
      turn verdict is on main since the 2026-09-22 merge)

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
