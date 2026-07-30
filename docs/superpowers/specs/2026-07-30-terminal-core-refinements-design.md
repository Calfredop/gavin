# Terminal Core — UI/UX Refinements

Date: 2026-07-30
Status: Approved

## Context

Milestone C (split panes — backend and frontend, both parts) just shipped on
`main`. This spec covers a follow-up batch of four refinements requested
against the shipped UI: icons on the split/action buttons, a confirmation
prompt before an action would empty a pane, tabs labeled by the session's
live working directory, and a fully custom window chrome (no OS title bar,
hand-drawn window controls, toolbar folded into that space).

These four items vary a lot in size. Two are small, self-contained UI
tweaks; two require new backend plumbing or new window-chrome architecture.
Per this project's established pattern (Milestone C itself was split into
Part 1/Part 2), this spec covers all four in one document — they're all the
same "polish the shipped split-pane UI" effort — but they become **three
separate implementation plans**, built and reviewed in sequence:

1. **Polish pass** — icons + pane-emptying confirm prompts.
2. **Tab naming via live cwd tracking** — OSC 7 shell integration.
3. **Custom window chrome** — no OS title bar, custom controls, toolbar
   moves into that space.

## Goals

- Toolbar/pane actions use icons (`lucide-svelte`) instead of text labels
  where a text label isn't clearer.
- Any action that would leave a pane with zero tabs — the toolbar's
  explicit "Close Pane", a tab's "×", or `Cmd+W` — prompts for confirmation
  first. Closing a tab that leaves other tabs behind in the same pane stays
  unprompted, exactly as today.
- Each tab's label reflects the *live* working directory of its shell,
  updating as the user `cd`s around — not just the directory the session
  happened to launch in (currently always `$HOME` for every new session).
  Truncated when too long, full path available via a custom-built hover
  tooltip (not the native browser `title=` tooltip).
- No native OS title bar. Custom-drawn window controls (traffic lights on
  macOS, minimize/maximize/close elsewhere), aligned per-OS. The horizontal
  space the OS title bar used to occupy now hosts the toolbar actions.

## Non-goals

- Cross-platform testing/polish beyond writing OS-conditional code paths —
  this project remains macOS-first; Windows/Linux alignment code is written
  and reviewed but not manually verified on those platforms.
- Any change to session/layout persistence, the daemon protocol's
  session-lifecycle commands, or anything else already shipped in
  Milestone C beyond what's described here.
- A settings/preferences UI for any of this (icon set, confirm-prompt
  opt-out, chrome style) — every choice here is a fixed, hardcoded default.
- Detecting/tracking anything about a session's directory beyond what OSC 7
  reports (e.g. no polling fallback for shells that don't emit it — see
  Non-goals under "Tab naming" below for the explicit tradeoff this
  accepts).

---

## 1. Polish pass: icons + confirm prompts

### Icons

New dependency: `lucide-svelte` (tree-shakeable — importing one icon
component only bundles that icon's SVG path data, unlike a webfont/sprite
approach). Covers every icon this refinement batch needs: `Columns2`
(split right), `Rows2` (split down), `X` (tab close / window close),
`Plus` (new tab), `Minus` (window minimize), `Square` (window maximize).
`Toolbar.svelte`'s buttons swap their text labels for icons; where a
label's meaning isn't obvious from an icon alone (the three layout
presets), keep a short text label alongside a representative icon rather
than inventing an icon for "2×2 grid" that nobody would recognize at a
glance.

### Confirm prompts on pane-emptying actions

