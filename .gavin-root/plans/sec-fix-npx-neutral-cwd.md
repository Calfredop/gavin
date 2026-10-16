---
kind: task
title: "[sec] The Matt Pocock skills install and the gavin-mcp playwright shim run npx from the workspace, so a cloned repo's .npmrc or node_modules decides what executes"
status: To Do
priority: medium
complexity: moderate
labels: security, ready-for-agent
---
Fix a needs-validation lead from the 2026-10-15 security audit (run-1). It is not confirmed: the audit traced it in source but could not observe a fixture's `script-shell` or planted package actually running under gavin's exact argv, because running npm or npx was out of bounds. The failing regression test below is the proof — write it first and watch it fail. If it already passes before any change, the lead is wrong: record why under a dated "## Comments" heading and move the card to Done with no code change. Fingerprint: `npx-cwd-in-workspace@agent_skills.rs/install+gavin-mcp/playwright.rs/mcp_command`.

Full record: `NEEDS-VALIDATION.md` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

gavin's own code says npx reads the `.npmrc` and `node_modules` of its working directory, so in a cloned repository the repo could name the registry, or ship a package of the same name to run instead. For that reason both browser installs run npx from the home directory (`neutral_cwd` in agent_playwright.rs, `run_install` in the daemon's browser/install.rs). Two sibling npx spawns do not:

1. **The Matt Pocock skills install** (setup wizard step or Settings row) on a codex, gemini, cursor or opencode workspace runs `npx -y skills@latest add mattpocock/skills --skill * -a <agent> -y` with cwd = the workspace root. A paired Device can reach it too: `agent_skills_install` is Allowed in the remote command table.
2. **`gavin-mcp playwright`**, the `playwright` server entry gavin writes into the workspace's own MCP config, exec()s `npx -y @playwright/mcp@0.0.83 --cdp-endpoint … --output-dir …` without setting `current_dir`. It keeps the agent CLI's working directory, the workspace or rail worktree, and it runs on every agent start with no click.

npm 11.20.0's source shows the mechanism. `@npmcli/config` walks up from cwd to the first directory holding `package.json` or `node_modules` and loads that directory's `.npmrc` as the project layer. Only `prefix` is refused from that layer, so `script-shell` and `registry` are honoured. `script-shell` flows through libnpmexec and `@npmcli/run-script` to `@npmcli/promise-spawn`, which spawns `<script-shell> -c <bin …>`. A repo-shipped `./x.sh` named as `script-shell` therefore runs in place of the shell, for either spawn. For the shim, libnpmexec also satisfies the exact spec `@playwright/mcp@0.0.83` from a committed `node_modules/@playwright/mcp` at that version, with no registry fetch and no integrity check. For the skills install, a `registry=` line serves any package as `skills@latest`. (A planted `node_modules/skills` is not a reliable stand-in for the tag spec.) Workspace trust gates only the agent command string, and the Settings row shows the bare npx line, so the human sees nothing of this. The threat model (AD-3, AD-6) does not accept a cloned repo's files becoming execution on the human's click.

## Root cause

`agent_skills::install` calls `run("npx", &skills_cli_args(agent), &root, …)` with the workspace root, and `run()` applies it as `.current_dir(cwd)`. `gavin-mcp`'s `mcp_command` builds `Command::new(npx)` with args and PATH but no `current_dir`, and `start()` execs it in the inherited cwd. Both break the neutral-cwd rule that `agent_playwright.rs` and the daemon's browser install already enforce for the same npx and, in the shim's case, the same pinned spec.

## The invariant to enforce

No npx (or npm) process gavin spawns takes its npm config or its local package tree from a workspace, a worktree, or any directory a repository controls. Each runs from a neutral directory (the home directory, falling back to the temp dir), and is handed the project directory explicitly when it needs one.

## Trace (lines as of 2026-10-16; re-read before editing)

