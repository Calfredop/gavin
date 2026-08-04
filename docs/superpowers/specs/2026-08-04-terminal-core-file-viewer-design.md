# Terminal Core — File Viewer — Design Spec

## Context

Roadmap item 3 ("File viewer — internal viewer for text/markdown/code,
images, and video, implemented as a new pane-leaf type alongside terminal
panes") has always been a one-sentence placeholder, deliberately deferred
out of the original terminal-core spec so that spec could stay finalized
as-is.

This spec designs it. A file opens as a new pane-leaf tab, read-only,
alongside terminal tabs, triggered by cmd+clicking a path or URL directly
in terminal output — no separate "open file" affordance is needed, since
the paths that matter are almost always ones an agent or shell command
just printed.

## Goals

- **Scope for v1: text, markdown, and code files only.** Markdown renders
  as formatted HTML; everything else in scope renders as syntax-highlighted
  plain text. Images, video, and any other file type open in the user's
  default OS application instead — the roadmap's original four-type list is
  narrowed, since video in particular would add real rendering complexity
  for the least common case in a coding workflow, without blocking anything
  the rest of this design needs.
- **Opened via cmd+click on a path or URL inside terminal output.** A URL
  opens in the default browser (external). A path that resolves to a
  supported file type opens internally, as a **new split** in the pane you
  clicked from (side-by-side with the terminal, not replacing it). A path
  that resolves to an out-of-scope file type opens externally, same as a
  URL. Only genuinely resolvable paths become clickable — hovering
  path-shaped text triggers an existence check before it gets the clickable
  underline, so there are no dead-end clicks.
- **Read-only, with live-reload.** The viewer never edits or saves; it
  watches the open file and refreshes automatically when it changes on
  disk (e.g. an agent edits it while you're looking).
- **A file tab behaves like a terminal tab** for every tab-management
  gesture this app already has: reorder within a pane, drag across
  panes/pages/workspaces, close, and persist across app restarts (the tab
  reopens on relaunch and re-reads the file fresh). Two differences: a
  file tab's label is always the file's actual name, not renameable —
  unlike a terminal tab's cwd-derived guess, the filename is exact, known
  information a custom label wouldn't improve on — and closing a file tab
  never triggers a confirmation prompt, unlike closing a terminal tab/pane/
  page/workspace with live sessions in it (see Architecture section 5).
- **No daemon involvement.** Unlike a terminal session, a viewed file
  doesn't need to survive the app closing — there's nothing that needs
  independent persistence the way a PTY does. Reading and watching files
  happens entirely in `app/src-tauri`.
- **A size cap**, to avoid freezing the renderer on something huge (e.g. a
  multi-GB log file). Above the cap, the viewer shows a clear "too large to
  preview" message with an option to open externally instead of attempting
  to render a partial, useless view.

## Non-goals

- Editing or saving. This is a viewer, matching the roadmap's own framing.
- Images, video, or any file type beyond text/markdown/code, for v1 — these
  always open externally instead.
- A dedicated "open file" UI (toolbar button, drag-and-drop from the OS, a
  file picker). Cmd+click on already-visible terminal output is the only
  entry point this spec designs; a picker-based flow can be added later
  without touching anything designed here.
- Any daemon protocol changes. `crates/daemon` and `crates/protocol` are
  untouched by this spec entirely.

## Architecture

### 1. Data model: tabs stay `string[]`, a parallel map carries file metadata

The roadmap's own note assumed the pane-tree's `LayoutNode.leaf.tabs`
(currently `string[]`, implicitly a list of session ids) would need to
become a tagged union directly in the tree, generalizing `{type: "leaf",
session_id}` to also carry a file-viewer kind. Looking at the actual
code, that's not the right move: `tabs` is read as bare string ids
throughout `layout.ts` (`findLeafPath`, `switchTab`, `closeTab`,
`moveTabWithinLeaf`, `addTab`, `splitLeaf`, `graftLeaf`/`graftLeafAt`),
every drag-and-drop payload in `dragDrop.ts`, and `confirmClose.ts` — none
of that logic cares what a tab *is*, only that it's a unique string. Making
the array's element type a tagged union would force every one of those
functions to branch on kind, for zero behavioral benefit.

Instead, **`tabs` stays `string[]`, completely unchanged.** A file tab gets
a freshly generated id (`crypto.randomUUID()`, exactly like a session id)
— just as opaque as a session id, and just as capable of appearing more
than once if the same file is opened in two different tabs. A new parallel
map carries the one extra thing a file tab needs:

```ts
// app/src/lib/workspace.ts (or a new small file-tabs.ts if it grows) --
// mirrors sessionStatusById/cwdBySessionId/gitStatusById/sessionNames:
// "extra info about a tab, keyed by its id, that doesn't belong in the
// tree itself." Never cleaned up when a tab closes, matching those same
// maps' own established convention (not a meaningful memory concern).
export interface FileTab {
  path: string;
}
```

`LayoutState` (`layoutState.ts`) gains `fileTabsById: Record<string,
FileTab>`. `Pane.svelte`'s render loop (`{#each leaf.tabs as tabId}`)
gains exactly one new branch: `fileTabsById[tabId] ? <FileViewerPane
path={fileTabsById[tabId].path} ...> : <TerminalPane sessionId={tabId}
...>`. `layout.ts` itself needs zero changes.

`Priority`-only functions elsewhere still need kind-awareness: anything
that currently assumes "every tab id is a session id" (killing a session
on close, `cwdBySessionId` lookups, the close-confirmation dialogs'
session-count messages) checks `tabId in fileTabsById` first and skips the
session-specific step for file tabs.

**Persistence:** since the tree's shape is unchanged, `config.json`'s
`layout` field needs no schema change at all. A new top-level `file_tabs:
HashMap<String, String>` (tab id → path) is added to `AppConfig`
(`app/src-tauri/src/config.rs`), loaded/saved by the same `config::load`/
`config::save` already used for everything else. Bootstrap's session
reconciliation (`resolve_sessions` in `app/src-tauri/src/session.rs`)
gains one check: a tab id found in the persisted `file_tabs` map is a file
tab, not a stale/missing terminal session — skip it entirely rather than
trying to replace it with a fresh `create_session` call.

### 2. Path and URL detection: cmd+click in terminal output

Two independent detection mechanisms, both gated on the click carrying the
cmd (macOS) modifier:

- **URLs**: `@xterm/addon-web-links` (new dependency — a small, official
  xterm addon, matching the precedent already set by `@xterm/addon-fit`).
  Configured so its `activate` handler only fires when
  `event.metaKey` is set, it hands the URL to `tauri-plugin-opener`
  (already a dependency) to open in the default browser.
- **Filesystem paths**: no official addon exists for this, so a custom
  matcher is registered via xterm's `registerLinkProvider` API. A
  path-shaped regex (absolute `/...`, home-relative `~/...`, or a relative
  path containing at least one `/` and an extension-like suffix, to cut
  down false positives on ordinary prose) finds candidates in each
  rendered line. On hover, a new Tauri command resolves the candidate
  against the session's own live cwd (already tracked via
  `cwdBySessionId`, kept current by the existing OSC 7 plumbing) and
  checks existence:

  ```rust
  #[tauri::command]
  pub fn resolve_path_under_cursor(candidate: String, cwd: String) -> Option<String>
  ```

  Only a path that resolves to something real gets the clickable
  underline. On cmd+click: a resolved path with a supported extension
  (`.txt`, `.md`, `.markdown`, and a fixed list of common code extensions —
  enumerated in the implementation plan, not this spec) opens internally as
  a new split via the existing `splitPane`-style tree mutation, seeded with
  a fresh file-tab id and a `fileTabsById` entry instead of a fresh
  session. Anything else (including files with no recognized extension —
  treated as unsupported rather than guessed at) is handed to
  `tauri-plugin-opener` for the OS's default handler, identically to a URL.

### 3. Reading and watching files (no daemon)

Two new Tauri commands in `app/src-tauri`, both operating purely on the
local filesystem — no daemon round-trip:

```rust
#[tauri::command]
pub fn read_file_for_viewer(path: String) -> Result<FileContent, String>
// FileContent { content: String, truncated: bool }
```

Reads up to a fixed size cap (1 MiB — generous for source/markdown files,
small enough to never freeze the renderer; the exact constant is an
implementation-plan detail). A file larger than the cap returns what fits
with `truncated: true`; the frontend shows a "too large to preview in
full" notice alongside an "Open externally" button rather than silently
showing a partial file. A file whose bytes aren't valid UTF-8 at all
(binary content) returns an error the frontend treats identically to an
unsupported extension — hands off to the external app rather than
rendering binary garbage.

```rust
#[tauri::command]
pub fn watch_file_for_viewer(path: String) -> Result<(), String>
```

Uses `notify`/`notify-debouncer-mini` (new dependencies in
`app/src-tauri/Cargo.toml` — not shared with `crates/daemon`, which is a
separate binary; but the exact same crates and debounced-watch pattern
already proven by the daemon's own git-status `RepoPoller`). Emits a
`file-changed` event carrying the file's path, mirroring the
`pty-output`/`git-status-changed` relay idiom already established for
every other Tauri-event-driven update in this app. Each open file tab
starts its own independent watcher (no sharing or ref-counting needed here
— unlike `RepoPoller`, two tabs viewing the same file just get two
watchers) and it's torn down when that specific tab closes, via a matching
`unwatch_file_for_viewer(path)` command.

### 4. The viewer itself

A new `FileViewerPane.svelte`, dispatched from `Pane.svelte` exactly like
`TerminalPane.svelte` is today (same `visible`/mount-once-persist-across-
remounts shape, minus any focus/input handling, since this is read-only).
On mount, calls `read_file_for_viewer` and `watch_file_for_viewer`;
listens for this file's `file-changed` events and re-reads on each one.

Rendering, by extension:
- **Markdown** (`.md`, `.markdown`): rendered via `marked` (new
  dependency) to HTML, sanitized through `DOMPurify` (new dependency)
  before insertion — local files are presumably the user's own, but
  sanitizing untrusted-shaped content before rendering as HTML is cheap
  and standard practice regardless of source.
- **Everything else in scope** (plain text, code): syntax-highlighted via
  `highlight.js` (new dependency) inside a `<pre>`, with the language
  guessed from the file extension (falling back to plain, unhighlighted
  text for an unrecognized extension that's still valid UTF-8 — still
  viewable, just not colorized).

Two small purpose-built libraries rather than a heavier embedded-editor
component like CodeMirror, matching this project's existing preference for
minimal dependencies (xterm.js itself is used directly, with no larger
framework layered on top).

An unsupported extension, a too-large file, or a failed read all show the
same small inline error/fallback state (reusing `KanbanBoard.svelte`'s
existing "Couldn't load..." visual convention for consistency across the
app), each with an "Open externally" button wired to `tauri-plugin-opener`
— the same fallback the cmd+click flow itself uses when it decides not to
open something internally in the first place.

### 5. Tab lifecycle and close-confirmation scope

Closing a file tab reuses `closeTab` (`layout.ts`) completely unchanged,
plus calling `unwatch_file_for_viewer` for that tab's path.
`fileTabsById`'s entry for that id is left in place afterward (never
cleaned up), matching `cwdBySessionId`/`sessionNames`/`sessionStatusById`'s
own established convention. Reordering a file tab within a pane and
dragging it across panes/pages/workspaces need zero changes to
`dragDrop.ts` — both already operate purely on bare tab ids, agnostic to
what a tab represents.

A keyboard- or toolbar-driven split (`Cmd+D`/`Cmd+Shift+D`) always creates
a new **terminal** tab, unchanged from today — "split" stays a general
pane-tree operation, not something that generalizes to file viewing. Only
the cmd+click-on-a-path flow (section 2) creates a split specifically to
view that file.

`confirmTabClose`/`confirmPaneClose`/`confirmPageClose`/
`confirmWorkspaceClose` (`confirmClose.ts`) all warn specifically about
ending live terminal sessions ("N terminal sessions will end"). File tabs
don't count toward that language at all, and don't trigger their own
confirmation — closing one costs nothing, since the file itself is
untouched and reopening it is one cmd+click away. A pane/page/workspace
that happens to include file tabs alongside terminal tabs just silently
closes the file tabs too, with whatever terminal-session warning already
applies (or none, if there are no terminal sessions involved) unchanged.

## Testing

- **Pure logic**: any new `fileTabsById`-related functions in
  `workspace.ts`/`layoutState.ts` get the same mocked-`backend` Vitest
  coverage this codebase already applies to every other piece of
  `layoutState.ts` orchestration.
- **Rust** (`app/src-tauri`): unit tests for `read_file_for_viewer` (normal
  read, truncation at the size cap, non-UTF8/binary rejection,
  file-not-found), `resolve_path_under_cursor` (exists, doesn't exist,
  resolved relative to a given cwd), and `watch_file_for_viewer` (a
  debounced write triggers exactly one `file-changed` emission), all using
  `tempfile`-created fixtures — matching this project's established Rust
  testing convention throughout `session.rs`/`kanban.rs`/`git_status.rs`.
- **Not automated**, matching this project's consistent GUI-only
  limitation for every prior UI milestone: the xterm link provider's
  actual hover/click behavior, cmd+click end-to-end (URL → browser, path →
  internal split or external app), the rendered `FileViewerPane`'s
  syntax-highlighted/markdown output, and live-reload's visual refresh on
  an external file change — all need a manual GUI smoke test instead.
