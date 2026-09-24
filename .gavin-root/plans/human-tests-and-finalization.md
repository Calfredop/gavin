---
order: 18432
title: Human tests and finalization: close the Windows port, land the branches, ready phase 2
status: To Do
priority: high
---
The board was reset on 2026-09-22: every Done card whose work is on `main` went to `plans/archive/`, the stale In Progress marks came off, and what is left was arranged into six rails. This card is the index of what is yours, in the order it has to happen. Each line names the card or rail that holds the detail; tick here only when the thing is really done.

## 1. Finalization — get the code onto `main`

- [ ] **windows installer** rail: press Resume. Its Commit changes step commits the installer-hooks work sitting uncommitted in `gavin-win-installer-state-dir` (six modified files plus the new `app/src-tauri/nsis/`). It then holds at "install end to end", which is §2's first item.
- [ ] **agent fixes** rail: press Start. One worktree (`gavin-agent-fixes`, branch `fix/agent-fixes`), five cards in sequence — `gavin::tests` 10 red, the four Rust baseline reds, the npm-shim argument bug, the `tauri dev` sidecar lock, the `gavin-mcp` re-exec — then tests, a commit, and a merge onto `integration/landing`. The first card will ask you a question on its tab (the Windows rename refusal: `cfg(unix)` the two tests, or one recursive watch on Windows); answer it there.
- [ ] **land the branches** rail: press Start. It merges the four TypeSafe branches (`typesafe/turn-verdict`, `typesafe/change-attribution`, `typesafe/commit-card-link`, `typesafe/settings-search` — their cards are Done and already archived, their code is 7–15 commits ahead of `main` and was on no rail) into `integration/landing`, runs the app suites, and holds for your look. Each is clean against `main`; `settings-search` conflicts with two of the others (`turnVerdictDriver.test.ts`, `GlobalSettingsView.svelte`), which is why it merges last and an agent resolves it.
- [ ] Fast-forward `main` when that rail holds green: from the root checkout, `git merge --ff-only integration/landing` (a plain merge if `main` has moved meanwhile). Refresh the checkout to LF afterwards (the CLAUDE.md recipe). The four `typesafe-*` worktrees can go once you no longer need them.
- [ ] **ssh support** rail: press Resume. It brings `main` in first (`app/src-tauri/src/agent_setup.rs` conflicts; an agent resolves it), then the agent finishes [network sync, the watcher, conflicts and tree mutations over ssh](./ssh-git-sync-and-conflicts.md), runs the checks, commits, and holds for §3's verification. Merging `feat/ssh-support` into `main` afterwards is yours: it carries protocol v39–v40, so it needs a rebuild and a daemon restart, and every running `gavin-mcp` fails closed until it is rebuilt too.
- [ ] Rebuild and reinstall the stable app before any desktop item below — the running install predates the merged Windows fixes. Quit gavin first: the installer stops the daemon every agent tab is a child of. Build with `scripts\build-windows-installer.ps1` (from the installer worktree, or from `main` once that branch is in), then run the setup from a plain terminal.

## 2. Human tests — Windows, this machine

- [ ] The installer end to end: [fix-windows-installer-collides-with-the-daemon](./fix-windows-installer-collides-with-the-daemon.md), last box. Expect the daemon prompt, `%LOCALAPPDATA%\Programs\Gavin` as the default, the old binaries gone from `%LOCALAPPDATA%\gavin` with the databases, token and log untouched. Re-run "Set up / update" for each workspace's agents afterwards, then file the card Done.
- [ ] [feat-windows-port-on-a-windows-machine](./feat-windows-port-on-a-windows-machine.md): §1's wizard line and all nine of §3. Each item carries its static pre-flight, and the card says an agent must not tick them. File the card Done when they are.
- [ ] A second Windows account brings up its own daemon (windows port §4 — the pipe naming and the DACL are proved; the account is not).
- [ ] `npm i -g @openai/codex @google/gemini-cli opencode-ai` — only after the npm-shim fix has landed, since it is an argument-injection bug on exactly these CLIs — then launch each profile from a card.
- [ ] On the other Windows machine: `Get-Process gavin-daemon | Select Path, StartTime` against the app's install time — the one box left on [fix-daemon-git-spawns-open-windows-without-a-console](./archive/fix-daemon-git-spawns-open-windows-without-a-console.md), archived with its fix on `main`. A daemon older than the app explains the console windows; Restart daemon in Settings ends it.

## 3. Human tests — other machines

- [ ] [Verify ssh workspaces from macOS against a Linux host and a Windows host](./verify-from-macos-against-a-linux-host-and-a-windows-host-fold-what-breaks-back-into-the-spec.md) — once the ssh rail holds. Record what broke on that card, file a card per bug, fold the rules into the spec.
- [ ] [feat-linux-port-on-a-linux-machine](./feat-linux-port-on-a-linux-machine.md) — the whole card, sixteen items, on a Linux box with a desktop session.
- [ ] The TypeSafe surfaces once `main` carries them: each archived `typesafe-*` card ends with a pre-flight of the surface it adds (the Settings sections, the Run Changes hint, the commit's card line, the settings-search fallback). Look at each once with a key configured.

## 4. Then

- [ ] Archive the three ssh task cards still on Done (`frontend-ssh-workspaces`, `card-runs-on-ssh-workspaces…`, `git-tab-and-files-tab-over-ssh`) once `feat/ssh-support` is on `main`. They stayed on the board only because their code is not there yet.
- [ ] Adopt or discard the three memory notes on the board (`codesign`, `Enter is CR`, `serde rename_all`): "Adopt into CLAUDE.md" from each card's detail, or archive them.
- [ ] Arm the **remote access phase 2** rail. It is cut and bound (`gavin-feat-remote-access-phase-2`, branch `feat/remote-access-phase-2`), starts by bringing `main` in, and is the next feature after the tests above — [feat-remote-access-phase-2](./feat-remote-access-phase-2.md).
