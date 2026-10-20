---
order: 54272
kind: task
title: "[sec] An ssh host's card tree can name a LOCAL file as a card, which the desktop reads from its own disk and sends back to the host inside the agent prompt"
status: Done
priority: low
complexity: moderate
labels: security, ready-for-agent
---
Fix a needs-validation lead from the 2026-10-15 security audit (run-1). It is not confirmed: the audit traced it in source but could not observe the chain run end to end (host tree, board card, Run, local read, then CreateSession or QueueInput on the link), since the Tauri host and its webview were not built. The failing regression test below is the proof — write it first and watch it fail. If it already passes before any change, the lead is wrong: record why under a dated "## Comments" heading and move the card to Done with no code change. Fingerprint: `ssh-link:remote-tree-card-path-read-on-local-disk:app/src-tauri/src/fileviewer.rs/read_file_for_viewer`.

Full record: `NEEDS-VALIDATION.md` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

For an ssh workspace, the board is built from the GavinTree the host's daemon returns (get_gavin_tree is routed to the link) or pushes (GavinTreeChanged on the link's streaming connection, emitted unfiltered). Each card's id is the plan path the host supplied, and nothing checks that it lies under that ssh workspace's root_path. When the human runs, resumes, re-launches, develops, hands off or opens that card, the desktop reads it with backend.readFileForViewer(card.id). read_file_for_viewer routes to the link only when the path is textually under some ssh root. Any other absolute path is read from the LOCAL disk, gated only by allowed_roots, which admits every open workspace root plus each root's extra_contexts. Up to 1 MiB of the local file's text becomes the card body, goes into the composed prompt, and reaches an agent session created ON THE HOST: inside the launch command (buildRunCommand) or as a queued input for an injection profile.

The pre-launch gates check none of this. sshLaunchBlocker checks only that the link is up and the host daemon's version. The first-Run review (on by default) does show the composed prompt with the local path and contents, which a careful human could catch; with requireReview off for the workspace or the app, nothing is shown. A host-reported status of In Progress also skips the SetPlanFrontmatterField write, which would otherwise go to the LOCAL daemon for the local path.

The same unchecked read happens in the develop launch, the main-agent handoff, Best-of-N, the memory card and the card modal. The relay thread also emits a GavinTreeChanged under whatever workspace_id the host names, so a host can replace the board of a workspace that is not its own.

## Root cause

For an ssh workspace, the desktop routes file reads by the path's text, not by the workspace that supplied the path. Card paths in a tree from a remote daemon are trusted as given, with no check that they lie under that workspace's ssh root_path. A path outside it falls through to the local filesystem under allowed_roots, which spans every open local workspace and does not know which daemon supplied the path.

## The invariant to enforce

A tree that arrives from an ssh link describes only that host's own ssh workspaces, and every path in it (plans, docs, specs, context folders) lies under that workspace's root_path. A tree for a workspace id that is not one of the link's host's ssh workspaces is dropped. A path outside the root is dropped before it can become a card id, so no host-supplied path ever routes to the local disk.

## Trace (lines as of 2026-10-16; re-read before editing)

- `app/src-tauri/src/session.rs:5526` (attach_and_relay, RelayOwner::Remote): A GavinTreeChanged from the link is emitted as gavin-tree-changed with its workspace_id and tree as given. get_gavin_tree (session.rs:7386, routed by route_for_workspace at 7392) returns the host's tree the same way.
- `app/src/lib/core/gavinState.ts:80` (initGavinListeners): Stores the pushed tree as gavinTrees[workspaceId] unchanged.
- `app/src/lib/core/planBoard.ts:119` (cardView): card.id = plan.path, straight from the host's tree.
- `app/src/lib/cards/cardRunActions.ts:315` (sshLaunchBlocker -> sshRunBlocked, sshWorkspace.ts:130): Checks the link and the host daemon version only.
- `app/src/lib/cards/cardRunActions.ts:788` (launchCard): Reads the card with backend.readFileForViewer(card.id). The same read sits in developCard (472), the main-agent handoff (1103), bestOfNActions.ts:119, memoryCard.ts:274 and CardDetailModal.svelte:179.
- `app/src-tauri/src/fileviewer.rs:191` (read_file_for_viewer_blocking): route_for_path (remote.rs:1359) -> host_for_path (remote.rs:1306) matches only textual prefixes of ssh roots, so a local path gives Route::Local.
- `app/src-tauri/src/fileviewer.rs:200` (read_file_for_viewer_blocking): allowed_roots (fileviewer.rs:86) admits any path under any open workspace root or extra_context, and read_file_for_viewer_impl (219) reads up to 1 MiB from the local disk.
- `app/src/lib/cards/cardRunActions.ts:905` (launchCard): composePrompt places the body in the prompt; createSession (956) puts it in the launch command, or queueInput (971) sends it for an injection profile.
- `app/src-tauri/src/session.rs:6354` (create_session): route_for_root (6372) gives Route::Remote for the ssh workspace, the command carrying the local file's text goes to the host daemon, and remember_session (6386) records the session as the host's.
- `app/src/lib/cards/cardRun.ts:619` (runStatusNeeded): A host tree reporting In Progress skips the status write.

## What the audit could not observe

- The end-to-end chain is traced in source only; the Tauri host and launchCard (TypeScript under vitest) were not run.
- The attacker controls the daemon on an ssh host the human linked, and must name a file inside an open LOCAL workspace root or extra_context. The desktop sends local roots to a link in none of the reviewed requests, so the path has to be guessed, for example from a shared username and repository layout.
- A human must click Run, Resume, New session, Develop or the main-agent handoff on that card, and with review on (the default) must also approve a sheet that shows the local path and contents.

## Fix

Confine a link's tree once, where it enters the desktop, in app/src-tauri/src/session.rs. Add a pure helper, for example `fn confine_host_tree(workspaces: &[Workspace], host: &str, workspace_id: &str, tree: GavinTree) -> Option<GavinTree>`. It returns None when workspace_id is not an ssh workspace on `host`. Otherwise it keeps only the contexts whose folder_path, and the plans, docs and specs whose path, satisfy remote::path_is_under(root_path, path). Apply it in attach_and_relay's GavinTreeChanged arm when the owner is RelayOwner::Remote (skip the emit on None), and in get_gavin_tree when the route is Remote (an error on None). Every reader of card.id then sees only paths that route back to the same link. A host's extra context outside its root loses nothing that works today: host_for_path already routes such a path to the local disk, so it was never read through the link.

Regression tests, in session.rs's test module:

- `a_hosts_tree_drops_a_card_outside_its_root`: an ssh workspace rooted at `/srv/repo` on host `h`, a tree with plans at `/srv/repo/.gavin-root/plans/a.md` and `/Users/me/local-ws/secret.md`; the confined tree keeps only the first.
- `a_hosts_tree_for_another_workspace_is_dropped`: a tree pushed by host `h` naming a local workspace's id, or another host's, returns None.
- `a_hosts_tree_with_a_sibling_prefix_is_dropped`: `/srv/repo2/x.md` is not under `/srv/repo`.

Optionally, as a second line, a vitest beside cardRunActions.test.ts: a card of an ssh workspace whose id is outside its root is refused before readFileForViewer is called.

## Done when

- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests in the touched crate or module, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched.
- The regression test fails before the change and passes after it.
- Follow the CLAUDE.md traps that apply: a new SQLite column needs its own `ALTER TABLE`, a widened request needs a compat-gate entry, and you commit only your own files.
