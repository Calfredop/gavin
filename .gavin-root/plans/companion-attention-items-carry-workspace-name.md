---
kind: task
title: Companion: send each attention item's workspace name, so the phone's inbox can head its workspaces
status: To Do
priority: low
complexity: simple
---
Follow-up from `companion-workstations-hub-ui-optimization.md`. The phone's full inbox (`app/companion-shell/src/shell/surfaces/InboxList.svelte` over `hub/inboxView.ts`) groups by Workstation, then workspace, but an attention item carries only the workspace's id (a UUID such as `79987f60-0c4b-…`), and an id is no heading. So today the workspaces are grouped together with no heading between them.

The shell half is done: `connection/attention.ts` reads an optional `workspaceName` on each item, and `groupedEntries` heads a workspace by it when present. What is missing is the desk sending it.

**To do.**
- `crates/protocol/src/attention.rs`: `AttentionItem` gains `#[serde(default, skip_serializing_if = "Option::is_none")] pub workspace_name: Option<String>` (camelCase on the wire: `workspaceName`). Growth by an optional field, as the API's contract says; add a round-trip test beside `an_older_reader_ignores_an_unknown_optional_field`. Update the struct literals: `crates/daemon/src/server.rs`, `crates/daemon/tests/device_wire.rs`, `app/src-tauri/src/forwarding.rs` (test helper `waiting`).
- `app/src/lib/companion/attentionAnswer.ts`: `AttentionItem.workspaceName?`, and `AttentionAnswerInput.workspaceNames?: Record<id, name>` stamped onto every item; `attentionPublisher.ts` passes `state.workspaces` names (`attentionState`). Test in `attentionAnswer.test.ts`.
- No `PROTOCOL_VERSION` bump or `FEATURE_MIN_VERSION`: an older host or daemon drops the field, and the phone just draws no workspace headings, as now. Nothing is stored.

**Why it is its own card.** It crosses `crates/protocol`, the daemon and the Tauri host: a save there relaunches the owner's dev app, and it only reaches a phone after the daemon and the app are rebuilt. That is the owner's to schedule.

**Acceptance.**
- [ ] `cargo test -p protocol` and the desktop suite cover the field both ways (present, absent)
- [ ] With a rebuilt daemon and app, the phone's full inbox heads each workspace by its name
