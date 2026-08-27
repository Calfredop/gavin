---
title: Workspace delete
status: In Progress
---
Make the current "X" button in the sidebar only remove the workspace from Gavin
app. Then add a delete workspace option in workspace settings. This should walk
the user through a series of prompts (remove plans, remove skills…) with an end
input confirm one, that removes all Gavin features from the workspace. As the
user confirms/declines for plans, skills… do not remove them but store the
choice for final confirm.

## Decided

- **The X is purely app-side.** It keeps its sessions-will-end confirm and
  touches neither the disk nor a single daemon row — today it deletes the
  workspace's kanban columns and labels, and that stops.
- **Nothing is unreachable.** Because the workspace id is a uuid minted at
  creation, a removed workspace's rows can only be found again through a
  tombstone the X leaves behind; setting a root on an empty workspace offers to
  reclaim them.
- **Delete walks six screens, removes nothing until the last.** Plans · skills ·
  MCP entry · instructions block · nested contexts · daemon rows. Every answer is
  stored, not acted on.
- **Removal means the OS Trash**, so an untracked card in `plans/done/` is one
  Finder gesture away, not gone.
- **Delete ends with the workspace out of the app**, with no tombstone: it is the
  X plus the disk.

## Out of scope

- Re-pointing a live workspace's root at a previously removed folder. Reclaim is
  offered only on a workspace that has nothing in it yet.
- Any protocol or daemon change. Every row this clears is reachable with existing
  requests, so `PROTOCOL_VERSION` does not move.
- Committing the deletions. The files leave the working tree; what git does about
  that is the human's call.
- Uninstalling gavin itself, or touching anything outside the workspace root
  except the `extra_contexts` folders the wizard names one by one.

## Steps

- [ ] `closeWorkspace` stops calling `deleteBoard` and writes no daemon row; its
      confirm says the files stay put. `layoutState.test.ts`'s assertion that
      `deleteBoard` was called flips to asserting it was not.
- [ ] `WorkspacesData` gains `removedWorkspaces` (serde `default`, so existing
      state files still load), and `workspace.ts` gains pure
      `rememberRemoved` / `matchTombstone` / `forgetTombstone` — newest first,
      capped, and written only for a workspace that had a root. Unit tested.
- [ ] `setWorkspaceRoot` offers the reclaim: a pure
      `reclaimable(state, workspaceId, rootPath)` returns a tombstone only for a
      workspace with no root and no sessions, and the prompt offers Restore or
      Start fresh — Start fresh drops the tombstone.
- [ ] Restoring re-keys the workspace to the tombstone's id before anything binds
      to the new one: unwatch the new id, watch the old, refetch board,
      orchestration and tools. A test proves the pages travel with it and the
      board that comes back is the old one.
- [ ] `workspaceDelete.ts` — the pure step machine: the six steps, the answer
      record, and `plannedRemovals(footprint, answers)` returning the exact paths
      to trash and the exact file edits. It never touches the filesystem, and it
      is what the final screen renders. Unit tested.
- [ ] Tauri `scan_gavin_footprint(root)` reports what actually exists:
      `.gavin-root/` with its card and archive counts, which `.claude/skills/gavin*`
      dirs are present, whether the profile's MCP config carries the `gavin`
      server key, whether the instructions file carries the marker block, every
      nested `.gavin/` under the root, and the `extra_contexts` paths outside it.
      Reuses the `agent_setup` profile table rather than hardcoding file names.
- [ ] Tauri `remove_gavin_footprint(root, plan)` executes it: chosen paths go to
      the OS Trash, the `gavin` key is stripped from `.mcp.json` / `config.toml`
      with the same format-preserving writers that wrote it, and the
      `<!-- gavin:start -->…<!-- gavin:end -->` block is cut from the instructions
      file. A shared config file is only ever edited, never deleted; a path the
      scan did not report cannot be removed; one failure does not abort the rest.
- [ ] Rust tests: trashing `.gavin-root` leaves the repo otherwise intact,
      stripping the MCP key preserves every other server and the file's
      formatting, cutting the marker block leaves the human's own prose
      byte-identical, and a declined category is untouched.
- [ ] Settings grows a Danger zone section with **Delete workspace…**, disabled
      with its reason on a workspace that has no root — the reason hung on a
      non-disabled ancestor, since a disabled element fires no `mouseenter`.
- [ ] `WorkspaceDeleteWizard.svelte` renders the machine: one screen per
      category showing the exact paths and counts found, each declinable, a
      category the scan found nothing for skipped entirely, and the nested
      contexts screen carrying one checkbox per path — the ones outside the root
      grouped under a warning and unticked by default.
- [ ] The sixth screen asks about the daemon's rows for this workspace — board
      columns and labels, rails and run state, workspace-scoped tools and group
      templates, card↔session links — and says plainly that declining leaves rows
      nothing but a reclaim can reach again.
- [ ] The final screen lists everything that will happen (paths to Trash, files to
      edit, rows to clear, sessions to end) and enables Delete only once the
      workspace's name is typed exactly.
- [ ] Confirming runs the removal, then clears the daemon rows if chosen —
      `DeleteBoard`, `SetOrchestration` with empty rails, `DeleteTool` and
      `DeleteGroupTemplate` for workspace-scoped rows only (never the
      `workspace_id NULL` globals), and `UnlinkCardSession` per linked card,
      because `delete_board` leaves `card_sessions` behind — then removes the
      workspace the way the X does, without a tombstone. Anything that failed is
      reported with its path and reason, and the workspace stays so the run can be
      repeated.
- [ ] `smokeChecklist.ts` gains what the suites cannot cover: the wizard
      end to end on a scratch repo, a declined category surviving it, the Trash
      actually holding the files, and remove → re-add → reclaim bringing back the
      columns and the rails.
- [ ] `cargo test --workspace`, `npm test`, `npm run check` and `npm run build`
      green in a detached worktree.
