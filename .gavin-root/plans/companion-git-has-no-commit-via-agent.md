---
order: 16384
kind: task
title: Companion Git: there is no "Commit via agent" on the phone
status: To Do
priority: medium
complexity: complex
---
Found by `companion-iphone-smoke-tests.md` (B10), on a physical iPhone 16 Pro, and requested by the owner.

**The gap.** The desktop's Git tab has "Commit via agent": one button that runs the `builtin:commit` prompt in a HIDDEN headless agent session, which decides what to stage and writes the commit (`commitViaAgent` in `app/src/lib/git/gitState.ts`, the button, its `Committing…` state, elapsed time, `Show the agent` and `Stop the commit agent` in `GitToolbar.svelte`, the PRD's "commit via a hidden agent run"). The phone's Git surface (`app/companion/src/companion/surfaces/PhoneGit*.svelte` over `phoneGit.ts`) has Fetch, Pull and Push, Changes (stage, unstage, diff, the commit box with Amend) and Branches, but no agent commit. Measured on the Demo: the Git screen's controls are `Refresh, Fetch, Pull, Push, Changes, Branches, Stage all, +, Unstage all, −, Amend, Commit (n)`. A person on the phone with 17 changed files has to stage and write a message by thumb.

**Why it is not a one-line port.**
- `commitViaAgent` records itself with `setGitViewPrefs(workspaceId, { agentCommit })` (`rememberAgentCommit`, so a restart can adopt the run). The bundle README is explicit that `setGitViewPrefs` is the desk's layout and the phone never calls it; it is refused before the wire, and the Remote role table in the daemon would refuse it anyway (`seam/layoutSaving.test.ts`).
- It starts with the launch wall: `holdOrQueue({ kind: "commit", ... })` queues into a queue only the desk's window drains. `CardLaunchHost` for card runs already handles this for the phone: "the launch wall refuses rather than queueing into a queue only the desk's window drains".
- It resolves the workspace's agent and headless args from desk stores, creates a hidden session (`backend.createSession`, then `setSessionName("commit")`), and watches it to a verdict (exit code and working tree) in `watchAgentCommit`, retrying a transient failure once.

**Options.**
- A. The phone only ARMS it, like rails ("Start arms; the desk runs"): a new forwarded command that tells the desk window that runs the workspace to call `commitViaAgent`, and the phone shows the run's state from the same Git view state the desk already pushes. Safest, but needs the desk window open (the same dependency rails have).
- B. Run it from the phone with a phone-side host: own the launch-wall refusal like `CardLaunchHost`, keep the run record in a store the Remote role may write, and let a restart adopt it. More work, works with the desk app closed only if the daemon (not a desk window) owns the watch.

**To do.** Choose A or B (a Decision is the owner's), add the button to `PhoneGit.svelte` with the desk's states (`Committing…`, elapsed, `Show the agent` opening the session in the phone's terminal, `Stop`), reuse `agentCommitPhase`/`agentCommitBlocker` from `gitState.ts` for the disabled states and their reasons, add the new command to the Remote role table and the seam test that reads it (`testing/remoteTable.ts`), and cover it against the Demo Workstation (the Demo needs a scripted headless commit agent).

**Acceptance.**
- [ ] A `Commit via agent` button on the phone's Git screen runs the commit at the Workstation and the Changes list empties
- [ ] While it runs the phone shows `Committing…` with the elapsed time, can open the agent's session, and can stop it
- [ ] With no headless agent the button says why and is disabled, as at the desk
- [ ] The launch wall's refusal is said on the phone, not queued invisibly
- [ ] The Remote role table and `seam/layoutSaving.test.ts` still hold: no layout-saving command
- [ ] Human test: with changes in a real workspace, tap the button on the phone; the desk shows the same run and the commit lands
- [ ] Decision: How should the phone's "Commit via agent" run: the phone arms it and the desk window runs it (needs the desk app open, like rails), or the phone runs it itself through the daemon?
  Options: A) A) Phone arms it, the desk window runs it (like rails) B) B) Phone runs it itself, adopted by the daemon so it works with the desk closed
