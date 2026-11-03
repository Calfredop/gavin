---
order: 4096
kind: task
title: [feat] gitignore/git exclude cards
status: Done
---
add a flag for a card to be gitignored/excluded

## Plan

The flag lives in git, not in the card: the same rule `git/tracking.rs` keeps
for the whole `.gavin-root/` (a stored copy would drift from `.gitignore` the
moment anyone edited it). A card's control in Card settings → **Git** picks one
of: *Tracked* · *Ignored (.gitignore)* · *Excluded (.git/info/exclude, this
checkout only)*, and gavin reads the answer back with `git check-ignore`.

The rule names the card by file name under its context's `plans/` folder —
`/.gavin-root/plans/**/<name>.md` — so it keeps holding when Done files the
card under `plans/done/` or it is archived. Ignoring does not untrack a card
already committed, so ignoring one asks first whether to stage its removal
from the index (`git rm --cached`, never committed).

- [x] `git/card_ignore.rs`: pattern, status (check-ignore -z -v), set, tests
- [x] Register `card_git_ignore` / `set_card_git_ignore` (lib.rs, commands.rs, remote table, guard tables)
- [x] `backend.ts` + pure `git/cardIgnore.ts` (view model) with tests
- [x] CardDetailModal: Git row in Card settings, untrack prompt
- [x] cargo test (card_ignore) + app npm test/check
- [ ] Human test: Open a committed card → Card settings → Git: pick "Excluded (this checkout only)", confirm with "Also untrack" ticked — the row reads "Kept out of git on this machine only", the Git tab shows the card as a staged deletion and no longer as a change, and Cancel on the prompt leaves the select on "Tracked"

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
