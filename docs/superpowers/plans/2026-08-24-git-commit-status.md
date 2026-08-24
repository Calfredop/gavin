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
2. **The status is only visible inside the Git tab.** The sidebar's workspace
   git chip -- the one place a workspace's repos are summarised from
   anywhere -- says nothing about a commit in flight.

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

- [ ] `adopt_session` in `session.rs` (+ registration, + a fake-daemon test)
- [ ] `backend.adoptSession`
- [ ] `GitViewPrefs.agentCommit` in `workspace.ts` and `config.rs`
- [ ] `gitState`: persist on launch, clear on every resolution, split the
      post-launch half into `watchAgentCommit`, add `adoptAgentCommits`
- [ ] call the sweep from `+page.svelte` after `bootstrap()`
- [ ] `workspaceGitSummary` gains `committing`; `showGitChip` shared by
      `hasRecap` and the template; the sidebar chip spins
- [ ] unit tests either side, and smoke items for the reload path
