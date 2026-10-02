---
order: 29696
kind: task
title: Companion 30: settings, workspace settings and adding a workspace on the phone
status: Done
labels: ready-for-agent
parent: companion.md
complexity: complex
---
Blocked by: companion-23-served-signed-ui.md, companion-04-split-workspace-state.md

Part of `companion.md`. Read the spec (section "Workspace state split") first.

## What to build

In the bundle, made responsive:

- app settings and agent configuration;
- workspace settings, through ticket 04's commands;
- **adding a workspace**, through a remote folder browser built on the file viewer's directory listing, starting at the home folder.

Extend the Demo Workstation to match.

## Acceptance criteria

- [x] Seam 2 tests for the settings and add-workspace flows
- [x] Seam 1: the Remote role may call the workspace-settings commands but not the layout-saving ones

When done, file a human test: add a workspace from the phone, and see it appear at the desk.

## Plan

Worked on `companion/surfaces-b` (worktree `.gavin-worktrees/companion-surfaces-b`), on top of companion-29.

- [x] Host: a forwarded call has an origin of its own (`companion`), so a desk window adopts what a Device wrote instead of taking it for its own echo; `workspace-settings-synced` reaches Devices
- [x] Host: `add_workspace` (a workspace from its settings alone) and `home_dir`, registered and in the Remote role table
- [x] Host: every app-wide setter announces `app-settings-synced`; the desk re-reads its app settings (`loadAppSettings`) on another writer's change
- [x] Seam 1: `device_wire.rs` — the workspace-settings commands and `add_workspace` reach the desk, the layout-saving ones are refused
- [x] Desktop components responsive where they live: `ColourPicker`, `ComplexityTable`, `FallbackChainEditor`
- [x] Bundle view state: a Settings surface per workspace; app Settings and Add workspace off the workspace list
- [x] Bundle: app settings and agent configuration (`PhoneAppSettings`)
- [x] Bundle: workspace settings through ticket 04's commands (`PhoneWorkspaceSettings`)
- [x] Bundle: add a workspace through a folder browser on `list_directory`, starting at the home folder (`PhoneAddWorkspace`)
- [x] Demo Workstation: app settings, workspace settings, `add_workspace`, a home folder to browse
- [x] Seam 2 tests for the settings and add-workspace flows; source guards updated
- [x] README, checks
- [ ] Human test: On a phone with a debug Companion paired to the dev Workstation (desktop app running under tauri dev with this branch, remote access on): tap Add a workspace…, walk from the home folder to a project folder no workspace uses, tap Add, choose Set up and add — the phone opens the new workspace, and at the desk it appears in the sidebar with its board; then on the phone rename it and change its colour under Settings, and check the desk's sidebar follows without any tab moving

## Outcome

Uncommitted on `companion/surfaces-b` (worktree `.gavin-worktrees/companion-surfaces-b`), on top of companion-29 (9980d838). `app/companion/README.md`, "What is here, and what is not", has the design.

