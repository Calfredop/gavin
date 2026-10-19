---
order: 25600
kind: task
title: Companion app tools tab
status: Done
---
Tools handling is totally missing from the companion app

## Done (2026-10-16, uncommitted)

A **Tools** surface on the phone, between Sessions and Decisions
(`app/companion/src/companion/surfaces/PhoneTools.svelte` over
`phoneTools.ts`, actions in `state/tools.ts`). It lists the library in the
desk's order (workspace, global, built-in) with search; a row opens in place
showing the kind, where it runs, its last run, its parameters, Run, and what it
runs. Kinds that only work on a rail are listed with Run dark and the desk's reason.

- **One launch path.** `workspaceToolsActions.ts` now takes a `ToolLaunchHost`
  (`DESK_TOOL_HOST` / the phone's `DEVICE_TOOL_HOST`), the way card and rail
  launches already do; the phone calls `runToolWith`. The launch wall refuses
  instead of queueing, the desk places the session, and only an agent tool's
  terminal opens on the phone.
- **Verdicts.** A session exit re-reads the runs, and the phone files the
  verdict for agent tools it started. The rule is now the shared
  `agentToolVerdict` in `workspaceTools.ts`. `tools-changed` is listened for.
- **Rails surface** now names a workspace tool's step from the library the
  phone holds. Before, it only knew the built-ins.
- **Demo Workstation** answers `get_tools`, `tool_runs`, `start_tool_run` and
  `set_tool_run_outcome` (`demo/toolCommands.ts`).
- Tests: `seam/tools.test.ts`, `surfaces/phoneTools.test.ts`, plus new cases
  in `workspaceTools.test.ts`, `workspaceToolsActions.test.ts` and
  `phoneRails.test.ts`. Desktop and Companion test/check/build all pass.

Known limits, not addressed here:
- The desk puts a phone-started tool session on the workspace's **Agents**
  page, not its Tools page. Changing that needs the Device's presence to
  say "tool" (`placeDeviceSession`), which is a protocol widening.
- A command or script tool's output can't be read on the phone after its
  session exits: the phone lets go of a terminal whose session ended. The
  verdict and exit code show on the row.
- Tool platform gates (e.g. macOS-only tools) are not judged on the phone,
  because it can't tell the Workstation's OS. Such a tool launches anyway
  and fails there.

- [ ] Decision: The phone's Tools tab now lists, reads and runs tools; writing and editing tools still happens at the desk. Should the phone also create/edit/delete workspace tools?
  Options: A) No — running is enough on the phone B) Yes — basic edit (name, description, body, parameters) and delete C) Yes — the full library editor
- [ ] Human test: On a phone with a debug Companion paired to the dev Workstation (desktop app under tauri dev with this change): open a workspace, tap the Tools tab — its own tools, global ones and built-ins are listed with last-run chips; open a command tool with a parameter, change the value, tap Run — the row shows running then passed/failed without leaving the tab, and the desk shows the session as a tab; then run an agent tool — its terminal opens on the phone, and once the agent finishes its turn the row reads passed
