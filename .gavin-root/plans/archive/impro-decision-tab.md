---
order: 16384
kind: task
title: [impro] Decision tab
status: Done
complexity: complex
---
At the moment the decision tab keeps both proper decisions and human tests, like smoketests. The latter I think they should belong in Review tab. Also the decisions should have a search feature and filters by status. Done and archived card’s decisions/review items should not show up.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

## Plan

- [x] decisions.ts: decisions only (no `Human test:` items), Done/archived cards' items left out, a search + status filter over the list
- [x] Decisions tab: search box, status picker, filtered list and empty state
- [x] review/humanTests.ts: the owed human tests per card, minus Done/archived, with its own waiting/failed counts
- [x] Review tab: a Human tests section in the list, the selected card's tests answered in a band over the panes, the attention mark moved to the Review tab
- [x] Docs that say tests live in the Decisions tab: PRD, CLAUDE.md, the three skills, gavin-mcp's request_human text
- [x] Tests green: app npm test + check, gavin-mcp tests

**2026-10-06, done (8e70e31c, not pushed).** Decisions lists decisions only, with a search box and a Status picker (board columns minus Done, plus No status / No card). Human tests moved to the Review tab: a "Human tests" section heads its list, and the selected card's tests are answered in a band above the columns with the same row and write. Review gets its own attention mark. Items on Done or archived cards (by effective status) show in neither tab. Not yet seen in the running app.
