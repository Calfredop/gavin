---
kind: task
title: Companion 04: split workspace data from desktop layout
status: Done
labels: ready-for-agent
parent: companion.md
complexity: complex
---
Blocked by: none (can start immediately)

Part of `companion.md`. Read the spec (section "Workspace state split") and ADR 0003 first.

## What to build

A refactor that makes the later work easy, with no behaviour change for the desktop.

The desktop saves its workspace state as one blob that mixes two things:

- **Workstation data:** which workspaces exist, and each workspace's settings (auto commit, review gate, git tracking and the rest).
- **Desktop layout:** pages and tabs.

The Companion must be able to change workspace settings, but never the desk's layout. So split the saved state: workspace settings get commands of their own, and layout keeps the existing layout-saving commands. Every surface that changes a workspace setting moves to the new commands.

## Acceptance criteria

- [x] Workspace settings save and load through the dedicated commands, and layout saving is unchanged
- [x] A `config.json` written by the current build loads without loss (a test against a hand-built old-shape file)
- [x] The release build, reading a `config.json` the new build wrote, still works: the dev and release builds share `config.json`
- [x] Logic lives in a pure `.ts` module with unit tests, and the `.svelte` files stay thin
- [ ] Human test: With companion/desk-prep running: change a workspace's colour and auto commit and rename it, restart the app, and all three are still set; with that workspace open in a second window, the change shows there and no tab moves

## Outcome

On branch `companion/desk-prep`, uncommitted. The decision and its consequences are in `docs/adr/0006-workspace-settings-apart-from-layout.md`.

- **Commands.** `get_workspace_settings` and `set_workspace_settings(workspaceId, patch)` (`app/src-tauri/src/workspace_settings.rs`). `null` clears a key; a patch naming layout is refused whole. `set_workspaces_state` is still the layout save, but it now keeps the host's settings for any workspace the host already holds. A settings write broadcasts `workspace-settings-synced`.
- **Key lists.** The partition is `LAYOUT_KEYS` / `SETTINGS_KEYS`, mirrored in `app/src/lib/workspace/workspaceSettings.ts`. A Rust test, a TS type check and a parity test hold the lists together.
- **Setters.** Every settings setter in `layoutState.ts` goes through `saveWorkspaceSettings`. No `.svelte` file changed.
- **config.json.** Unchanged shape. A hand-built old-shape file is written back as identical JSON. This machine's real config (10 workspaces) also round-trips exactly.
- **For ticket 12:** `set_workspaces_state` is the layout-saving command to refuse. `set_file_tabs`, `set_board_tabs` and `set_card_tabs` are desk layout too.
- **For ticket 29:** `gitView.agentCommit` is on the layout side and must move before a Device can start a commit.
- **For ticket 30:** adding a workspace needs a Workstation command of its own. A workspace with no pages is already valid at the desk.
