# Terminal Core — Window Polish

Date: 2026-07-31
Status: Approved

## Context

Follow-up to the just-shipped custom-window-chrome refinement (native title
bar removed, hand-drawn window controls, toolbar folded in). Three small,
independent fixes/features against that chrome and the app's general UI
feel:

1. Rounded window corners — lost when native decorations were removed.
2. Window dragging via the custom title bar's drag region — reported
   broken (confirmed not working at all, not just narrow).
3. Disabling text selection across the UI chrome, while leaving the
   terminal's own selection (already used for `Cmd+C` copy) untouched.

A fourth item from the original request — session resume across app
restarts — was withdrawn during brainstorming: that's existing,
already-shipped behavior (the daemon owns sessions independently of the
GUI app and reattaches on relaunch), not something missing.

## Goals

- The window has visibly rounded corners again, matching the pre-custom-chrome
  native look.
- Dragging any empty part of the custom title bar moves the window, the
  same way dragging a native title bar always has.
- Text in the app's chrome (buttons, tab labels, the title bar, tooltips)
  is not selectable via click-drag. Text rendered inside a terminal pane
  remains selectable exactly as it is today (unaffected — this is a
  chrome-only restriction).

## Non-goals

- Any change to session persistence/resume — confirmed already working,
  out of scope for this round.
- Windows/Linux-specific transparency or drag polish beyond what falls out
  naturally from the macOS-first implementation below — this project
  remains macOS-first; other platforms are best-effort, not verified.
- Any visual redesign of the title bar's contents (icons, button styling,
  layout ordering) beyond what rounding/dragging require — that shipped
  in the prior plan and isn't being revisited here.

## 1. Rounded window corners

**Why they're gone**: native window decorations previously handled corner
rounding as part of the OS-drawn chrome. Setting `decorations: false`
(the prior plan) removed that chrome entirely, including the rounding —
the window is now a plain rectangle.

**Approach**: set `"transparent": true` on the window in
`tauri.conf.json`, making the native window frame itself invisible.
Apply `border-radius` (starting value: `10px`, macOS-typical, easy to
retune once visible) and `overflow: hidden` to the app's root container
(`.app` in `+page.svelte`), which already has an opaque background and
already fills the window in every state (connecting/error/ready/empty) —
so there's no coverage gap where the transparent frame would show through
unrounded content. The corners the user actually sees are the CSS-rounded
corners of that opaque content, sitting inside an invisible native frame.

**Platform scope**: this is the standard, well-established technique for
Tauri custom-chrome apps and needs no additional macOS-specific
configuration (no private-API flag) for the basic transparency + CSS
rounding to render correctly. Windows/Linux transparency has more
historical rough edges (compositor-dependent); per this project's
macOS-first stance, this spec doesn't chase parity there.

## 2. Fix window dragging

**Why it's broken**: the current title bar relies solely on the
`data-tauri-drag-region` HTML attribute on an empty spacer element between
the window controls and the action buttons. That attribute-only mechanism
is known to be unreliable depending on the underlying webview/Tauri
version — which is the most likely explanation for it not working at all
right now, rather than a narrower CSS/layout mistake (the spacer element
itself is present, correctly sized, and correctly placed in the DOM).

**Approach**: add an explicit `onmousedown` handler to the same spacer
element that calls `getCurrentWindow().startDragging()` — a directly
documented Tauri window API, not dependent on attribute-sniffing — guarded
to left-click only (`event.button === 0`) so it doesn't fire on
right-click/middle-click. Keep the existing `data-tauri-drag-region`
attribute in place alongside it (harmless, and may still help on
platforms/versions where it does work); the JS call is the new, more
reliable primary mechanism.

**Capability grant**: `startDragging()` is a window-mutating call, so per
this project's now well-established pattern (verified, never assumed),
the exact permission identifier for it gets checked against the real
generated ACL schema during implementation, not guessed and trusted.

## 3. Disable text selection outside the terminal

**Key finding from investigation**: xterm.js's own text selection —
already relied on by this app's existing `Cmd+C` copy feature
(`clipboard.ts`'s `copySelection()`) — is a self-contained mechanism that
reads from xterm's internal buffer via its own `getSelection()` API, not
the browser's native `window.getSelection()`/CSS `user-select` machinery.
This means a global `user-select: none` should have **no effect** on
terminal copy/selection at all, in principle.

**Approach, defensive rather than assuming the above is airtight**: apply
`user-select: none` globally (on `html`/`body`, alongside the existing
global reset already in `+page.svelte`), and explicitly re-enable it
(`user-select: text`) scoped to xterm.js's own well-known root class
(`.xterm`) inside `TerminalPane.svelte`. This costs nothing, and removes
any risk that some xterm-internal DOM node (e.g. its accessibility helper
elements) turns out to depend on native `user-select` in a way the
investigation above didn't anticipate — belt-and-suspenders instead of
a single, unverified assumption.

## Testing

Consistent with every prior plan in this project: none of these three
changes have meaningful automated-test surface (window transparency,
drag-to-move, and CSS selection behavior are all runtime/visual/interactive
properties). Verification is `cargo build`/`npm run check`/`npm run build`
for the automated floor, and a human at the keyboard for whether the
corners actually look right, dragging actually moves the window, and
selection is actually restricted to the terminal — the same documented,
standing limitation this project has carried since Milestone B.
