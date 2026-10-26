# The Workspace log is recorded as it happens, not derived

Activity is read from records that already exist and keeps nothing of its own, and the obvious way to build a log of a workspace was the same: assemble it at read time from the card files, `card_runs`, the orchestration tables and git. But most of what the log is for leaves no record to read. A deleted card is gone. Archiving is a file move. `orch_rails` has no created, started or paused time, and its run state is overwritten. A decision's answer carries a date and no time. And a workspace may gitignore `.gavin-root`, so git cannot be asked either.

We decided that the daemon keeps the **Workspace log** as a table of its own in `kanban.sqlite`, written as things happen. Card entries come from the `.gavin*` watcher diffing each workspace's cards against a last-known snapshot, so a card changed by the app, an MCP call, an agent writing the file or an editor is logged the same way. Rail and scheduled-task entries come from the daemon code that performs them. Git entries come from new reflog lines the daemon reads when its `.git` watcher wakes, plus a host-reported entry for a branch deletion, which leaves no reflog line.

## Consequences

- The log starts empty on the day it ships. The one exception is card runs: `card_runs` is copied in once, when the table is first opened, and from then on runs are written like every other entry.
- The log is kept until someone clears it with "Clear older than…". Clearing deletes log rows only, never `card_runs` or anything else the log was copied from.
- The snapshot is diffed once at startup too, so a change made while the daemon was down is logged when it is noticed, stamped with that time and marked as noticed on start.
- Entries record what happened and to which card or rail, not who did it. The watcher cannot tell who wrote a file.

## Considered options

- **Derive the log at read time, as Activity does.** Rejected. Deletes, archives, rail transitions and answer times would be missing, and those are most of the log.
- **Log only from daemon request handlers.** Rejected. It misses every card an agent or an editor writes directly, which is most of them.
- **Record git actions as the Git tab performs them.** Rejected. Agents commit in their own terminals, and the reflog sees those too.