Three call sites can empty a pane: `Toolbar.svelte`'s "Close Pane" button
(always empties the pane it targets, by definition), a tab's "×" in
`Pane.svelte`, and `Cmd+W` in `keyboard.ts` (both of the latter only empty
a pane when the session being closed is that pane's *last* tab).

Add one pure query to `layout.ts`, alongside `findLeafPath`/`getNodeAtPath`
it already exports:

```typescript
export function isLastTabInPane(tree: LayoutNode, sessionId: string): boolean {
  const path = findLeafPath(tree, sessionId);
  if (!path) return false;
  const leaf = getNodeAtPath(tree, path);
  return leaf.type === "leaf" && leaf.tabs.length === 1;
}
```

Each of the three call sites checks this (or, for "Close Pane", treats
itself as always-true) before acting, and if true, shows a confirm dialog
(`@tauri-apps/plugin-dialog`'s `confirm()`, already a dependency and
already used for the window-close prompt) before calling the existing
`closeSession`/`closePane` action — no changes to those actions themselves,
this is purely a guard at the UI layer, matching where the existing
window-close confirm already lives (`+page.svelte`, not `layoutState.ts`).
Wording: single-tab-empties-pane case says something like "Close this tab?
It's the last one in this pane, so the pane will close too." — the
explicit "Close Pane" button says "Close this pane? N terminal session(s)
will end."

### Testing

`isLastTabInPane` is pure and gets real vitest coverage (single-tab leaf →
true; multi-tab leaf → false; unknown session id → false), matching
`layout.ts`'s existing test discipline. The confirm-dialog wiring itself is
GUI-only, same documented limitation as the rest of this project — no
synthetic-input environment to verify it interactively.

---

## 2. Tab naming via live cwd tracking

### Why OSC 7, and what it costs

OSC 7 is a terminal escape sequence (`ESC ]7;file://<hostname>/<path> ST`
or BEL-terminated) that shell prompts can be configured to emit on every
new prompt, reporting the shell's current working directory. It's what
iTerm2, Windows Terminal, and VS Code's integrated terminal already use for
this exact purpose. The daemon parses it from the PTY output stream —
shell-agnostic from the daemon's point of view, since it's just watching
for a byte pattern, not talking to the shell. This also isn't new territory
for this project: the original terminal-core spec already named "shell
integration escape sequences" as the intended mechanism for a *later*
milestone's status detection (idle/working/waiting-for-input) — this reuses
the same category of mechanism, just for cwd instead of status, ahead of
that later work.

The real cost: it only works if the shell's prompt configuration actually
emits OSC 7. Many modern setups do by default (Starship, several current
Oh My Zsh themes) but a bare, unconfigured shell won't. When no OSC 7 has
ever been seen for a session, its tab falls back to showing its launch
directory (today, always `$HOME` — see Architecture below for exactly how
this fallback works). This spec explicitly does not build a
polling-based fallback (inspecting the PTY's foreground process for its
actual cwd via OS syscalls) — that path is meaningfully more
platform-specific and fragile (it can also report the wrong thing when a
foreground *program*, not the shell itself, has its own different cwd), and
is left as a possible future improvement if OSC 7 coverage proves
insufficient in practice.

### Architecture

**Daemon (`crates/daemon`):** `SessionSummary`/the registry's session
record already carry a `cwd: String` field (added in Milestone A) — today
it's set once, at `CreateSession` time, and never updated. This refinement
makes it live: the PTY-output relay loop (`server.rs`, the thread that
reads PTY output, buffers it, and forwards `Response::Output` to attached
writers) gains a small per-session OSC 7 scanner. Because PTY reads don't
align with escape-sequence boundaries, the scanner needs to buffer a
partial match across chunks (an OSC-open `ESC ]7;` seen at the end of one
read, terminated by ST/BEL at the start of the next) — a small,
purpose-built state machine watching only for this one sequence, not a
general ANSI parser. Everything read from the PTY, OSC 7 sequences
included, is still forwarded to the frontend unchanged — real terminal
emulators (xterm.js included) silently consume unrecognized OSC sequences
rather than rendering their raw bytes, so passing them through is safe and
requires no stripping.

When the scanner completes a match, it URL-decodes the path portion,
updates that session's `cwd` in the registry (the same persisted field,
reused — not a new column), and emits a new event,
`Response::CwdChanged { id: String, cwd: String }`, over the streaming
connection — mirroring exactly how `Output`/`SessionExited` are already
emitted per-session-id today. No protocol request changes; this is purely
a new response variant plus the existing `cwd` field's write-path changing
from "set once" to "set once, then updated."

