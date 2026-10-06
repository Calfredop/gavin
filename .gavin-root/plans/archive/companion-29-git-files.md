---
order: 28672
kind: task
title: Companion 29: Git and files on the phone
status: Done
labels: ready-for-agent
parent: companion.md
complexity: complex
---
Blocked by: companion-23-served-signed-ui.md

Part of `companion.md`. Read the spec (section "The Workstation UI bundle") first.

## What to build

In the bundle, made responsive:

- the Git tab: status, diffs, commit, branches, merge, push;
- files: browse, read, edit.

Extend the Demo Workstation to match.

## Acceptance criteria

- [x] Seam 2 tests for the Git and file actions' channel traffic
- [x] The desktop Git and file suites still pass

When done, file a human test: commit and push from the phone, and edit a file from the phone.

## Plan

Design, held to the spec's "The Workstation UI bundle" and to what companion-09 did for the board: the phone surfaces live in the bundle (`src/companion/surfaces/`) as thin templates over pure modules, composed from the desktop's own Git and file state (`gitState.ts`, `fileTree.ts`, `fileEditing.ts`) and the desktop components that carry no desk layout (`GitCommitBox`, `GitFileRow`, `GitDiffUnified`, `GitOpBar`, `FileEditor`). `GitHubView` and `FilesHubView` themselves stay desk-only: their splitters, section folds and diff-layout switch all save through `setGitViewPrefs`, which is the layout save the Companion never sends. Where a reused desktop component is wrong for a thumb, it becomes responsive where it lives (`pointer: coarse` / `hover: none`), which leaves the desk untouched.

- [x] View state: a workspace opens on Board, Git or Files; the surface is remembered on the Device; a tab strip under the header
- [x] Desktop components responsive where they live: `GitFileRow` (actions shown and thumb-sized without hover), `GitCommitBox` and `CodeMirrorView` (16px fields, so iOS does not zoom), `FileEditor` (thumb-sized mode switch; no "Open externally" where the host cannot), `GitDiffUnified` and `MarkdownToolbar` at a phone's width
- [x] Git surface (`phoneGit.ts` + `PhoneGit.svelte`): branch and sync bar (fetch, pull, push with ahead/behind), the op bar, error and merge-in-progress banners; Changes (unstaged/staged, stage and unstage, tap for the diff, commit box); Branches (checkout, merge with a confirm, new branch, remote branches)
- [x] Files surface (`phoneFiles.ts` + `PhoneFiles.svelte`): folders one at a time with a path strip, open a file in the desktop's editor to read or edit, a note for what the phone cannot show
- [x] Demo Workstation: a repository per rooted workspace (files, index, commits, branches, an origin) answering the Git commands, and the file commands over the same files; a write emits `file-changed` and `git-changed` and shows in the Git status
- [x] Seam 2: the Git actions' traffic (status, diff, stage, commit, push with progress, checkout, new branch, merge) and the file actions' (list, read, write, watch) against the demo; nothing layout-saving or desk-only sent, nothing unanswered; source guards on the two surfaces
- [x] Desktop Git and file suites, `npm test`, `npm run check`; companion test, check, build
- [x] README; human test filed
- [ ] Human test: On a phone with a debug Companion paired to the dev Workstation (desktop app running under tauri dev, remote access on), open a workspace with a git repo: on Files, open a text file, tap Edit, change a line, and check the change is in that file at the desk; then on Git, stage that file, type a summary (the page must not zoom when the field takes focus), tap Commit, then Push, and check the op bar shows the push's progress, the Push count clears, and the commit is on the remote.

## Outcome

Uncommitted on `companion/surfaces-b` (worktree `.gavin-worktrees/companion-surfaces-b`). `app/companion/README.md`, "What is here, and what is not", has the design.

- **Surfaces.** An open workspace has a strip, Board / Git / Files (`SurfaceTabs`); the Companion's view remembers the surface and where Files was, on the Device (`viewState.ts`: `showSurface`, `placeFiles`). **Git** (`PhoneGit*.svelte` over `phoneGit.ts`): branch and standing, Fetch/Pull/Push with counts, the desk's op bar, error and in-progress banners; Changes (stage, unstage, a diff as its own page, the desk's commit box) and Branches (switch, merge after a question, new branch, remote-only checkout). Every action is the desk's `gitState.ts`; the desk's `GitHubView` is not reused because its columns, folds, diff layout and worktree choice save through `setGitViewPrefs` (the desk's layout), so the phone always reads the workspace root. **Files** (`PhoneFiles.svelte` over `phoneFiles.ts`): a folder at a time over the desk's `fileTree.ts`, a file in the desk's `FileEditor` (`canOpenExternally={false}`); an image or binary says it can't be shown. No create/rename/trash.
- **Desktop components, responsive where they live** (media queries a mouse window never matches): `GitFileRow`, `GitCommitBox`, `CodeMirrorView`, `FileEditor` (`pointer: coarse` / `hover: none`); `GitDiffUnified`, `MarkdownToolbar` (`max-width: 600px`). `FileEditor` gains `canOpenExternally` (default true).
- **Demo Workstation.** `sampleProjects.ts` (both projects' files and histories), `repo.ts` (status, diffs, staging, commit/amend, checkout incl. remote tracking, new branch, merge with fast-forward and merge commit, push/fetch/pull; git's refusals; a conflicting merge is refused whole), `lineDiff.ts`, `gitCommands.ts`, `fileCommands.ts` (the host's fences and `VIEWABLE_EXTENSIONS`), `watches.ts` (`file-changed`/`git-changed` only to what is watched, refcounted). `get_git_baselines` now answers the sidebar chip. A save in Files is a change in Git.
- **Trap found:** `gitState.ts` names every op with `crypto.randomUUID`, which exists only in a secure context; the iOS shell serves at `gavin-bundle://`. `remote/randomUUID.ts` polyfills it from `getRandomValues` in the bundle's layout.
- **Proof.** Companion vitest 433 (new: `seam/gitActions` 21, `seam/fileActions` 14 — each action's wire traffic, op ids, progress, refusals in git's words, and everything sent checked against `protocol::remote_command_table` read from source; `demo/repo` 31, `lineDiff` 9, `projectCommands` 10, `phoneGit` 24, `phoneFiles` 12, source guards); companion check 0 errors, build ok. Desktop: git/files/hub/review suites 1270 pass; full `npm test` 7357 pass, 2 fail — `remoteAccessSurfaces` "forwards the three device pushes" and the `mainThreadCommands` forwarding.rs:376 guard — both fail identically at the base 3eb6b084 in a detached worktree; `npm run check` 0 errors; build ok. Shell: `npm ci`, test 241 pass, build ok; check has 1 error in `bundle.e2e.ts:182` (untouched here, last changed a528f161). No Rust changed, so no cargo run. Driven in Chrome at phone width against the page's own demo: stage, commit, push, merge, Files browse, Edit + autosave showing up in Git; no console errors.
- **Not here.** Line/hunk staging and discard on the phone (the desk's diff is drawn read-only); stashes, remotes, history graph; conflict resolution beyond keep-ours/take-theirs and mark-resolved; file create/rename/trash.
