---
order: 36864
kind: task
title: "[sec] Any repo that ships crates/gavin-mcp/Cargo.toml and scripts/gavin-mcp gets gavin's own MCP entry pointed at the repo's script, with no disclosure and with kimi folder trust granted"
status: Done
priority: medium
complexity: moderate
labels: security, ready-for-agent
---
Fix a needs-validation lead from the 2026-10-15 security audit (run-1). It is not confirmed: the audit traced it in source but could not observe the combined case (one kimi-code Integration run over a stub gavin checkout writing both the repo-relative command and the trust record), nor whether the agent CLI then starts the repo's script without a prompt of its own. The failing regression test below is the proof — write it first and watch it fail. If it already passes before any change, the lead is wrong: record why under a dated "## Comments" heading and move the card to Done with no code change. Fingerprint: `app/src-tauri/src/agent_setup.rs:mcp_command:gavin-checkout-heuristic-forgeable`.

Full record: `NEEDS-VALIDATION.md` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## Relation to `sec-fix-kimi-trust-match-own-command.md`

The two cards share one rule: gavin's MCP entry is recognised by what it runs, not by the key `gavin`. They fix different halves of it.

- The kimi card fixes the LAUNCH half: protocol::kimi_trust::declares_only_gavins accepts any `gavin`-keyed entry, so a worktree's committed .mcp.json (which nothing rewrites) gets kimi trust. Its fix compares the entry with an own_command.
- This card fixes the SETUP half: mcp_command decides what "gavin's own command" is, and decides it from file existence. Integration then writes the repo's script into gavin's own entry and grants kimi folder trust over it. prepare_kimi_launch also computes the kimi card's own_command with this same mcp_command, so until this card lands the kimi card's comparison would still accept the repo-relative `scripts/gavin-mcp` the repo supplied. The kimi card's Fix already says not to count that launcher as gavin's own.

Do this card first, or both in one branch: it settles what own_command is, which the kimi card's comparison depends on.

## What is wrong

mcp_command writes the RELATIVE launcher `scripts/gavin-mcp` as the command of gavin's own MCP entry when the workspace root contains both crates/gavin-mcp/Cargo.toml and the launcher file. Both conditions only check that a file exists, so a cloned repository meets them by shipping a stub Cargo.toml and a script. The doc comment on mcp_command, test A2 and docs/security/03-agent-surface.md all state that gavin's own writes cannot be made to execute a file the repository supplies, and the doc comment rests that on "a checkout that actually builds gavin-mcp". The project's own test fixture with_launcher is exactly the forgery: a two-line stub Cargo.toml and a stub script in a tempdir, after which run_integration writes `scripts/gavin-mcp`.

Then:

- write_mcp_config writes gavin's entry with that relative command, which the agent CLI resolves against the workspace root, so it names the repo's file.
- foreign_mcp_servers exempts the `gavin` key whatever it holds, and run_integration runs the scan with own_command = mcp_command(...), so nothing is disclosed.
- mcp_written becomes true, and for kimi-code grant_folder_trust writes kimi's per-folder trust record. That record is gavin's own consent-granting write, here made for a workspace whose `gavin` server is the repository's script.
- Later kimi launches in context folders and worktrees go through prepare_kimi_launch, which computes own_command with the same mcp_command.

Every agent session that loads the project MCP config then spawns the repository's script as the user, with the session's environment (the cursor dialect passes GAVIN_SESSION_ID and GAVIN_SESSION_TOKEN explicitly). Nothing the human sees names the command: IntegrationResult lists paths only.

## Root cause

The decision "this is gavin's own checkout", which lets the repository choose the command of gavin's own MCP entry, is a file-existence test any cloned repo can satisfy. The foreign-server exemption for the `gavin` key and the folder-trust grant that follows the write both assume the command written there is one gavin controls.

## The invariant to enforce

gavin's own MCP entry names a repository-relative command only for a root the human has marked, on this machine, as a gavin checkout whose launcher they trust. The mark is never inferred from files the repository ships. Without it, mcp_command returns the absolute binary resolved beside the running app, and folder trust is granted only over that.

## Trace (lines as of 2026-10-16; re-read before editing)

