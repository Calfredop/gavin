# Keyboard Shortcuts & Hold-⌘ Hints — Design Spec

**Goal:** quick-navigation shortcuts for pane tabs, workspace hub tabs, sidebar
pages and sidebar workspaces; a hint overlay that appears while the command key
is held; and shortcut hints inside the existing button tooltips.

**Out of scope:** a user-editable keymap, a shortcuts cheat-sheet modal, a
custom native macOS menu, shortcuts for kanban / plan-tree / git surfaces,
sequence ("chord") shortcuts, and ⌘Q as close-tab (see Decision K1).

---

## Decisions

- **K1 — ⌘Q is not bound.** ⌘Q is macOS's system Quit and the app installs no
  custom menu, so Tauri's default menu owns it; binding it to close-tab would
  either not fire or fire alongside Quit. Tab close stays **⌘W**, which already
  exists and already skips pinned tabs.
- **K2 — number mapping.** `⌘1`–`⌘8` select positions 1–8, `⌘9` selects the
  **last** item, `⌘0` selects the **first**. Out-of-range digits do nothing.
- **K3 — modifier per platform.** "⌘" means `metaKey` on macOS and `ctrlKey` on
  Windows/Linux, for every shortcut in this spec. The pre-existing ⌘C/⌘V
  (terminal copy/paste) stay **macOS-only** on `metaKey`: on Linux/Windows,
  Ctrl+C in a terminal must remain SIGINT.
- **K4 — digits match on `event.code`, letters keep matching `event.key`.** On
  macOS ⌘⇧1 reports `key: "!"` and ⌘⌥1 reports `key: "¡"`, so digit navigation
  must read `code` (`Digit1`/`Numpad1`). Letters have no such problem under the
  modifiers this spec uses, and matching them on `code` would silently rebind
  them to physical key positions on non-QWERTY layouts — so ⌘T/⌘W/⌘D keep
  comparing `event.key.toLowerCase()`, exactly as the app does today.

---

## 1. Platform layer

`app/src/lib/platform.ts` keeps its async `isMacOS()` and gains a cached
synchronous view of the same fact, because keydown handlers cannot await:

```ts
export function initPlatform(): Promise<void>   // called once from bootstrap
export function isMacSync(): boolean            // false until initPlatform resolves
export function cmdHeld(e: KeyboardEvent | { metaKey: boolean; ctrlKey: boolean }): boolean
```

`cmdHeld` is `metaKey` on macOS, `ctrlKey` otherwise. Before `initPlatform`
resolves, `isMacSync()` is `false`; the window is a few milliseconds at startup
and the failure mode is a Ctrl-instead-of-⌘ match, not a crash.

## 2. `app/src/lib/shortcuts.ts` — pure chord model

```ts
export interface Chord {
  /// Lower-case KeyboardEvent.key, e.g. "t", "d" (see K4).
  key: string;
  shift?: boolean;
  alt?: boolean;
}

export const SHORTCUTS: Record<ShortcutId, Chord>;
export type ShortcutId =
  | "new-tab" | "close-tab" | "split-right" | "split-down";

export function matchesChord(e: KeyboardEvent, chord: Chord, isMac: boolean): boolean;
export function formatChord(chord: Chord, isMac: boolean): string;
export function formatShortcut(id: ShortcutId, isMac: boolean): string;
/// 0-9 from "Digit3" / "Numpad3"; null for any other code.
export function digitFromCode(code: string): number | null;
/// K2: 1-8 -> index digit-1 (null when beyond count), 9 -> last, 0 -> first.
/// null for an empty list.
export function resolveIndex(digit: number, count: number): number | null;
```

`matchesChord` requires `cmdHeld`, the exact `key`, and exact `shift`/`alt`
state (an undeclared modifier must be **off**, so ⌘⇧1 never triggers the plain
⌘1 action). `formatChord` produces `⌘T`, `⌘⇧D`, `⌘⌥1` on macOS and `Ctrl+T`,
`Ctrl+Shift+D`, `Ctrl+Alt+1` elsewhere; digits render as the digit, letters
uppercased.

Registered chords: `new-tab` = ⌘T, `close-tab` = ⌘W, `split-right` = ⌘D,
`split-down` = ⌘⇧D. Number navigation is not in the registry — it is a family,
handled by `digitFromCode` + `resolveIndex`.

## 3. Bindings and routing (`keyboard.ts`)

| Chord | Scope | Action |
|---|---|---|
| ⌘T | session page | `addTab` *(existing)* |
| ⌘W | session page | close focused tab, pinned-safe *(existing)* |
| ⌘D / ⌘⇧D | session page | `splitPane` row / column *(existing)* |
| ⌘C / ⌘V | session page, macOS only | terminal copy / paste *(existing)* |
| ⌘1–8, ⌘9, ⌘0 | session page (`activeView === "terminal"`) | switch tab **within the focused pane's leaf** |
| ⌘1–8, ⌘9, ⌘0 | workspace page (any hub view) | switch hub tab, over `visibleHubViews(...)` in its rendered order |
| ⌘⇧1–8, ⌘⇧9, ⌘⇧0 | anywhere | switch page of the active workspace (`switchPage`) |
| ⌘⌥1–8, ⌘⌥9, ⌘⌥0 | anywhere | switch workspace (`switchWorkspace`) |

