---
order: 34816
kind: task
title: [ui] clean decisions/review
status: Done
complexity: moderate
---
Add an agent action in both decisions and review tab. It should ask the agent to clean stale decisions.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: Decisions tab and Review tab each show a robot button in the list header (Clean stale decisions / Clean stale tests); with open items it opens a named agent tab in the workspace root whose prompt lists them; with none it is dimmed and hovering says why
- [ ] Human test: The clean button on Decisions and Review shows the bot with the rails' broom beside it, and pressing it opens the in-app confirm ("Clean stale decisions?" / "Clean stale tests?"); "Not now" starts nothing, "Start the agent" opens the agent tab