- `app/src-tauri/src/agent_setup.rs:2998` (setup_agent_integration): The human runs Set up / update integration for a cloned workspace. The config.toml workspace-trust gate (workspaceTrust.ts) does not cover this command or the MCP command it writes.
- `app/src-tauri/src/agent_setup.rs:1932` (mcp_command): is_gavin_checkout = fs.is_file(root/crates/gavin-mcp/Cargo.toml) (1933) && fs.is_file(launcher_file(root, ..)) (1934); a stub satisfies each. Returns MCP_LAUNCHER (1882). The rationale is the doc comment at 1914-1923.
- `app/src-tauri/src/agent_setup.rs:3151` (run_integration): The foreign-server scan runs with own_command = mcp_command(fs, root, &binary).
- `app/src-tauri/src/agent_setup.rs:2323` (foreign_mcp_servers): `s.name != layout.server_key` drops the `gavin` key whatever its command, so a repo .mcp.json declaring only `gavin` discloses nothing.
- `app/src-tauri/src/agent_setup.rs:1996` (write_mcp_config): Writes gavin's entry with the relative command; mcp_written = true at 3157 (and 3164 on Keep).
- `app/src-tauri/src/agent_setup.rs:3218` (run_integration -> grant_folder_trust, 2495): mcp_written gates the kimi trust record. The consent rules are the comment at 2472-2494; the recorded kimi 2.1.1 behaviour is at 826-846.
- `app/src-tauri/src/agent_setup.rs:2924` (prepare_kimi_launch): own_command = mcp_command(&fs, workspace, &binary) (2928), handed to grant_kimi_launch_trust (2674) and on to protocol::kimi_trust::declares_only_gavins (crates/protocol/src/kimi_trust.rs:227).
- `app/src-tauri/src/agent_setup.rs:6375` (with_launcher, test fixture): The forgery: a stub Cargo.toml plus stub scripts. integration_writes_the_launcher_for_a_root_that_carries_one (6466) asserts run_integration writes MCP_LAUNCHER for it. Test A2, a_repo_that_merely_ships_a_launcher_does_not_get_one_written (6421), is defeated by adding the one stub Cargo.toml.
- `docs/security/03-agent-surface.md:316`: "Gavin's *own* writes cannot be redirected".

## What the audit could not observe

- The combined kimi-code case has no test: each half was observed separately (integration_writes_the_launcher_for_a_root_that_carries_one, a_kimi_run_trusts_its_folder_and_says_so), but not one run writing the relative command and the trust record together.
- Whether the agent CLI then spawns the repo's `gavin` server with no consent prompt of its own is third-party behaviour that was not run. The code records that kimi 2.1.1's trust record lifts its trust screen. Claude Code may still show its own project-server prompt naming `gavin`, which a human would approve as gavin's.

## Fix

Decide "gavin checkout" from a human-recorded, machine-local mark, never from the repository's files.

1. Store the mark outside the workspace, on the desk's own disk: for example a small file in the app's data directory mapping a canonical root to the sha256 of the launcher file it approved. The launcher digest means a changed launcher asks again. Both mcp_command callers (run_integration and prepare_kimi_launch) read the same store.
2. mcp_command takes the mark into account: it returns MCP_LAUNCHER only when the root has a mark AND the current launcher file's digest matches it. Otherwise it returns the absolute binary.
3. The Integration step offers the mark when the root looks like a gavin checkout and has none: name the file (`scripts/gavin-mcp`) and say that approving lets this repository choose what gavin's MCP entry runs. Ask with askConfirm (never a native dialog), with the action named on the button.
4. Update the doc comment on mcp_command and docs/security/03-agent-surface.md:316 to say what decides the relative launcher.

Do not verify the launcher's bytes against a copy embedded in the app as a substitute. The committed script changes between versions, and the genuine script still falls back to `$root/target/{release,debug}/gavin-mcp`, which the repository can ship.

Note for the gavin repo itself: its committed .mcp.json names `scripts/gavin-mcp` on purpose (the cross-machine flip-flop the doc comment describes). On each machine, approve the mark before the next Integration run, or that run writes an absolute path into the committed file.

Regression tests, in agent_setup.rs's test module:

- `a_forged_gavin_checkout_gets_the_absolute_binary`: with_launcher on a tempdir with no mark; run_integration writes the absolute binary, not MCP_LAUNCHER. Fails today.
- `a_kimi_run_over_a_forged_checkout_trusts_only_the_absolute_binary`: the kimi-code profile over HomedFiles and the same fixture; the trust record, if written, is written only while the gavin entry names the absolute binary. Fails today.
- `a_marked_checkout_keeps_its_launcher` and `a_changed_launcher_drops_the_mark`: the marked root still gets MCP_LAUNCHER; editing the launcher's bytes makes mcp_command return the absolute binary.
- Rewrite integration_writes_the_launcher_for_a_root_that_carries_one to set the mark first; as written it asserts the forgery works.

## Done when

- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests in the touched crate or module, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched.
- The regression test fails before the change and passes after it.
- Follow the CLAUDE.md traps that apply: a new SQLite column needs its own `ALTER TABLE`, a widened request needs a compat-gate entry, and you commit only your own files.
- Once the fix is in, file this check with `gavin_request_human(<this card>, "test", …)` using exactly this text: "Under a throwaway HOME and KIMI_CODE_HOME, a fixture repo with a stub crates/gavin-mcp/Cargo.toml and a scripts/gavin-mcp that only touches /tmp/gavin-launcher-marker, run through Integration with the kimi-code profile and then a kimi session, leaves no marker file and names the absolute gavin-mcp in .mcp.json."

- [ ] Human test: Under a throwaway HOME and KIMI_CODE_HOME, a fixture repo with a stub crates/gavin-mcp/Cargo.toml and a scripts/gavin-mcp that only touches /tmp/gavin-launcher-marker, run through Integration with the kimi-code profile and then a kimi session, leaves no marker file and names the absolute gavin-mcp in .mcp.json.