- **Host.** `add_workspace(settings)` (`workspace_settings.rs`): a workspace made of settings alone through the same `apply_settings_patch` gate (layout refused whole, a name required and trimmed), an id the host mints (v4 UUID), appended, persisted, announced as `workspaces-synced`. `home_dir` (`fileviewer.rs`). Both registered, in `commands.rs`, in `protocol::remote_command_table` as Allowed, and classified in `commandGate.test.ts`. **No protocol bump**: both are desktop commands over the existing forward path, and the table is read by name.
- **Trap found and fixed: a Device's write was invisible at the desk.** A forwarded call runs through a desk window's webview, so `set_workspace_settings` announced it under THAT window's label, and that window dropped it as its own echo. `forwarding::dispatch` now sets a header, and `forwarding::origin` turns it into `companion` (`FORWARDED_ORIGIN`), which no desk window has. `workspace-settings-synced` now also reaches Devices (`forwarding::emit`).
- **App-wide settings were read once per window.** Every app-wide setter (theme, font size, auto commit, review, git tracking, headroom default, model defaults, agent defaults, pause, launch wall, custom resume args) now announces `app-settings-synced` with its origin; `layoutState.bootstrap` re-reads (`loadAppSettings` + `reloadAppSettings`, which also reload the pause cycle, the launch wall and `themeState.reload()`) on another writer's change. Without it a model set from the phone would be stored and the desk would launch the old one — and its next wholesale `set_agent_defaults` would write the stale copy back.
- **`watchRootedWorkspaces` watched once per window**, so a workspace added (or a root bound) after startup got no watch and an empty board until relaunch — including the root-bound-in-another-window case the code already claimed to handle. Now remembered per workspace and root (`gavinState.ts`).
- **Bundle.** A fourth surface, **Settings** (`PhoneWorkspaceSettings.svelte`), and two Workstation screens off the list — **Settings** behind a gear (`PhoneAppSettings.svelte`) and **Add a workspace…** (`PhoneAddWorkspace.svelte` over `phoneAddWorkspace.ts`: from `home_dir`, `list_directory` with the disk's top as root, dotfiles hidden, existing workspaces marked, the desk's own set-up question, then `add_workspace` and open). Both settings screens drive the desk's own stores, writers and option lists (`phoneSettings.ts` only for what the phone says differently); `saveSetting` shows a failed write on screen instead of the desk's overlay. View state gained `screen` (settings is remembered, a half-done add is not). The bundle guard now allows the settings writers and reads each one's body in `layoutState.ts` to prove none reaches `persistWorkspaces`.
- **Desktop components responsive where they live**: `ColourPicker` (32px swatches), `FallbackChainEditor` (44px, 16px fields) under `pointer: coarse`; `ComplexityTable` stacks each level at `max-width: 600px`. `ceilingFrom` moved from `GlobalSettingsView` to `launchGate.ts` (tested) so the two surfaces share it. `backend.agentProfiles`' type gained the optional `effortFlag`/`efforts` the host already sends.
- **Demo Workstation**: `settingsCommands.ts` (reads and writes, announced as the host does), `workspaceCommands.ts` (settings, `add_workspace`, `home_dir`, `gavin_root_exists`, `init_gavin_root`, `set_gavin_git_tracking`, `set_root_config_field`), a second agent (Codex) and effort levels, a home folder with `code/weather-station` to add. `list_directory` takes any folder as root, as the host does. **Also fixed:** the activity loop's last step replaced the whole demo state every lap, silently undoing a visitor's settings, saved files, commits and added workspaces (App Review would watch an edit vanish); it now puts back only session statuses and sample cards.
- **Proof.** Seam 2: `seam/settingsActions.test.ts` (33: every app and workspace setting's command and arguments, the Workstation holds it, layout untouched, a desk change followed, failures shown on the phone, everything sent allowed by the real Remote role table) and `seam/addWorkspace.test.ts` (13: home folder, browse, marks, set-up order, ignore rule first, as-it-is, `workspaces-synced` under `companion`, no layout save, refusals). Seam 1: `device_wire.rs` `the_workspace_settings_commands_reach_the_desk_and_the_layout_saves_do_not` (a real daemon + relay + test Device). Host unit tests: forwarded origin, `new_workspace`, v4 ids. Desk: `layoutState.test.ts` (app-settings re-read, own echo ignored, a Companion's workspace adopted and watched), `gavinState.test.ts`. Results: `cargo test --workspace` all pass; companion test 499 pass, check 0 errors, build ok; `npm test` 7363 pass, 2 fail — `remoteAccessSurfaces` "forwards the three device pushes" and the `mainThreadCommands` guard on `forwarding.rs`'s `#[cfg(test)]` mock builder (now line 405, was 376), the same two recorded at base 3eb6b084 on companion-29; `npm run check` 0 errors; build ok; shell test 241 pass. Driven in Chrome at 390px against the page's demo: app settings, workspace rename + colour (list follows, survives activity laps), add workspace from the home folder with set-up, new workspace opens and lists; no console errors.
- **Not here.** Picking or changing a workspace's folder, switching its agent profile, deleting a workspace, hub-tab visibility, Headroom, TypeSafe, Updates, the daemon, remote access and Devices stay at the desk. The browser does not create folders.