**Ordering must match what the user sees.** Hub tabs use
`visibleHubViews(workspaceId, import.meta.env.DEV, hasRoot)`; pages use
`workspace.pages` order; workspaces use the sidebar's order — **Unfiled first,
then the rest** (`Sidebar.svelte:110-111`), not raw `state.workspaces` order.
This ordering lives in one exported helper so the hint badges and the routing
cannot disagree:

```ts
// workspace.ts
export function sidebarWorkspaceOrder(workspaces: Workspace[]): Workspace[];
```

**Guard change.** `handleKeydown` currently returns early unless
`state.focusedSessionId` is set. Only the letter shortcuts need a focused
session; digit navigation must work with no terminal focused (a hub view is on
screen, or the workspace has no sessions). The guard moves into the letter
branch.

All handled events call `preventDefault()` and `stopPropagation()`, as the
existing branches do, and the listener stays on the **capture** phase (xterm
stops propagation before a bubble listener would see it).

## 4. Hold-⌘ hints

`app/src/lib/shortcutHints.ts`:

```ts
export type HintMode = "cmd" | "cmd-shift" | "cmd-alt";
export const hintMode: Readable<HintMode | null>;
export function installHintTracking(): () => void;
export const HINT_HOLD_MS = 500;

/// Pure reducer, unit-tested without a DOM.
export type HintEvent =
  | { type: "modifier-state"; cmd: boolean; shift: boolean; alt: boolean }
  | { type: "other-key" }
  | { type: "hold-elapsed" }
  | { type: "blur" };
export interface HintState { armed: boolean; cancelled: boolean; mode: HintMode | null }
export function reduceHint(state: HintState, event: HintEvent): HintState;
```

Behaviour:

- Pressing the command key **alone** arms a `HINT_HOLD_MS` timer. When it
  elapses the mode becomes `cmd`, or `cmd-shift` / `cmd-alt` if that modifier is
  also down.
- While shown, pressing or releasing Shift/Alt switches the mode live, so the
  badges always describe what would fire right now.
- Any non-modifier keydown **cancels** the hold: ⌘T typed quickly never flashes
  hints. The cancel lasts until the command key is released.
- Releasing the command key, `window.blur`, or `document.visibilitychange` to
  hidden clears the mode. (Blur matters: ⌘Tab away leaves keyup unseen.)

Installed from `+page.svelte` next to `installKeyboardShortcuts()`, and torn
down with it.

`app/src/lib/ui/ShortcutHint.svelte` renders one badge: a small monospace pill
(accent border, `--surface-overlay` background) that the host positions
absolutely. Props: `text: string`.

Where badges appear:

| Surface | Mode | Badge |
|---|---|---|
| Pane tab bar, **focused pane only** | `cmd` | positional digit |
| Hub tabs, when a hub view is active | `cmd` | same numbering over the visible views |
| Sidebar page rows, active workspace only | `cmd-shift` | page numbering |
| Sidebar workspace rows | `cmd-alt` | workspace numbering |
| `IconButton` with a `shortcut` | `cmd` | the formatted chord, e.g. `⌘T` |

**One badge per entity, showing its primary chord.** Positions 1–8 show their
own digit. Position 1 does *not* show `0` and the last item does not show `9`
when a positional digit already reaches it — those are aliases, and two badges
on one row is noise. The exception is a list longer than 8: its last item is
reachable only by ⌘9, so it shows `9`; items at position ≥ 9 that are not last
show no badge. This rule is one pure function, `hintDigitFor(index, count)`,
shared by every surface:

```ts
// shortcuts.ts — null means "no badge"
export function hintDigitFor(index: number, count: number): number | null;
```

## 5. Tooltips

`ui/IconButton.svelte` gains `shortcut?: ShortcutId`. When set, its tooltip text
becomes `` `${tip ?? label} (${formatShortcut(shortcut, isMacSync())})` `` — the
aria-label is left alone. Applied to New Tab (⌘T) in `Pane.svelte` and to the
title bar's Split Right / Split Down / Close Pane buttons where the chord
matches the action. `Tooltip.svelte` (the older component still used for tab
labels) is untouched.

## 6. Testing

- `shortcuts.test.ts`: `matchesChord` (right chord; wrong modifier; an extra
  modifier must not match; ctrl-vs-meta per platform), `formatChord` both
  platforms, `digitFromCode` (Digit/Numpad/other), `resolveIndex` (1–8 in range
  and past the end, 9, 0, empty list), `hintDigitFor` (positions 1–8; no badge
  for position 1's `0` alias; `9` only for the last item of a list longer than
  8; null for a non-last item at position ≥ 9).
- `shortcutHints.test.ts`: the `reduceHint` reducer — arm → elapse → `cmd`;
  shift down mid-hold → `cmd-shift` and back; other-key cancels and stays
  cancelled until release; blur clears.
- `keyboard.test.ts` (new file): routing with a mocked `layoutState` — ⌘3 in the
  terminal view calls `switchToTab` with the focused pane's third tab; ⌘3 in a
  hub view calls `switchWorkspaceView` with the third visible view; ⌘⇧2 calls
  `switchPage`; ⌘⌥2 calls `switchWorkspace` in sidebar order; ⌘9/⌘0 map to
  last/first; a digit with no target does nothing; letters still require a
  focused session.
- `workspace.test.ts`: `sidebarWorkspaceOrder` puts Unfiled first and preserves
  the rest.
- Manual: hold ⌘ in a session page and in a hub view; ⌘⇧ and ⌘⌥ while held;
  ⌘Tab away and back (no stuck badges); ⌘T does not flash hints.
