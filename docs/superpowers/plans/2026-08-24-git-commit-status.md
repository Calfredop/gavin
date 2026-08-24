# Git tab: a commit-via-agent run that outlives the window

Follow-up to the "Commit via agent" card. That run is a HIDDEN session: the
daemon owns it, and the only trace it leaves in the app is
`gitStore[ws].agentCommit`, which is in-memory. Two consequences the card
("Commit status") names:

1. **A reload orphans the run.** The daemon keeps committing; the Git tab
   comes back showing an idle "Commit via agent" button, and pressing it
   starts a *second* agent on the same working tree. Bootstrap cannot help:
   `resolve_sessions` only reconciles ids referenced by a page, and a hidden
   run is referenced by none.
2. **The status is only visible inside the Git tab**, and only in the corner
   of its toolbar. Neither of the two places that speak for a tab from
   outside it -- the hub's own Git tab in the tab strip, and the sidebar's
   workspace git chip -- says anything about a commit in flight, so a human
   on Kanban or PRD has no way to know one is running.

## Decisions

**Persist the run in `GitViewPrefs`, not in a heuristic.** `ListSessions`
carries no session name, so "a running session in this cwd that no page
references" is the only inference available, and it would adopt any future
hidden run as a commit. The app knows the id at launch; writing it down is
exact. `{ sessionId, cwd }` -- the cwd, because a worktree switch during a
run already abandons it, and `gitView.worktree` will have moved on.

**Adopt at bootstrap, not on Git-tab mount.** The sidebar chip has to show
the run for a workspace whose Git tab was never opened this session, so the
sweep runs once after `bootstrap()` and seeds `gitStore` itself.

**One new Tauri command, `adopt_session(id) -> bool`.** It answers the
frontend's actual question -- "is this still running, and am I now attached
to it?" -- rather than exposing a session list the app has no other use for.
`ListSessions` and `Attach` are both v1 requests, so no protocol bump and no
`FEATURE_MIN_VERSION` entry: nothing here widens a request payload.

**A run that ended unwitnessed is cleared, not judged.** Its exit code and
output are gone. Saying "Committed" would be a guess and saying "failed"
would be a lie; the pref is dropped and the refresh shows whatever commits
exist.

## Steps

- [x] `adopt_session` in `session.rs` (+ registration, + a fake-daemon test)
- [x] `backend.adoptSession`
- [x] `GitViewPrefs.agentCommit` in `workspace.ts` and `config.rs`
- [x] `gitState`: persist on launch, clear on every resolution, split the
      post-launch half into `watchAgentCommit`, add `adoptAgentCommits`
- [x] call the sweep from `+page.svelte` after `bootstrap()`
- [x] `workspaceGitSummary` gains `committing`; `showGitChip` shared by
      `hasRecap` and the template; the sidebar chip spins
- [x] `hubViewBusy` in `hubViewMeta.ts`; the hub's Git tab spins in place of
      its branch icon, from whichever tab is on screen
- [x] unit tests either side, and smoke items for the reload path

## Landed differently than planned

The clear-the-record step is guarded by session id (`forgetAgentCommit`),
not unconditional. An abandoned run resolves long after the worktree switch
that abandoned it, and by then a second run may be the one on record --
clearing blind would erase the run still going.
