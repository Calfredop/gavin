---
kind: task
title: [feat] Files tree lens: touched by this session
parent: feat-file-explorer-integration.md
---
Give the Files hub tab a lens that filters the tree to the files one session touched.

Depends on both of its siblings: the Files tab has to exist, and the per-session baseline rule has to be settled in `runChanges.ts`. Do not start this before both have landed.

A picker at the head of the tree lists the workspace's live sessions; choosing one filters the tree to the paths that session's Changes view would list, with each row showing its +/− counts. Choosing "All files" returns the tree to the whole root.

Two things to get right:

- The lens **reuses** the baseline rule, it does not re-derive one. Whatever `runChanges.ts` decides for a session — run baseline, or uncommitted in the checkout — is what this tree shows, so the lens and the tab chip can never disagree about what a session touched.
- A session whose checkout is not under this workspace's root filters to nothing, and says that in words rather than showing an empty tree.

Fetch on demand only: when the lens is chosen, and on Refresh. No timer and no watcher — a fleet of agents is a fleet of checkouts, and the Changes store made this decision already.

Verify: `cd app && npm test && npm run check && npm run build`.