- `app/src/lib/agents/AgentSkillsControls.svelte:68` (install()): the Install click calls `backend.agentSkillsInstall(rootPath, agentCommand, profileId)` for the workspace being set up, which may be a fresh clone carrying its own `.npmrc`.
- `app/src-tauri/src/agent_skills.rs:622` (agent_skills_install): the Tauri command, also Allowed for Devices at `crates/protocol/src/remote_commands.rs:208`, hands `root_path` to `install()`.
- `app/src-tauri/src/agent_skills.rs:666` (install, `Route::SkillsCli`): `run("npx", &skills_cli_args(agent), &root, INSTALL_TIMEOUT)` with the workspace root.
- `app/src-tauri/src/agent_skills.rs:161` (skills_cli_args): `-y skills@latest add mattpocock/skills --skill * -a <agent> -y`, a tag spec resolved from whatever registry the effective config names.
- `app/src-tauri/src/agent_skills.rs:315` (run): `.current_dir(cwd)` at 323.
- `app/src-tauri/src/agent_skills.rs:168` (command_for): the row shows only the bare npx line.
- `app/src-tauri/src/agent_playwright.rs:168` and `:200` (neutral_cwd, the browser install): the existing rule and its doc comment, using the same `run` helper with the home directory.
- `crates/daemon/src/browser/install.rs:136` (run_install): the daemon's browser install for the same spec sets `current_dir` to home.
- `app/src-tauri/src/agent_playwright.rs:593` (write_mcp_server for `playwright`): gavin writes its `gavin-mcp playwright` entry into the workspace's MCP config, so every agent session there starts the shim.
- `crates/gavin-mcp/src/playwright.rs:71` (mcp_command): both branches (the Windows `node npx-cli.js` one at 82 and the plain one at 87) set args and PATH, never `current_dir`.
- `crates/gavin-mcp/src/playwright.rs:125` and `:132` (run, start): the command is built and exec()d in the agent CLI's cwd; on Windows `spawn()` uses the same cwd.

## What the audit could not observe

- End-to-end execution: npm and npx were not run. The chain comes from npm 11.20.0 source, plus a bounded observation of config resolution picking up a project-sourced `script-shell` and `registry`. Users' npm versions may differ.
- For the shim, that each agent CLI (Claude Code, Codex, Gemini, Cursor, opencode) starts stdio MCP servers with its cwd in the workspace or worktree, and when within its own folder-trust flow it does so.

## Fix

1. **Shim.** Give `mcp_command` a neutral working directory on both branches. `run()` already resolves `home` from `HOME`/`USERPROFILE`, so pass the neutral dir in (home if it is a directory, else `std::env::temp_dir()`) and call `command.current_dir(neutral)`. `--output-dir` is already absolute. Check that `@playwright/mcp` uses its cwd for nothing else a session relies on.
2. **Skills install.** The skills CLI installs into the directory it runs in, which is why the root is passed today. Two options; pick one after checking it against npm's source:
   - Spawn from `neutral_cwd()` and pass npm's `--prefix <neutral dir>` before the spec, with the workspace given to the skills CLI explicitly if it accepts a target directory; or
   - Keep cwd = root but pass `--prefix <neutral dir>` so `@npmcli/config` takes its project layer and local tree from the neutral dir (a CLI `prefix` short-circuits the walk up from cwd), while libnpmexec still runs the bin in the process cwd. Verify both halves of that claim against libnpmexec before relying on it.
   Move `neutral_cwd` into a shared spot (agent_skills.rs or a small module) rather than copying it a third time.

Regression tests, written first:

- `crates/gavin-mcp/src/playwright.rs`, beside the existing `mcp_command` tests (around lines 231 and 264): the built command's `get_current_dir()` is the neutral directory passed in, on both the plain and the `npx.cmd` branch. It fails today, where it is `None`.
- `app/src-tauri/src/agent_skills.rs`: factor the skills route's spawn into a function that returns the program, args and cwd it will use, and assert that the npm config cannot come from the root. With the first option, cwd is not under the root; with the second, the args carry `--prefix` naming a directory outside it. It fails today.
- Where an offline npm is available in CI or a sandbox, a fixture test is worth adding: a root with `package.json` `{}` and `.npmrc` `script-shell=./marker.sh` writes no marker when the skills route's exact argv and cwd are spawned. Skip it cleanly where npm is absent.

## Done when

- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests in the touched crate or module, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched.
- The regression test fails before the change and passes after it.
- Follow the CLAUDE.md traps that apply: a new SQLite column needs its own `ALTER TABLE`, a widened request needs a compat-gate entry, and you commit only your own files. A rebuilt `gavin-mcp` reaches running sessions only through the app's install step, not `cargo build` alone.
- Once the fix is in, file this check with `gavin_request_human(<this card>, "test", …)` using exactly this text: "In the real app, a scratch workspace cloned from a marker repo (an `.npmrc` with `script-shell=./marker.sh`, and a committed `node_modules/@playwright/mcp` at the pinned version whose bin writes a marker) produces no marker when Install is clicked on the Matt Pocock skills row under a codex profile, and none when a Claude Code session starts with gavin's playwright entry, whose npx process `lsof -a -d cwd -p <pid>` shows running from the home directory."
