# Workspace settings are written apart from the desk's layout

The desktop saved every workspace as one record, written whole by `set_workspaces_state`. That record mixed two things:

- **Workstation data:** the workspace's name, root, the Settings tab's switches, the consent and trust stamps, and the runs in flight.
- **Desktop layout:** pages and their pane trees, which page, view and tab is showing, sidebar pins, divider and splitter positions.

The Companion must be able to change the first and never the second (spec, "Workspace state split"). A Companion refused `set_workspaces_state` would still have had no way to change a setting. And each desk window saves a copy it holds, so a desk window's next layout save would carry the setting as it was before the phone changed it, and undo the change.

We decided to split who may write each key, not where it is stored:

- **`set_workspace_settings(workspaceId, patch)`** changes settings keys only. `null` clears a key back to inherit. A patch naming a layout key is refused whole. The Remote role may call it.
- **`set_workspaces_state`** stays the desk's layout save. For a workspace the host already holds, it keeps only the payload's layout, and the settings stay the host's. The desk still adds, closes and reorders workspaces through it, and a new workspace is taken whole. The Remote role is refused it.
- **`get_workspace_settings`** returns every workspace's id and settings, with no layout.
- **A settings write is broadcast as one workspace's settings record** (`workspace-settings-synced`). Other windows take its settings and keep their own layout.

The partition is one list per side: `LAYOUT_KEYS` and `SETTINGS_KEYS` in `app/src-tauri/src/workspace_settings.rs`, mirrored in `app/src/lib/workspace/workspaceSettings.ts`. Three tests hold it together:

- a Rust test fails when a `Workspace` key is on neither list;
- a type check fails when a TS `Workspace` key is on neither list;
- a parity test fails when the two sides disagree.

## Considered options

- **Split config.json into two sections.** Rejected. The dev and release builds share `config.json`, and an older build ignores a key it does not know and drops it on its next save. A setting moved out of the workspace object would reach the release build as absent, and be lost the first time that build saved.
- **Keep `set_workspaces_state` writing everything, and only refuse it to the Remote role.** Rejected. A phone could not change a setting, and even with a separate settings command, the desk's next layout save would undo the change.
- **Whole-settings replacement instead of a patch.** Rejected. Two writers changing different settings of one workspace at once would each overwrite the other's.

## Consequences

- `config.json` keeps its shape exactly. A test loads a hand-built file in the pre-split shape and checks that the file written back is the same JSON.
- Every setter in `layoutState.ts` goes through `saveWorkspaceSettings`. A setting written through `persistWorkspaces` would show in its window and be gone after a restart. Debug builds log any settings that a layout save tried to change.
- The in-flight run records `orchestrationAgent` and `developingCards` are settings, so a Generate or a Develop started from a Device can claim its slot.
- `gitView` is layout, but it carries the in-flight commit record `agentCommit`. Ticket 29 (Git on the phone) must move that record to the settings side before a Device can start a commit.
- The tombstone list `removedWorkspaces` still rides the layout save, because the desk's closes write it. Adding a workspace from a Device (ticket 30) needs a Workstation command of its own. A workspace with no pages is already valid at the desk. Ticket 30 added it: `add_workspace` takes settings alone, the host mints the id, and every window hears the new list as `workspaces-synced`.
