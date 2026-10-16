---
kind: task
title: "[sec] With require_local_token on, an untokened same-user connection can still type into any session, read its screen, read files under any root it names and store replayable launches, so it can borrow Gavin's macOS TCC grants"
status: To Do
priority: medium
complexity: complex
labels: security, ready-for-agent
---
Fix a needs-validation lead from the 2026-10-15 security audit (run-1). It is not confirmed: the audit traced it in source but could not observe whether macOS makes Gavin.app the TCC responsible process for gavin-daemon and the shells it forks, nor which grants an installed Gavin holds. The failing regression test below is the proof — write it first and watch it fail. If it already passes before any change, the lead is wrong: record why under a dated "## Comments" heading and move the card to Done with no code change. Fingerprint: `daemon-local-socket:uid-only-peer-auth:tcc-confused-deputy`.

Full record: `NEEDS-VALIDATION.md` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`. REPORT.md §3, priority 5, asks for `is_privileged` to be audited as a whole.

## Relation to `sec-fix-invoke-desktop-remote-only.md`

That card makes InvokeDesktop a Device-only request; leave that one variant to it. Its "Same root cause" section names the wider gap (LinkCardSession, WriteInput, QueueInput, SaveTool, StartToolRun, SetOrchestration, SetRailRun) and asks for the whole list to be audited. This card is that audit. If the InvokeDesktop card has landed first, classify InvokeDesktop here exactly as it decided; if this card lands first, classify it as refused for a narrowed local connection, which is that card's first option.

## What is wrong

Any non-sandboxed process running as the user can connect to daemon[-dev].sock. The only peer check is peer_uid_ok, a uid comparison its own comment calls "defence in depth, not identity". A connection that presents no credential, a wrong one or an unknown session token becomes role local.

The opt-in require_local_token marker is meant to make "you must authenticate to start a shell" true for that role. It withholds the list in is_privileged: CreateSession, RunGit, WriteWorkspaceFile, pairing and the other process-starting requests. It leaves open every other request, including ones with the same reach:

- PTY input: WriteInput, QueueInput, SetQueuedInputs and SendQueuedInput type into any live shell or agent session, which is a shell.
- PTY reads: Attach, Snapshot and SessionScreen return any session's screen and scrollback.
- File reads under a caller-chosen root: ReadWorkspaceFile, ListWorkspaceDir and StatWorkspacePaths. confined() checks containment only against the root the caller names and the extra contexts that root declares, so ~/Documents is reachable.
- Replayable launches and runs: LinkCardSession stores an arbitrary command the human later replays with Re-launch (the audit's verifier observed this); SaveTool and StartToolRun author and start tool runs; SetOrchestration and SetRailRun (and their ByRoot forms, and SetStepRun) configure and drive rails that launch agents.

The Settings hint for the switch promises the narrowed program "cannot start a shell, spawn an agent, stop the daemon, or rewrite the launch command". Typing into an existing shell starts nothing, but it has the same reach, and LinkCardSession does rewrite a launch command.

On macOS this matters beyond same-user reach. The daemon is spawned by Gavin.app with a plain Command::spawn and no responsibility disclaim, launchd job or SMAppService. If macOS attributes the daemon and its PTY children to Gavin.app as their TCC responsible process, a caller with no grants of its own could read ~/Documents, ~/Desktop, ~/Downloads or iCloud Drive, and use any Full Disk Access the human gave Gavin, through the socket. AD-1 accepts same-user reach on the premise that such a process "can already exec a shell, read ~/Library, and edit any repo"; that premise does not hold for TCC-protected locations, and no threat-model entry treats TCC as a same-uid boundary.

## Root cause

is_privileged (crates/daemon/src/server.rs) is a denylist that was written for "starts a process or ends the daemon" and never revisited as requests were added. Requests that reach a shell through an existing PTY, read PTY content, read files under an arbitrary root, or store a launch the human later replays were never classified. Unlike agent_allows, nothing forces a new Request variant to be classified for the narrowed local role.

## The invariant to enforce

With require_local_token on, an untokened local connection may do only what the hint promises: read the board and list sessions. It is refused every request that can start a process, write PTY input, read PTY content, read or list files, or store or start a launch, run, tool or rail. The classification is exhaustive, with no `_` arm, so a new Request variant cannot compile until it is decided for this role.

## Trace (lines as of 2026-10-16; re-read before editing)

- `crates/daemon/src/server.rs:7787` (peer_uid_ok): The only peer authentication on the socket, a uid comparison.
- `crates/daemon/src/server.rs:3956` (resolve_hello): HelloAuth::None, a wrong daemon token or an unknown session token all resolve to ClientIdentity::local().
- `crates/daemon/src/server.rs:7752` (authorize): `Role::Local => !require_local_token || !is_privileged(req)` (7762). require_local_token (7828) reads the marker per request.
- `crates/daemon/src/server.rs:7676` (is_privileged): The denylist. It omits WriteInput, QueueInput, SetQueuedInputs, SendQueuedInput, Attach, Snapshot, SessionScreen, ReadWorkspaceFile, ListWorkspaceDir, StatWorkspacePaths, LinkCardSession, SaveTool, SaveToolByRoot, StartToolRun, SetOrchestration, SetOrchestrationByRoot, SetRailRun, SetRailRunByRoot, SetStepRun and InvokeDesktop, among others.
- `crates/daemon/src/server.rs:6474` (handle_request WriteInput; QueueInput at 6477): Writes caller bytes into an existing PTY. Attach and Snapshot are served at 8365 and 8376; the v68 ownership logic (8319-8362) refuses only Devices.
- `crates/daemon/src/server.rs:6728` (handle_request ReadWorkspaceFile; StatWorkspacePaths at 6736, ListWorkspaceDir at 6759): Act on a caller-supplied root_path through confined() (crates/daemon/src/gavin.rs:3128).
- `crates/daemon/src/server.rs:6814` (handle_request LinkCardSession): Stores the caller's command as the card's replayable launch. StartToolRun is at 6895, SetOrchestration at 6543, SetRailRun at 6546, SaveTool at 6578.
- `crates/daemon/src/server.rs:7318` (agent_allows): The pattern to copy: an exhaustive match whose comment says a new variant cannot be added without a decision.
- `crates/daemon/src/server.rs:9024` (untokened_local_keeps_full_reach_until_the_switch_is_on): The existing test, which checks only CreateSession, Shutdown and ListSessions.
- `app/src/lib/core/GlobalSettingsView.svelte:1727` (Require a token hint): The promise the narrowing has to keep.
- `app/src-tauri/src/daemon.rs:87` (spawn_detached, unix): A plain Command::spawn, so the daemon and its PTY children may carry Gavin.app's TCC responsibility.

## What the audit could not observe

- Whether macOS (14, 15 or 26) makes Gavin.app the TCC responsible process for gavin-daemon and its PTY children, while the app runs and after it quits and the daemon is reparented to launchd.
- Which grants the owner's installed Gavin.app holds (Desktop, Documents, Downloads, iCloud, Full Disk Access). These are installation facts.
- The source half is not in doubt: authorize, is_privileged and the existing unit test fix what the narrowed role may send.

## Fix

Replace the denylist with an exhaustive classification for the narrowed local role, in crates/daemon/src/server.rs.

1. Add `fn narrowed_local_allows(req: &Request) -> bool` as an exhaustive match with no `_` arm, like agent_allows. Allow only reads that touch neither PTY content nor files under a caller-named root (for example GetProtocolVersion, Hello, ListSessions, GetBoard, GetGavinTree, the Get*State reads). Refuse everything that starts a process, writes PTY input, reads PTY content, reads or lists files, or stores or starts a launch, run, tool or rail, including every item in the omitted list above. Decide each remaining variant on that rule and say why in a comment where it is not obvious.
2. authorize uses it: `Role::Local => !require_local_token || narrowed_local_allows(req)`. Keep is_privileged only if something else still needs it.
3. Rewrite the Settings hint (GlobalSettingsView.svelte:1727) so it says exactly what a narrowed program can still do.

Regression tests, in server.rs's test module:

- `a_narrowed_local_connection_cannot_reach_a_shell_a_screen_or_a_file`: with the switch on, authorize refuses role local for one value of each of WriteInput, QueueInput, SetQueuedInputs, SendQueuedInput, Attach, Snapshot, SessionScreen, ReadWorkspaceFile, ListWorkspaceDir, StatWorkspacePaths, LinkCardSession, SaveTool, StartToolRun, SetOrchestration, SetRailRun and SetStepRun. Fails today.
- `a_narrowed_local_connection_keeps_its_reads`: ListSessions and GetBoard still pass, and with the switch off every request still passes for role local, so nothing changes for today's default.
- Extend untokened_local_keeps_full_reach_until_the_switch_is_on rather than duplicating it.

Not in this card: the switch is off by default, so an untokened local connection keeps CreateSession and the rest; the app-role token sits in a 0600 file any same-user process can read; and the threat model does not yet say whether TCC is a same-uid boundary Gavin defends. Those need a decision of their own, not a code change here.

## Done when

- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests in the touched crate or module, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched. Run `server::tests` under a temp HOME, since a real require_local_token marker leaks into them.
- The regression test fails before the change and passes after it.
- Follow the CLAUDE.md traps that apply: a new SQLite column needs its own `ALTER TABLE`, a widened request needs a compat-gate entry, and you commit only your own files.
- Once the fix is in, file this check with `gavin_request_human(<this card>, "test", …)` using exactly this text: "On your own Mac, with Require a token for full local access turned on, a process that holds no Documents grant and connects untokened to daemon.sock gets Forbidden for ReadWorkspaceFile on ~/Documents/h54-canary.txt and for CreateSession, WriteInput and Attach, and the canary text never comes back, both while Gavin.app runs and after it quits."
