# A Scheduled task is a copy of a card, not the card itself

The first idea for scheduling was to give a task card a `schedule:` and let it run from where it sat, or move it into `plans/scheduled/` beside `done/` and `archive/`. Either way the card being scheduled would be the card on the board. But everything on the board assumes a card finishes: an agent moves it to In Progress, then to Done, and Done files it under `plans/done/`. A card that comes back every hour fights each of those, and every run would have to be told not to move its own card, and the daemon would have to refuse the move when it was told anyway.

We decided that scheduling a task makes a **Scheduled task**: a copy of the card's body and run settings, written as its own file under `.gavin-root/scheduled/`, outside `plans/`, so the board and the tree never see it. The original card stays where it was, in whatever column, done or archived, and the copy remembers it only as a `from:` link for display. Neither follows the other's edits.

## Consequences

- A Scheduled task has no status. Each run is recorded in `kanban.sqlite` (fire count, last fire, the claim that keeps two apps from firing it twice) and leaves a **Run report** under `.gavin-root/scheduled/runs/`, gitignored.
- The same card can be scheduled more than once, with different schedules or agents, and a Scheduled task can be duplicated or deleted without touching any card.
- An improvement made to the original card later does not reach the copy. Re-scheduling the card is how to pick it up.
- Only task cards can be copied for now. A plan's checklist ends fully ticked after one run, and what a repeated plan run should do with it is undecided.

## Considered options

- **Schedule the card in place, with a `schedule:` field.** Rejected. The board would have to hide or explain a card that keeps reopening, and every status write by its runs would have to be refused.
- **Move the card into `plans/scheduled/`.** Rejected. It takes the card off the board the human was tracking it on, and moving it out of `archive/` changes what was archived.
- **Keep scheduled work only in SQLite.** Rejected. A scheduled prompt is work like any card, and it should be committed, reviewable and editable by an agent like one.