The frontend has no existing way to learn any session's cwd —
`get_current_layout()`'s `LayoutNode` only carries session ids, never
metadata, and `ListSessions`/`SessionSummary` are internal, daemon-facing
types never exposed as a Tauri command. Rather than adding a new command
just to seed an initial value, the daemon sends one `CwdChanged` for a
session's *current* known cwd (whatever's already in the registry, launch
directory or a previously-seen OSC 7 value) immediately whenever it
processes an `Attach` request for that session — which already happens
exactly once per session at startup (for every session in the resolved
tree) and once per freshly created session (`create_session`'s own
`Attach` call, added by Milestone C Part 2's final-review fix). This
reuses the existing event pipe for both "give me a baseline" and "tell me
about a live update," rather than introducing a second, parallel path for
the same information.

**Tauri backend (`app/src-tauri`):** the reader thread that already relays
`Output`/`SessionExited`/`Error` as Tauri events gains one more case,
emitting a `"cwd-changed"` event with payload `[session_id, cwd]`, same
shape convention as the existing per-session events.

**Frontend (`app/src`):** `layoutState.ts` gains a `cwdBySessionId: Record<string, string>` field on its store, starting empty and populated entirely by `"cwd-changed"` events — including the synthetic baseline one every `Attach` now triggers — via a new listener registered alongside the existing three in `bootstrap()`. No separate seeding call is needed; the same `FrontendReady`-gated ordering that already makes scrollback replay safe covers this too. `Pane.svelte`'s tab label reads
`$layoutState.cwdBySessionId[sessionId]`, falls back to the session id's
short form if absent (mirrors today's `sessionId.slice(0, 8)` placeholder),
shows the *last path segment* (folder name, not the whole path) as the
visible label, truncated with an ellipsis via CSS `text-overflow` if the
segment itself is unusually long, and wraps the tab in a new
`Tooltip.svelte` component (a small, from-scratch hover tooltip — a
floating positioned panel shown after a short hover delay, not the native
`title=` attribute, per the request) displaying the full path.

### Testing

The OSC 7 scanner's chunk-boundary-buffering logic is exactly the kind of
thing that looks right and silently breaks on a real PTY's arbitrary read
boundaries — it gets real Rust unit tests feeding it byte sequences split
at every possible boundary (whole sequence in one chunk; split before the
`ESC`; split mid-sequence at several different points; split at the
terminator). The `cwdBySessionId` store-update logic gets a vitest test
with a mocked `"cwd-changed"` event, matching `layoutState.test.ts`'s
existing style. `Tooltip.svelte` and the tab-label truncation/rendering are
GUI-only, same documented limitation as the rest of this project.

---

## 3. Custom window chrome

### Approach

`app/src-tauri/tauri.conf.json`'s window config gets `"decorations": false`
(removes the OS title bar entirely, on every platform). A new
`TitleBar.svelte` component replaces the space it used to occupy: a
full-width bar, marked as a drag region (`data-tauri-drag-region`, so the
user can still move the window by dragging empty space in it) containing,
in order:

- **Window controls**, OS-conditionally positioned: macOS gets three
  circular buttons (close/minimize/maximize, red/yellow/green, left-aligned
  — the traffic-light convention) with lucide's `X`/`Minus`/`Square` icons
  revealed on hover (mirroring the native macOS behavior of icons only
  appearing on proximity, done in CSS); everything else gets
  minimize/maximize/close as square icon buttons, right-aligned, Windows
  convention. OS is detected via `@tauri-apps/plugin-os`'s `platform()`
  (new dependency — the only reliable way to know the OS from the
  frontend; a `navigator.userAgent` sniff would be fragile). Wired to
  `getCurrentWindow().minimize()` / `.toggleMaximize()` / `.close()` (the
  last one goes through the *existing* `onCloseRequested` confirm-dialog
  interception already built for the always-shown-native-chrome case — no
  behavior change there, just a different button triggering the same
  `CloseRequested` event).
- **Toolbar actions** (the icon buttons from the Polish pass section, plus
  the presets menu) fill the rest of the bar's width, positioned on
  whichever side doesn't hold the window controls (opposite side from
  macOS's left-aligned traffic lights; same side as, but visually
  separated from, the right-aligned controls elsewhere).

`+page.svelte` mounts `TitleBar` above the existing `LayoutTree`, and the
current `Toolbar.svelte` component is retired — its buttons move into
`TitleBar.svelte` directly, since it no longer makes sense as a
free-floating separate bar once the window chrome and the action bar are
the same strip.

**Capability grants**: window minimize/maximize are, per the lesson learned
twice already in this project (window close/destroy in Milestone B,
clipboard read/write in Milestone C Part 2), not something to assume
`core:default` covers — verified against the compiled ACL, not guessed,
same as those two precedents, when this gets implemented.

### Testing

`tauri.conf.json`'s `decorations:false` and the capability grants get
verified by `cargo build` + reading the generated ACL, same pattern as
prior capability work. The rest — does dragging the bar actually move the
window, do the three window-control buttons actually minimize/maximize/
close, does OS-conditional alignment render correctly — is GUI-only, same
documented limitation as the rest of this project, and specifically
important to flag for manual testing here since it's the one refinement in
this batch that changes how the window itself behaves (a bug here is more
disruptive than a bug in a tab label).

## Error handling

- OSC 7 parse failures (a malformed or partial-forever sequence) are
  silently ignored — the tab just keeps showing its last-known cwd (or the
  launch-directory fallback); this is a "nice to have" label, not
  load-bearing state, so failing open (no update) rather than surfacing an
  error is correct.
- A `cwd-changed` event for a session id the frontend doesn't currently
  know about (e.g. arrives in a narrow window before `bootstrap()`'s
  listeners are registered) is dropped the same way `pty-output`/
  `session-exited` already tolerate unknown ids today — no new handling
  needed, this reuses an existing, already-hardened pattern.
- Confirm-dialog cancellation (Polish pass) simply aborts the action —
  no partial state change, matching how the existing window-close confirm
  already behaves.

## Testing (cross-cutting)

Per this project's established, documented limitation: anything requiring
synthetic keyboard/mouse/window input has no automated coverage in the
agent environment and needs a human at the keyboard. Everything that's
pure logic (the `isLastTabInPane` query, the OSC 7 byte-scanner, the
`cwdBySessionId` store update) gets real automated tests, following the
same split this project has used throughout Milestone C.
