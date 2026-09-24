---
order: 18432
title: "Human tests and finalization: what is left that only you can do"
status: To Do
priority: high
---
**Rewritten 2026-09-22 by a board audit. Section 1 is gone: it is all done.**

The version of this card written earlier that day listed six rails to start and
four branches to land. Every one of them has since landed. Measured, not
assumed:

- `git status --short` in the root checkout returns **nothing**.
- `git branch --merged main` lists **all fourteen** branches, and
  `git rev-list --count main..<branch>` is **0** for every one of them —
  `fix/agent-fixes`, `integration/landing`, the four `typesafe/*`, the four
  `win/*`, `feat/ssh-support`, `feat/remote-access-phase-2`,
  `fix/rail-attachments-worktree`, `main-dev-rail`.
- So "press Start on the agent-fixes rail", "press Start on the land-the-branches
  rail", "fast-forward `main` when that rail holds green" and "merge
  `feat/ssh-support` into `main` afterwards" are all satisfied. The rails that
  did that work have been replaced; see the Orchestration tab.
- The **installer has been run end to end and it worked**: the app is installed
  at `%LOCALAPPDATA%\Programs\Gavin`, the state directory
  `%LOCALAPPDATA%\gavin` holds zero `.exe` files and its databases, token and log
  are intact, and both `Gavin.exe` and `gavin-daemon.exe` are running from the
  new location with the Start-menu and Desktop shortcuts retargeted. The
  evidence is written onto
  [fix-windows-installer-collides-with-the-daemon](./fix-windows-installer-collides-with-the-daemon.md).
- **"Rebuild and reinstall the stable app before any desktop item"** is also
  satisfied: the installed binaries were built at 22:59–23:02, after the
  `win/installer-state-dir` merge (21:59) and after `95871081` (22:48).

## 0. Do this first — it is breaking every agent session right now

- [ ] **Re-run "Set up / update" for each workspace's agents.** The repo's
      `.mcp.json` still names `%LOCALAPPDATA%\gavin\gavin-mcp.exe`, which the
      installer move deleted, so every agent session in this repo opens with
      `gavin (CONNECTION_CLOSED)` and no `gavin_*` tools at all. The working
      binary is `%LOCALAPPDATA%\Programs\Gavin\gavin-mcp.exe`. This is the last
      box of the installer card and, merged into it, the old windows-port §1
      wizard line — one button press closes both.
      Be aware it re-breaks the Mac, because `.mcp.json` is committed and carries
      one absolute path. The lasting fix is
      [fix-mcp-json-…](./fix-mcp-json-points-at-the-windows-gavin-mcp-on-the-mac.md),
      now `urgent`, and it is on a rail.

## 1. Human tests — Windows, this machine

- [ ] [The Windows desktop pass](./windows-desktop-pass.md) — nine rendered
      checks in the running app, split out of the windows-port umbrella card on
      2026-09-22 after an audit confirmed each one owner-only. Every item carries
      its own static pre-flight, so a failure is a surprise rather than a
      re-derivation. The umbrella card itself is now Done and filed.
- [ ] A second Windows account brings up its own daemon — windows-port §4. The
      pipe naming and the DACL are proved against the running machine; the
      account is not, and creating a Windows user is yours.
- [ ] `npm i -g @openai/codex @google/gemini-cli opencode-ai`, then launch each
      profile from a card. **Only after** the npm-shim fix has landed — it is an
      argument-injection bug on exactly these CLIs
      ([fix-npm-cli-shims-…](./fix-npm-cli-shims-are-run-through-cmd-exe-on-windows.md),
      on a rail).
- [ ] On the other Windows machine: `Get-Process gavin-daemon | Select Path,
      StartTime` against the app's install time — the one box left on
      [fix-daemon-git-spawns-open-windows-without-a-console](./archive/fix-daemon-git-spawns-open-windows-without-a-console.md),
      archived with its fix on `main`. A daemon older than the app explains the
      console windows; Restart daemon in Settings ends it.

## 2. Human tests — other machines

- [ ] [Verify ssh workspaces from macOS against a Linux host and a Windows host](./verify-from-macos-against-a-linux-host-and-a-windows-host-fold-what-breaks-back-into-the-spec.md).
      Needs the ssh rail to have finished its remaining work first. Record what
      broke on that card, file a card per bug, fold the rules into the spec.
- [ ] [feat-linux-port-on-a-linux-machine](./feat-linux-port-on-a-linux-machine.md)
      — the whole card, sixteen items, on a Linux box with a desktop session.
- [ ] The TypeSafe surfaces, now that `main` carries them: each archived
      `typesafe-*` card ends with a pre-flight of the surface it adds (the
      Settings sections, the Run Changes hint, the commit's card line, the
      settings-search fallback). Look at each once with a key configured.

## 3. Board housekeeping

- [x] Archive the three ssh task cards that were sitting on Done only because
      their code was not on `main` yet (`frontend-ssh-workspaces`,
      `card-runs-on-ssh-workspaces…`, `git-tab-and-files-tab-over-ssh`). The
      condition is met — `feat/ssh-support` is merged — so the audit archived
      them.
- [ ] Nine other Done cards are still on the board and their work is all on
      `main`: `fix-gh-pipelines`, `readme-hub-mockups`,
      `readme-placeholder-screenshot`, `typesafe-experiments`,
      `typesafe-experiments-round-2`, `typesafe-turn-verdict`,
      `ui-orchestration-view-mode`, `ui-settings-improv`,
      `ux-next-requiring-attention`. The reset convention says a Done card whose
      work is on `main` goes to `plans/archive/`. Left for you because archiving
      is an explicit action and nothing recorded a decision about these nine.
- [ ] Adopt or discard the four memory notes on the board (`app tests kill the
      daemon`, `codesign entitlements`, `Enter is CR`, `serde rename_all`):
      "Adopt into CLAUDE.md" from each card's detail, or archive them.

## 4. Then

- [ ] The **remote access phase 2** rail arms itself when the decisions-tab rail
      finishes — they both bump `PROTOCOL_VERSION`, and two branches claiming 42
      at once is a merge conflict for no gain. Nothing to press; the chain is a
      `Start rail` step. If you want it sooner, start it by hand and expect the
      renumber.
