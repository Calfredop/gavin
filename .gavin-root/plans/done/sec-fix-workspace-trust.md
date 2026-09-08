---
title: [sec] workspace trust for repo-shipped config.toml execution keys
status: Done
priority: high
complexity: complex
---
**Severity:** High. Finding **R3** in `docs/security/README.md` (sources AS-02 in `02-app-surface.md`; AG-05, AG-06 in `03-agent-surface.md`). The report lives on branch `sec/review-2026090801` until merged.

**The problem.** `.gavin-root/config.toml` ships with the repo, and two of its keys name things gavin executes as the user. `[agent] command` becomes the launch shell command for Run and every rail step, above the profile table, with no confirmation naming it — and its first token is run by the host as a `Command::new` the moment the Home or Settings tab renders (`superpowers.rs:312-317`, `:245`), no click at all. `[worktree] setup` lines are `&&`-chained ahead of the agent when a worktree is cut; the fork dialog shows the line but not that the repo wrote it. AD-6 trusts the human's own config and names a freshly cloned repo's copy as not accepted; today both share one code path with no provenance.

**The fix.** A workspace-trust marker, on the app side (no protocol change):

- [x] A per-workspace `trustedConfigHash` in `config.json` (the app's store, rides on `WorkspacesData` like `removedWorkspaces` — check every save site carries it). It is the hash of the execution keys (`[agent] command`, `[agent] file`, `[worktree] setup`) the human has blessed.
- [x] `resolveAgentConfig` (`settings.ts`) and `worktreeSetup.ts` treat those keys as inert when the hash does not match: the profile's own command runs, no setup line is chained, and the UI says why ("this repo's config names a command you have not approved") with a button that shows the values and approves them.
- [x] `superpowers_status` and any other passive probe never execute a repo-supplied binary: probe the profile's command only, or the approved one.
- [x] Writing the keys through gavin's own Settings/init wizard updates the hash in the same save, so the human's own edits never trip the gate.
- [x] Tests in the pure modules for: fresh clone (inert + notice), approved (runs), edited after approval (inert again), wizard-written (approved).

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
