---
kind: task
title: Rail step keeps a stale card path when the file moves
status: Done
---
A rail step stores the card's absolute path. The daemon re-keys it
(`rename_card_path`) only when the daemon itself moves the file — i.e. through
`set_plan_field` / `relocate_for_status`. A card that moves any other way (an
agent running `mv`, a one-time archive migration, a hand edit) leaves the step
pointing at a path with no file behind it.

Four steps on the “Generic fixes” rail are in that state right now:
`plans/rember-last-workspace-hub-tab.md`, `plans/fs-sync.md`,
`plans/tab-naming-and-link.md`, `plans/clear-done-in-orchestration.md` — all
four files now live in `plans/done/`.

The step then reads as “card file is missing”, so the rail **stalls on a
finished card** instead of skipping it. It only bites once the step's run row
is gone (a reorganize, a Clear done, a fresh arrangement), which is why it hid
behind the nested-task bug fixed in
[Orchestration run issue](done/orchestration-run-issue-build.md).

Card file names are unique per context by construction — `parent:` resolves on
(context, file name), and `find_in_plans_tree` already relies on it — so the
daemon's fs watcher could re-key a step by file name when a card's path
vanishes and the same name reappears elsewhere under that `plans/` root.
