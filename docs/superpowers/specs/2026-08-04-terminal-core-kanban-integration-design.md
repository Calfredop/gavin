# Terminal Core — Kanban Integration Layer — Design Spec

## Context

Roadmap item 4 ("Integration layer — linking kanban cards to terminal
sessions, launching/switching sessions from cards") has always been a
one-sentence placeholder, and the kanban board's own just-shipped design
spec explicitly named it as deferred: "Linking cards to terminal sessions
(launching/switching sessions from a card)... Cards are plain data in this
milestone, with no session association."

This spec designs that link. A card can now point at a terminal session —
either one that already exists, or a fresh one created (optionally with a
specific command and working directory) right from the card. The link
survives the session exiting: the card remembers enough to re-launch, and
shows the session's live status.

## Goals

- A card can reference at most a session it's aware of, but a session can
  be referenced by more than one card — no exclusivity enforcement.
- From a card's detail modal: link to an existing session (scoped to the
  current workspace's own sessions), or create a new one — optionally with
  a specific command and working directory (blank = default shell at
  `$HOME`, matching today's "+ New Tab" behavior).
- If the workspace has zero pages when a new session needs a home, one is
  auto-created first (the existing `createPage` action, default preset),
  then the session is added as a tab to the workspace's active page — the
  same place "+ New Tab" already adds a session, not a dedicated
  page-per-card concept.
- A linked card shows the session's live status (idle/working/
  waiting-for-input/exited) as a small dot on the card face, reusing
  `Pane.svelte`'s existing status-dot styling and `sessionStatusById`.
- From the detail modal, a linked card can: **jump to** the session
  (switches out of the hub back to Terminal, switches to whichever
  workspace/page currently hosts it, and focuses it), **re-launch** it
  (only once it has exited — starts a fresh session with the remembered
  command/cwd, replacing the link's `sessionId`), or **unlink** it
  (discards the link, never touches the running session, no prompt).
- Deleting a card that has a linked, still-running session prompts first
  — "delete the card and kill its session too?" — mirroring the existing
  `confirmWorkspaceClose`/`confirmPageClose` pattern. Skipped entirely if
  the linked session has already exited (nothing to kill).

## Non-goals

- Session exclusivity (preventing the same session from being linked to
  multiple cards) — not required by anything described here.
- A quick-jump affordance directly on the card face — jumping/re-launching/
  unlinking all live inside the detail modal (opened by clicking the card,
  exactly as today); the card face only *shows* state via the status dot,
  it doesn't act on it. Simpler, consistent with how priority/labels
  already work on the card face.
- Any change to how sessions are created for non-card purposes ("+ New
  Tab", "+ New Page") beyond the two new *optional* parameters this spec
  adds to `create_session` — every existing caller keeps working unchanged
  by simply omitting them.
- Linking a card to more than one session, or a session to a specific
  column/board beyond the existing per-workspace board scoping kanban
  already has.

## Architecture

### 1. Data model & protocol

`Card` (`app/src/lib/kanban.ts`) gains one new optional field:

```ts
export interface SessionLink {
  sessionId: string;        // the currently-linked session (may have exited)
  cwd: string;               // remembered launch location, for re-launch
  command: string | null;    // remembered launch command, for re-launch (null = default shell)
}

export interface Card {
  // ...existing fields unchanged...
  sessionLink?: SessionLink;
}
```

Optional, matching the established pattern (`Workspace.activeView?`) that
avoids breaking every test file constructing a `Card` literal directly.

Since `Card` already round-trips through the daemon via `GetBoard`/
`SetBoard`, `crates/protocol`'s `Card` struct gains a matching field:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionLink {
    pub session_id: String,
    pub cwd: String,
    pub command: Option<String>,
}

// Card gains:
pub session_link: Option<SessionLink>,
```

`crates/daemon/src/kanban.rs`'s SQLite schema gains three new nullable
columns on `kanban_cards` (`session_link_session_id`, `session_link_cwd`,
`session_link_command`) rather than a side table — a card has at most one
link, so a side table would only ever hold zero or one row per card, no
real relational benefit over inline nullable columns.

### 2. Creating and managing the link (frontend)

`CardDetailModal.svelte` gains a new "Session" section:

- **No link yet**: "Link existing session" (a dropdown of session ids
  scoped to the current workspace, via the existing
  `allSessionIdsInWorkspace` helper, each labeled with its existing
  `sessionLabel()` display name) or "Create new session" (reveals optional
  `command` and `working directory` text fields).
- **Already linked**: shows the linked session's current status (reusing
  `sessionStatusById`) and cwd, plus three actions:
  - **Jump to session**: `switchToSessionInPage(workspaceId, pageId,
    sessionId)` needs a `workspaceId`/`pageId` the link doesn't store (only
    `sessionId` is remembered — caching the other two would go stale the
    moment a tab is dragged to a different page, exactly the kind of
    staleness bug this project has hit before). A new pure helper,
    `findSessionLocation(state, sessionId): { workspaceId, pageId } | null`
    (`app/src/lib/workspace.ts`), searches every workspace's every page's
    `allSessionIds(page.layout)` fresh at click time — cheap, and never
    stale. If found: `switchWorkspaceView(workspaceId, "terminal")` first
    (exiting the hub — mirroring exactly how the sidebar's own page/session
    click handlers already pair this call before switching), then
    `switchToSessionInPage(workspaceId, pageId, sessionId)`. If not found
    (the session exited and no longer appears in any page — the normal
    case once a session ends), "Jump to session" is simply disabled; the
    status dot already shows the session as exited.
  - **Re-launch**: enabled exactly when `findSessionLocation` returns
    `null` for the linked `sessionId` (the same "gone" check "Jump to
    session" uses to disable itself — the two actions are complementary,
    never both enabled at once). Calls the new session-creation path
    (below) with the link's own remembered `cwd`/`command`, then updates
    `sessionLink.sessionId` to the fresh id.
  - **Unlink**: clears `sessionLink`. No prompt — the running session (if
    any) is untouched, only the card's own reference is discarded.

### 3. Session creation with options

The existing `create_session` Tauri command
(`app/src-tauri/src/session.rs`) takes no parameters today — it always
calls `create_fresh_session(&command_state.0, None)`, hardcoded to
`$HOME`, no command. This spec extends it with two optional parameters:

```rust
#[tauri::command]
pub fn create_session(
    cwd: Option<String>,
    command: Option<String>,
    command_state: State<CommandConnection>,
    daemon_state: State<DaemonConnection>,
) -> Result<String, String> {
    let id = create_fresh_session(&command_state.0, cwd.as_deref(), command.as_deref())
        .map_err(|e| e.to_string())?;
    send_request(&daemon_state.writer, &Request::Attach { id: id.clone() }).map_err(|e| e.to_string())?;
    Ok(id)
}
```

`create_fresh_session`'s own signature grows a `command: Option<&str>`
parameter alongside its existing `cwd: Option<&str>`, threading straight
through to the daemon's `Request::CreateSession { command, .. }` field
(already `Option<String>` on the wire — this was always supported
daemon-side, just never exposed through this particular Tauri command).
Every existing caller (today's "+ New Tab"/"+ New Page" flows) passes
`None`/`None` for both, preserving current behavior exactly.

If the workspace has zero pages, `createPage` (existing action, default
single-pane preset) runs first; the new session is then added as a tab to
the workspace's active page via the existing `addTab`-equivalent flow —
the same place "+ New Tab" already adds a session.

### 4. The card face

`KanbanCard.svelte` shows a small status dot (reusing `Pane.svelte`'s
existing dot styling) next to the priority dot whenever `card.sessionLink`
is set, reading `$layoutState.sessionStatusById[card.sessionLink.sessionId]`
— `undefined`/exited reads as a distinct, dimmer state from a live
idle/working/waiting-for-input session. Purely visual; no click handler of
its own (the whole card's existing `onclick` already opens the detail
modal, where the real actions live).

### 5. Delete-card-with-linked-session prompt

Reuses the existing `Modal.svelte` primitive with a simple yes/no choice
(not the richer delete-or-move column prompt), mirroring
`confirmWorkspaceClose`/`confirmPageClose`'s existing phrasing convention.
Only shown when `findSessionLocation` (section 2) finds the linked session
still present in *some* page — not necessarily the card's own workspace,
since a tab can be dragged across workspaces after linking — an
already-exited link (not found anywhere) skips the prompt, since there's
nothing to kill.

## Testing

- **Protocol**: roundtrip + shape-assertion tests for `SessionLink` and
  `Card`'s new `sessionLink` field, matching this project's established
  precedent (a roundtrip alone isn't enough — assert the exact camelCase
  JSON shape too).
- **Daemon** (`crates/daemon/src/kanban.rs`): SQLite persistence tests for
  the three new nullable columns, including the "card has no link" (all
  three columns `NULL`) case.
- **App/Tauri**: a test confirming `create_session` with both parameters
  omitted still creates a session at `$HOME` with no command (guards
  against a regression in every existing caller), plus a test confirming
  explicit `cwd`/`command` values are threaded through to the daemon
  request correctly.
- **Frontend** (`kanban.ts`): pure mutation-logic tests for `linkSession`,
  `unlinkSession`, and `updateSessionLink` (the re-launch case, replacing
  just the `sessionId` while preserving `cwd`/`command`), mirroring this
  project's existing pure-logic-with-vitest precedent.
- **Frontend** (`workspace.ts`): pure tests for `findSessionLocation` —
  finds a session in its own workspace, finds one after it's moved to a
  different workspace, returns `null` for a session that's exited/not
  present in any page.
- **Not automated**, matching this project's consistent limitation across
  every prior milestone: the modal's new Session section, the jump-to-
  session flow, the status dot rendering, and the delete-with-link prompt
  all need a manual GUI smoke test rather than an automated one.
