# Keyboard Shortcuts & Hold-⌘ Hints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ⌘-number quick navigation for pane tabs, hub tabs, sidebar pages and workspaces, plus badges that appear while the command key is held and shortcut hints in button tooltips.

**Architecture:** A pure `shortcuts.ts` chord/mapping module and a pure hint-state reducer sit under thin wiring: `keyboard.ts` routes chords to existing store actions, a `shortcutHints` store publishes the current hint mode, and each surface renders a `ShortcutHint` badge from the same `hintDigitFor` helper that the router's `resolveIndex` mirrors. Platform difference (⌘ vs Ctrl) is resolved once at bootstrap and read synchronously.

**Tech Stack:** Svelte 5 (runes), TypeScript, vitest, Tauri 2 (`plugin-os`).

**Spec:** `docs/superpowers/specs/2026-08-21-keyboard-shortcuts-design.md`

## Global Constraints

- "⌘" = `metaKey` on macOS, `ctrlKey` on Windows/Linux (spec K3) — except the pre-existing ⌘C/⌘V terminal copy/paste, which stay **macOS-only on `metaKey`** so Ctrl+C keeps meaning SIGINT elsewhere.
- ⌘Q is never bound (spec K1). Tab close stays ⌘W.
- Number mapping (spec K2): `1`–`8` → that position, `9` → last, `0` → first; out of range does nothing.
- **Digits match on `event.code`** (`Digit3`/`Numpad3`), never `event.key` — under ⌘⇧ macOS reports `"!"` and under ⌘⌥ `"¡"` (spec K4). **Letter chords keep matching `event.key.toLowerCase()`**, exactly as today, so non-QWERTY layouts are unaffected.
- Every handled event calls `preventDefault()` + `stopPropagation()`; the listener stays on the **capture** phase (xterm.js stops propagation before bubble).
- Badge numbering and routing must never disagree: both come from `shortcuts.ts`.
- All commands run from `app/`. Commit messages end with the repo's `Co-Authored-By` / `Claude-Session` trailer.

---

### Task 1: Synchronous platform flag

**Files:**
- Modify: `app/src/lib/platform.ts`
- Modify: `app/src/routes/+page.svelte` (bootstrap, ~line 72-79)
- Test: `app/src/lib/platform.test.ts` (create)

**Interfaces:**
- Produces: `initPlatform(): Promise<void>`, `isMacSync(): boolean`, `cmdHeld(e: { metaKey: boolean; ctrlKey: boolean }): boolean`. `isMacOS()` keeps its current signature.

- [ ] **Step 1: Write the failing test** — create `app/src/lib/platform.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const platformMock = vi.fn();
vi.mock("@tauri-apps/plugin-os", () => ({ platform: platformMock }));

import { initPlatform, isMacSync, cmdHeld } from "./platform";

beforeEach(() => {
  platformMock.mockReset();
});

describe("platform", () => {
  it("reads false before init and true after init on macOS", async () => {
    expect(isMacSync()).toBe(false);
    platformMock.mockResolvedValue("macos");
    await initPlatform();
    expect(isMacSync()).toBe(true);
  });

  it("cmdHeld follows metaKey on macOS and ctrlKey elsewhere", async () => {
    platformMock.mockResolvedValue("macos");
    await initPlatform();
    expect(cmdHeld({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(cmdHeld({ metaKey: false, ctrlKey: true })).toBe(false);

    platformMock.mockResolvedValue("windows");
    await initPlatform();
    expect(cmdHeld({ metaKey: false, ctrlKey: true })).toBe(true);
    expect(cmdHeld({ metaKey: true, ctrlKey: false })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/platform.test.ts 2>&1 | tail -6`
Expected: FAIL — `initPlatform is not a function`.

- [ ] **Step 3: Implement** — replace `app/src/lib/platform.ts` with:

```ts
import { platform } from "@tauri-apps/plugin-os";

// Keydown handlers cannot await, so the platform is resolved once at
// bootstrap and read synchronously afterwards. Until initPlatform
// resolves this reads false -- a few milliseconds at startup where a
// Ctrl chord would match instead of a Cmd one, never a crash.
let cachedIsMac = false;

export async function isMacOS(): Promise<boolean> {
  return (await platform()) === "macos";
}

export async function initPlatform(): Promise<void> {
  cachedIsMac = await isMacOS();
}

export function isMacSync(): boolean {
  return cachedIsMac;
}

/// "⌘" for shortcut purposes: Command on macOS, Control everywhere else.
export function cmdHeld(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return cachedIsMac ? e.metaKey : e.ctrlKey;
}
```

- [ ] **Step 4: Wire it into bootstrap** — in `app/src/routes/+page.svelte`, add `initPlatform` to the existing `$lib/platform` import if present, otherwise `import { initPlatform } from "$lib/platform";`, and call it before `bootstrap()` inside `onMount`:

```svelte
    await initPlatform();
    try {
      await bootstrap();
    } finally {
      await signalFrontendReady();
    }
```

- [ ] **Step 5: Verify**

Run: `npx vitest run src/lib/platform.test.ts 2>&1 | tail -4` → PASS.
Run: `npm run check 2>&1 | grep COMPLETED` → `0 ERRORS`.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/platform.ts app/src/lib/platform.test.ts app/src/routes/+page.svelte
git commit -m "feat(app): synchronous platform flag for keyboard shortcuts"
```

---

### Task 2: `shortcuts.ts` — chords, formatting, index mapping

**Files:**
- Create: `app/src/lib/shortcuts.ts`
- Test: `app/src/lib/shortcuts.test.ts`

**Interfaces:**
- Consumes: nothing (pure module; platform is passed in as a boolean).
- Produces:
  ```ts
  export interface Chord { key: string; shift?: boolean; alt?: boolean }
  export type ShortcutId = "new-tab" | "close-tab" | "split-right" | "split-down";
  export const SHORTCUTS: Record<ShortcutId, Chord>;
  export function matchesChord(e: KeyboardEvent, chord: Chord, isMac: boolean): boolean;
  export function formatChord(chord: Chord, isMac: boolean): string;
  export function formatShortcut(id: ShortcutId, isMac: boolean): string;
  export function digitFromCode(code: string): number | null;
  export function resolveIndex(digit: number, count: number): number | null;
  export function hintDigitFor(index: number, count: number): number | null;
  export function formatDigitChord(digit: number, mode: "cmd" | "cmd-shift" | "cmd-alt", isMac: boolean): string;
  ```

- [ ] **Step 1: Write the failing test** — create `app/src/lib/shortcuts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  SHORTCUTS,
  matchesChord,
  formatChord,
  formatShortcut,
  formatDigitChord,
  digitFromCode,
  resolveIndex,
  hintDigitFor,
} from "./shortcuts";

function ev(over: Partial<KeyboardEvent>): KeyboardEvent {
  return { key: "", code: "", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over } as KeyboardEvent;
}

describe("matchesChord", () => {
  it("matches meta on macOS and ctrl elsewhere", () => {
    const t = SHORTCUTS["new-tab"];
    expect(matchesChord(ev({ key: "t", metaKey: true }), t, true)).toBe(true);
    expect(matchesChord(ev({ key: "t", ctrlKey: true }), t, true)).toBe(false);
    expect(matchesChord(ev({ key: "t", ctrlKey: true }), t, false)).toBe(true);
    expect(matchesChord(ev({ key: "t", metaKey: true }), t, false)).toBe(false);
  });

  it("is case-insensitive on the key", () => {
    expect(matchesChord(ev({ key: "T", metaKey: true }), SHORTCUTS["new-tab"], true)).toBe(true);
  });

  it("requires declared modifiers and rejects undeclared ones", () => {
    const splitDown = SHORTCUTS["split-down"]; // cmd+shift+d
    expect(matchesChord(ev({ key: "d", metaKey: true, shiftKey: true }), splitDown, true)).toBe(true);
    expect(matchesChord(ev({ key: "d", metaKey: true }), splitDown, true)).toBe(false);
    // plain cmd+d must NOT fire when shift is also down
    expect(matchesChord(ev({ key: "d", metaKey: true, shiftKey: true }), SHORTCUTS["split-right"], true)).toBe(false);
    // an undeclared alt blocks the match
    expect(matchesChord(ev({ key: "t", metaKey: true, altKey: true }), SHORTCUTS["new-tab"], true)).toBe(false);
  });
});

describe("formatChord", () => {
  it("uses Apple's modifier order and symbols on macOS", () => {
    expect(formatChord({ key: "t" }, true)).toBe("⌘T");
    expect(formatChord({ key: "d", shift: true }, true)).toBe("⇧⌘D");
    expect(formatChord({ key: "1", alt: true }, true)).toBe("⌥⌘1");
    expect(formatChord({ key: "1", shift: true, alt: true }, true)).toBe("⌥⇧⌘1");
  });

  it("spells the modifiers out elsewhere", () => {
    expect(formatChord({ key: "t" }, false)).toBe("Ctrl+T");
    expect(formatChord({ key: "d", shift: true }, false)).toBe("Ctrl+Shift+D");
    expect(formatChord({ key: "1", alt: true }, false)).toBe("Ctrl+Alt+1");
  });

  it("formatShortcut resolves the registry", () => {
    expect(formatShortcut("close-tab", true)).toBe("⌘W");
    expect(formatShortcut("split-down", false)).toBe("Ctrl+Shift+D");
  });

  it("formatDigitChord covers the three hint modes", () => {
    expect(formatDigitChord(3, "cmd", true)).toBe("⌘3");
    expect(formatDigitChord(3, "cmd-shift", true)).toBe("⇧⌘3");
    expect(formatDigitChord(3, "cmd-alt", false)).toBe("Ctrl+Alt+3");
  });
});

describe("digitFromCode", () => {
  it("reads the digit row and the numpad, nothing else", () => {
    expect(digitFromCode("Digit3")).toBe(3);
    expect(digitFromCode("Digit0")).toBe(0);
    expect(digitFromCode("Numpad7")).toBe(7);
    expect(digitFromCode("KeyT")).toBeNull();
    expect(digitFromCode("")).toBeNull();
  });
});

describe("resolveIndex", () => {
  it("maps 1-8 to their position", () => {
    expect(resolveIndex(1, 5)).toBe(0);
    expect(resolveIndex(5, 5)).toBe(4);
  });
  it("returns null when the position does not exist", () => {
    expect(resolveIndex(6, 5)).toBeNull();
    expect(resolveIndex(1, 0)).toBeNull();
  });
  it("maps 9 to the last and 0 to the first", () => {
    expect(resolveIndex(9, 5)).toBe(4);
    expect(resolveIndex(9, 12)).toBe(11);
    expect(resolveIndex(0, 5)).toBe(0);
  });
  it("returns null for an empty list", () => {
    expect(resolveIndex(9, 0)).toBeNull();
    expect(resolveIndex(0, 0)).toBeNull();
  });
});

describe("hintDigitFor", () => {
  it("labels positions 1-8 with their own digit", () => {
    expect(hintDigitFor(0, 5)).toBe(1);
    expect(hintDigitFor(4, 5)).toBe(5);
  });
  it("does not show the 0 alias on the first item nor 9 on a reachable last", () => {
    expect(hintDigitFor(0, 5)).not.toBe(0);
    expect(hintDigitFor(4, 5)).toBe(5);
  });
  it("labels the last item 9 only when the list is longer than 8", () => {
    expect(hintDigitFor(9, 10)).toBe(9);
    expect(hintDigitFor(8, 10)).toBeNull();
  });
  it("returns null for an empty list", () => {
    expect(hintDigitFor(0, 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/shortcuts.test.ts 2>&1 | tail -6`
Expected: FAIL — cannot find module `./shortcuts`.

- [ ] **Step 3: Implement** — create `app/src/lib/shortcuts.ts`:

```ts
// The app's keyboard chords, as data. Pure: the platform is passed in so
// every rule here is testable without a browser or a Tauri host.
//
// Letters match on `event.key` (layout-friendly, and what this app has
// always done); digits match on `event.code` via digitFromCode, because
// under ⌘⇧ macOS reports "!" for the 1 key and under ⌘⌥ it reports "¡" --
// only the code stays stable.

export interface Chord {
  /// Lower-case KeyboardEvent.key for letters, or the digit character.
  key: string;
  shift?: boolean;
  alt?: boolean;
}

export type ShortcutId = "new-tab" | "close-tab" | "split-right" | "split-down";

export const SHORTCUTS: Record<ShortcutId, Chord> = {
  "new-tab": { key: "t" },
  "close-tab": { key: "w" },
  "split-right": { key: "d" },
  "split-down": { key: "d", shift: true },
};

export function matchesChord(e: KeyboardEvent, chord: Chord, isMac: boolean): boolean {
  const cmd = isMac ? e.metaKey : e.ctrlKey;
  const otherMod = isMac ? e.ctrlKey : e.metaKey;
  if (!cmd || otherMod) return false;
  if (e.shiftKey !== Boolean(chord.shift)) return false;
  if (e.altKey !== Boolean(chord.alt)) return false;
  return e.key.toLowerCase() === chord.key.toLowerCase();
}

export function formatChord(chord: Chord, isMac: boolean): string {
  const label = chord.key.length === 1 ? chord.key.toUpperCase() : chord.key;
  if (isMac) {
    // Apple's canonical order: Control, Option, Shift, Command, key.
    return `${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}⌘${label}`;
  }
  const parts = ["Ctrl"];
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  parts.push(label);
  return parts.join("+");
}

export function formatShortcut(id: ShortcutId, isMac: boolean): string {
  return formatChord(SHORTCUTS[id], isMac);
}

export function formatDigitChord(
  digit: number,
  mode: "cmd" | "cmd-shift" | "cmd-alt",
  isMac: boolean
): string {
  return formatChord(
    { key: String(digit), shift: mode === "cmd-shift", alt: mode === "cmd-alt" },
    isMac
  );
}

const DIGIT_CODE = /^(?:Digit|Numpad)(\d)$/;

export function digitFromCode(code: string): number | null {
  const match = DIGIT_CODE.exec(code);
  return match ? Number(match[1]) : null;
}

/// Which item a digit selects: 1-8 by position, 9 the last, 0 the first.
/// null when nothing is there.
export function resolveIndex(digit: number, count: number): number | null {
  if (count <= 0) return null;
  if (digit === 0) return 0;
  if (digit === 9) return count - 1;
  if (digit >= 1 && digit <= 8) return digit <= count ? digit - 1 : null;
  return null;
}

/// The single badge an item shows while ⌘ is held: its primary chord.
/// Positions 1-8 show their own digit; 0 and 9 are aliases and stay
/// hidden unless 9 is the ONLY way to reach a last item past position 8.
export function hintDigitFor(index: number, count: number): number | null {
  if (count <= 0 || index < 0 || index >= count) return null;
  if (index < 8) return index + 1;
  return index === count - 1 ? 9 : null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/shortcuts.test.ts 2>&1 | tail -4`
Expected: PASS (all assertions).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/shortcuts.ts app/src/lib/shortcuts.test.ts
git commit -m "feat(app): pure shortcut chord model, formatting and digit mapping"
```

---

### Task 3: Pure hub-view metadata + sidebar workspace order

**Files:**
- Create: `app/src/lib/hubViewMeta.ts`
- Modify: `app/src/lib/workspaceViews.ts`
- Modify: `app/src/lib/workspace.ts`
- Test: `app/src/lib/hubViewMeta.test.ts` (create), `app/src/lib/workspace.test.ts` (extend)

**Why:** `workspaceViews.ts` imports eight `.svelte` components, so anything importing it drags the whole component graph into a unit test. The *policy* (which view ids a workspace offers, in what order) is data and belongs in a component-free module.

**Interfaces:**
- Consumes: `hubViewIsVisible` (existing, `workspace.ts`), `SMOKETEST_WORKSPACE_ID`.
- Produces:
  ```ts
  // hubViewMeta.ts
  export interface HubViewMeta { id: string; label: string; devOnly?: boolean; requiresRoot?: boolean }
  export const HUB_VIEW_META: HubViewMeta[];
  export function visibleHubViewIds(workspaceId: string, isDev: boolean, hasRoot: boolean): string[];
  // workspace.ts
  export function sidebarWorkspaceOrder(workspaces: Workspace[]): Workspace[];
  ```

- [ ] **Step 1: Write the failing tests** — create `app/src/lib/hubViewMeta.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { HUB_VIEW_META, visibleHubViewIds } from "./hubViewMeta";
import { SMOKETEST_WORKSPACE_ID } from "./workspace";

describe("visibleHubViewIds", () => {
  it("keeps the declaration order", () => {
    const ids = visibleHubViewIds("ws-1", false, true);
    expect(ids).toEqual(HUB_VIEW_META.filter((v) => !v.devOnly).map((v) => v.id));
    expect(ids[0]).toBe("home");
  });

  it("drops root-only views for an unbound workspace", () => {
    const ids = visibleHubViewIds("ws-1", false, false);
    expect(ids).not.toContain("home");
    expect(ids).toContain("kanban");
    expect(ids).toContain("settings");
  });

  it("offers the dev-only checklist only in the smoke-test workspace of a dev build", () => {
    expect(visibleHubViewIds(SMOKETEST_WORKSPACE_ID, true, true)).toContain("checklist");
    expect(visibleHubViewIds("ws-1", true, true)).not.toContain("checklist");
    expect(visibleHubViewIds(SMOKETEST_WORKSPACE_ID, false, true)).not.toContain("checklist");
  });
});
```

and append to `app/src/lib/workspace.test.ts` (add `sidebarWorkspaceOrder` and `UNFILED_WORKSPACE_ID` to its existing import from `./workspace`):

```ts
describe("sidebarWorkspaceOrder", () => {
  const w = (id: string): Workspace => ({ id, name: id, pages: [], activePageId: null });

  it("puts Unfiled first and keeps the rest in order", () => {
    const list = [w("a"), w(UNFILED_WORKSPACE_ID), w("b")];
    expect(sidebarWorkspaceOrder(list).map((x) => x.id)).toEqual([UNFILED_WORKSPACE_ID, "a", "b"]);
  });

  it("is a no-op when Unfiled is absent", () => {
    expect(sidebarWorkspaceOrder([w("a"), w("b")]).map((x) => x.id)).toEqual(["a", "b"]);
  });
});
```

(If `workspace.test.ts` does not already import `Workspace`, add `import type { Workspace } from "./workspace";`.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/hubViewMeta.test.ts src/lib/workspace.test.ts 2>&1 | tail -6`
Expected: FAIL — cannot find module `./hubViewMeta`; `sidebarWorkspaceOrder is not a function`.

- [ ] **Step 3: Create the metadata module** — `app/src/lib/hubViewMeta.ts`:

```ts
// Which hub tabs a workspace offers, as data. Component-free on purpose:
// workspaceViews.ts binds these ids to Svelte components, so anything
// that only needs the POLICY (the keyboard router, its tests) can import
// this without pulling in the whole component graph.
import { hubViewIsVisible } from "./workspace";

export interface HubViewMeta {
  id: string;
  label: string;
  /// Only offered in dev builds, and only in the Smoke Test workspace.
  devOnly?: boolean;
  /// Only offered once the workspace is bound to a root folder.
  requiresRoot?: boolean;
}

export const HUB_VIEW_META: HubViewMeta[] = [
  { id: "home", label: "Home", requiresRoot: true },
  { id: "git", label: "Git", requiresRoot: true },
  { id: "kanban", label: "Kanban" },
  { id: "prd", label: "PRD", requiresRoot: true },
  { id: "agent-file", label: "CLAUDE.md", requiresRoot: true },
  { id: "plans", label: "Plans", requiresRoot: true },
  // No requiresRoot: binding the root is one of this tab's jobs.
  { id: "settings", label: "Settings" },
  { id: "checklist", label: "Checklist", devOnly: true },
];

export function visibleHubViewIds(workspaceId: string, isDev: boolean, hasRoot: boolean): string[] {
  return HUB_VIEW_META.filter((v) => hubViewIsVisible(v, workspaceId, isDev, hasRoot)).map((v) => v.id);
}
```

- [ ] **Step 4: Rebuild `workspaceViews.ts` on top of it** — keep `HUB_VIEWS` and `visibleHubViews` exactly as callers see them today, but derive the metadata from one source. Replace the `HUB_VIEWS` array and `visibleHubViews` with:

```ts
const COMPONENTS: Record<string, { icon: Component; component: Component<{ workspaceId: string }> }> = {
  home: { icon: LayoutDashboard, component: HomeHubView },
  git: { icon: GitBranch, component: GitHubView },
  kanban: { icon: Kanban, component: KanbanBoard },
  prd: { icon: FileText, component: PrdHubView },
  "agent-file": { icon: Bot, component: AgentFileHubView },
  plans: { icon: FolderTree, component: PlanExplorerHubView },
  settings: { icon: Settings, component: SettingsHubView },
  checklist: { icon: ListChecks, component: SmokeChecklist },
};

export const HUB_VIEWS: HubView[] = HUB_VIEW_META.map((meta) => ({ ...meta, ...COMPONENTS[meta.id] }));

// The hub tabs a given workspace should offer, in the order they render.
// Dev-only views are hidden everywhere except the dev Smoke Test
// workspace -- callers must render from this, not from HUB_VIEWS.
export function visibleHubViews(workspaceId: string, isDev: boolean, hasRoot: boolean): HubView[] {
  const visible = new Set(visibleHubViewIds(workspaceId, isDev, hasRoot));
  return HUB_VIEWS.filter((v) => visible.has(v.id));
}
```

Add the import `import { HUB_VIEW_META, visibleHubViewIds, type HubViewMeta } from "./hubViewMeta";`, keep the `HubView` interface but define it as `export interface HubView extends HubViewMeta { icon: Component; component: Component<{ workspaceId: string }> }`, and drop the now-unused `hubViewIsVisible` import if nothing else in the file uses it.

- [ ] **Step 5: Add `sidebarWorkspaceOrder`** — in `app/src/lib/workspace.ts`, next to `allSessionIdsInWorkspace`:

```ts
/// The order the sidebar renders workspaces in: Unfiled pinned to the
/// top, then the rest as stored. Shared with the ⌘⌥-number router so a
/// hint badge and the shortcut can never point at different workspaces.
export function sidebarWorkspaceOrder(workspaces: Workspace[]): Workspace[] {
  const unfiled = workspaces.filter((w) => w.id === UNFILED_WORKSPACE_ID);
  const rest = workspaces.filter((w) => w.id !== UNFILED_WORKSPACE_ID);
  return [...unfiled, ...rest];
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run 2>&1 | grep -E 'Tests|FAIL'` → all pass.
Run: `npm run check 2>&1 | grep COMPLETED` → `0 ERRORS`.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/hubViewMeta.ts app/src/lib/hubViewMeta.test.ts app/src/lib/workspaceViews.ts app/src/lib/workspace.ts app/src/lib/workspace.test.ts
git commit -m "refactor(app): component-free hub view metadata + sidebar workspace order"
```

---

### Task 4: Digit routing in `keyboard.ts`

**Files:**
- Modify: `app/src/lib/keyboard.ts`
- Test: `app/src/lib/keyboard.test.ts` (create)

**Interfaces:**
- Consumes: `cmdHeld`, `isMacSync` (Task 1); `digitFromCode`, `resolveIndex`, `matchesChord`, `SHORTCUTS` (Task 2); `visibleHubViewIds` (Task 3); `sidebarWorkspaceOrder` (Task 3); existing `switchToTab`, `switchWorkspaceView`, `switchPage`, `switchWorkspace`, `splitPane`, `addTab`, `closeSession` from `./layoutState`.
- Produces: no new exports; `installKeyboardShortcuts()` keeps its signature.

- [ ] **Step 1: Write the failing test** — create `app/src/lib/keyboard.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { writable } from "svelte/store";
import type { LayoutNode } from "./layout";

const state = writable<Record<string, unknown>>({});

vi.mock("./layoutState", () => ({
  layoutState: state,
  splitPane: vi.fn().mockResolvedValue(undefined),
  addTab: vi.fn().mockResolvedValue(undefined),
  closeSession: vi.fn().mockResolvedValue(undefined),
  switchToTab: vi.fn().mockResolvedValue(undefined),
  switchWorkspaceView: vi.fn().mockResolvedValue(undefined),
  switchPage: vi.fn().mockResolvedValue(undefined),
  switchWorkspace: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./clipboard", () => ({
  copySelection: vi.fn().mockResolvedValue(undefined),
  pasteClipboard: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./confirmClose", () => ({ confirmTabClose: vi.fn().mockResolvedValue(true) }));
vi.mock("./platform", () => ({ isMacSync: () => true, cmdHeld: (e: KeyboardEvent) => e.metaKey }));

import {
  switchToTab,
  switchWorkspaceView,
  switchPage,
  switchWorkspace,
  addTab,
} from "./layoutState";
import { installKeyboardShortcuts } from "./keyboard";

const leaf = (tabs: string[]): LayoutNode => ({ type: "leaf", tabs, activeTabIndex: 0 });

function setState(over: Record<string, unknown> = {}): void {
  state.set({
    status: "ready",
    workspaces: [
      {
        id: "ws-1",
        name: "ws-1",
        rootPath: "/r",
        activeView: "terminal",
        activePageId: "p1",
        pages: [
          { id: "p1", name: "p1", layout: leaf(["a", "b", "c"]), focusedSessionId: "a" },
          { id: "p2", name: "p2", layout: leaf(["d"]), focusedSessionId: "d" },
        ],
      },
      { id: "__unfiled__", name: "Unfiled", pages: [], activePageId: null },
    ],
    activeWorkspaceId: "ws-1",
    focusedSessionId: "a",
    fileTabsById: {},
    boardTabsById: {},
    ...over,
  });
}

let uninstall: (() => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  setState();
  uninstall?.();
  uninstall = installKeyboardShortcuts();
});

function press(code: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { code, metaKey: true, bubbles: true, ...mods });
  window.dispatchEvent(event);
  return event;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("digit navigation", () => {
  it("⌘2 switches to the second tab of the focused pane", async () => {
    press("Digit2");
    await flush();
    expect(switchToTab).toHaveBeenCalledWith("b");
  });

  it("⌘9 goes to the last tab and ⌘0 to the first", async () => {
    press("Digit9");
    await flush();
    expect(switchToTab).toHaveBeenCalledWith("c");
    press("Digit0");
    await flush();
    expect(switchToTab).toHaveBeenCalledWith("a");
  });

  it("does nothing when the position is past the end", async () => {
    press("Digit7");
    await flush();
    expect(switchToTab).not.toHaveBeenCalled();
  });

  it("switches hub tabs when a hub view is active", async () => {
    setState({
      workspaces: [
        { id: "ws-1", name: "ws-1", rootPath: "/r", activeView: "kanban", activePageId: null, pages: [] },
      ],
      focusedSessionId: null,
    });
    press("Digit2");
    await flush();
    // home, git, kanban, ... -> second visible view is git
    expect(switchWorkspaceView).toHaveBeenCalledWith("ws-1", "git");
    expect(switchToTab).not.toHaveBeenCalled();
  });

  it("⌘⇧2 switches page", async () => {
    press("Digit2", { shiftKey: true });
    await flush();
    expect(switchPage).toHaveBeenCalledWith("ws-1", "p2");
  });

  it("⌘⌥2 switches workspace in sidebar order (Unfiled first)", async () => {
    press("Digit2", { altKey: true });
    await flush();
    expect(switchWorkspace).toHaveBeenCalledWith("ws-1");
  });

  it("ignores the digit without the command key", async () => {
    press("Digit2", { metaKey: false });
    await flush();
    expect(switchToTab).not.toHaveBeenCalled();
  });
});

describe("letter shortcuts", () => {
  it("still requires a focused session", async () => {
    setState({ focusedSessionId: null });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", code: "KeyT", metaKey: true }));
    await flush();
    expect(addTab).not.toHaveBeenCalled();
  });

  it("⌘T adds a tab when one is focused", async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", code: "KeyT", metaKey: true }));
    await flush();
    expect(addTab).toHaveBeenCalledWith("a");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/keyboard.test.ts 2>&1 | tail -8`
Expected: FAIL — digit presses call nothing (`switchToTab` never called).

- [ ] **Step 3: Implement** — rewrite `app/src/lib/keyboard.ts`:

```ts
import { get } from "svelte/store";
import {
  layoutState,
  splitPane,
  addTab,
  closeSession,
  switchToTab,
  switchWorkspaceView,
  switchPage,
  switchWorkspace,
} from "./layoutState";
import { copySelection, pasteClipboard } from "./clipboard";
import { confirmTabClose } from "./confirmClose";
import { findLeafPath, getNodeAtPath, isPinned } from "./layout";
import {
  getActiveTree,
  getActiveWorkspace,
  getActiveView,
  sidebarWorkspaceOrder,
  type WorkspacesData,
} from "./workspace";
import { visibleHubViewIds } from "./hubViewMeta";
import { cmdHeld, isMacSync } from "./platform";
import { digitFromCode, matchesChord, resolveIndex, SHORTCUTS } from "./shortcuts";

// ⌘1-8 select that position, ⌘9 the last, ⌘0 the first (spec K2). Which
// LIST is addressed depends on the modifiers and what is on screen:
// plain ⌘ = the focused pane's tabs (session page) or the hub tabs
// (workspace page); ⌘⇧ = the active workspace's pages; ⌘⌥ = workspaces.
// Returns whether the event was handled.
async function routeDigit(event: KeyboardEvent, digit: number, state: WorkspacesData): Promise<boolean> {
  const { shiftKey, altKey } = event;
  if (shiftKey && altKey) return false;

  if (altKey) {
    const list = sidebarWorkspaceOrder(state.workspaces);
    const index = resolveIndex(digit, list.length);
    if (index === null) return false;
    await switchWorkspace(list[index].id);
    return true;
  }

  const ws = getActiveWorkspace(state);
  if (!ws) return false;

  if (shiftKey) {
    const index = resolveIndex(digit, ws.pages.length);
    if (index === null) return false;
    await switchPage(ws.id, ws.pages[index].id);
    return true;
  }

  if (getActiveView(ws) === "terminal") {
    const tree = getActiveTree(state);
    const focused = state.focusedSessionId;
    if (!tree || !focused) return false;
    const path = findLeafPath(tree, focused);
    if (!path) return false;
    const leaf = getNodeAtPath(tree, path);
    if (leaf.type !== "leaf") return false;
    const index = resolveIndex(digit, leaf.tabs.length);
    if (index === null) return false;
    await switchToTab(leaf.tabs[index]);
    return true;
  }

  const views = visibleHubViewIds(ws.id, import.meta.env.DEV, Boolean(ws.rootPath));
  const index = resolveIndex(digit, views.length);
  if (index === null) return false;
  await switchWorkspaceView(ws.id, views[index]);
  return true;
}

async function handleKeydown(event: KeyboardEvent): Promise<void> {
  if (!cmdHeld(event)) return;
  const state = get(layoutState);
  const isMac = isMacSync();

  const digit = digitFromCode(event.code);
  if (digit !== null) {
    if (await routeDigit(event, digit, state)) {
      event.preventDefault();
      event.stopPropagation();
    }
    return;
  }

  // Everything below acts on the focused terminal session.
  if (!state.focusedSessionId) return;

  if (matchesChord(event, SHORTCUTS["split-down"], isMac)) {
    event.preventDefault();
    event.stopPropagation();
    await splitPane(state.focusedSessionId, "column");
  } else if (matchesChord(event, SHORTCUTS["split-right"], isMac)) {
    event.preventDefault();
    event.stopPropagation();
    await splitPane(state.focusedSessionId, "row");
  } else if (matchesChord(event, SHORTCUTS["new-tab"], isMac)) {
    event.preventDefault();
    event.stopPropagation();
    await addTab(state.focusedSessionId);
  } else if (matchesChord(event, SHORTCUTS["close-tab"], isMac)) {
    event.preventDefault();
    event.stopPropagation();
    // A pinned tab is protected from the close shortcut (browser-style);
    // the tab menu's explicit Close still works.
    const tree = getActiveTree(state);
    if (tree && isPinned(tree, state.focusedSessionId)) return;
    if (await confirmTabClose(state.focusedSessionId)) {
      await closeSession(state.focusedSessionId);
    }
  } else if (event.metaKey && event.key.toLowerCase() === "c" && isMac) {
    // Copy/paste stay macOS-only on metaKey: on Linux/Windows Ctrl+C in a
    // terminal must remain SIGINT, not a copy.
    event.preventDefault();
    event.stopPropagation();
    await copySelection();
  } else if (event.metaKey && event.key.toLowerCase() === "v" && isMac) {
    event.preventDefault();
    event.stopPropagation();
    await pasteClipboard();
  }
}

export function installKeyboardShortcuts(): () => void {
  // Capture phase, not bubble -- xterm.js's own keydown handler stops
  // propagation before a bubble-phase window listener would ever see it
  // (established the hard way in Milestone B).
  const listener = (event: KeyboardEvent) => {
    void handleKeydown(event);
  };
  window.addEventListener("keydown", listener, true);
  return () => window.removeEventListener("keydown", listener, true);
}
```

If `WorkspacesData` is not exported from `./workspace`, use `ReturnType<typeof get<typeof layoutState>>`-free typing instead: declare the parameter as `state: LayoutState` importing `type { LayoutState } from "./layoutState"`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/keyboard.test.ts 2>&1 | tail -4` → PASS.
Run: `npx vitest run 2>&1 | grep -E 'Tests|FAIL'` → all pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/keyboard.ts app/src/lib/keyboard.test.ts
git commit -m "feat(app): cmd-number navigation for tabs, hub tabs, pages and workspaces"
```

---

### Task 5: Hold-⌘ hint state

**Files:**
- Create: `app/src/lib/shortcutHints.ts`
- Test: `app/src/lib/shortcutHints.test.ts`
- Modify: `app/src/routes/+page.svelte` (install/teardown next to `installKeyboardShortcuts`)

**Interfaces:**
- Consumes: `cmdHeld` (Task 1).
- Produces:
  ```ts
  export type HintMode = "cmd" | "cmd-shift" | "cmd-alt";
  export interface HintState { armed: boolean; cancelled: boolean; mode: HintMode | null }
  export type HintEvent =
    | { type: "modifier-state"; cmd: boolean; shift: boolean; alt: boolean }
    | { type: "other-key" }
    | { type: "hold-elapsed" }
    | { type: "blur" };
  export const INITIAL_HINT_STATE: HintState;
  export function reduceHint(state: HintState, event: HintEvent): HintState;
  export const HINT_HOLD_MS: number;
  export const hintMode: Readable<HintMode | null>;
  export function installHintTracking(): () => void;
  ```

- [ ] **Step 1: Write the failing test** — create `app/src/lib/shortcutHints.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { reduceHint, INITIAL_HINT_STATE, type HintState } from "./shortcutHints";

const mods = (cmd: boolean, shift = false, alt = false) =>
  ({ type: "modifier-state", cmd, shift, alt }) as const;

function run(...events: Parameters<typeof reduceHint>[1][]): HintState {
  return events.reduce(reduceHint, INITIAL_HINT_STATE);
}

describe("reduceHint", () => {
  it("arms on cmd down and shows nothing until the hold elapses", () => {
    const armed = run(mods(true));
    expect(armed.armed).toBe(true);
    expect(armed.mode).toBeNull();
    expect(reduceHint(armed, { type: "hold-elapsed" }).mode).toBe("cmd");
  });

  it("shows cmd-shift or cmd-alt when that modifier is down", () => {
    expect(run(mods(true, true, false), { type: "hold-elapsed" }).mode).toBe("cmd-shift");
    expect(run(mods(true, false, true), { type: "hold-elapsed" }).mode).toBe("cmd-alt");
  });

  it("switches mode live while the hints are up", () => {
    const shown = run(mods(true), { type: "hold-elapsed" });
    expect(reduceHint(shown, mods(true, true, false)).mode).toBe("cmd-shift");
    expect(reduceHint(reduceHint(shown, mods(true, true, false)), mods(true)).mode).toBe("cmd");
  });

  it("a non-modifier key cancels the hold until cmd is released", () => {
    const cancelled = run(mods(true), { type: "other-key" });
    expect(cancelled.cancelled).toBe(true);
    expect(reduceHint(cancelled, { type: "hold-elapsed" }).mode).toBeNull();
    // still cancelled while cmd stays down
    const stillDown = reduceHint(cancelled, mods(true, true, false));
    expect(reduceHint(stillDown, { type: "hold-elapsed" }).mode).toBeNull();
    // releasing cmd resets everything
    const released = reduceHint(stillDown, mods(false));
    expect(released).toEqual(INITIAL_HINT_STATE);
  });

  it("releasing cmd and blur both clear a shown mode", () => {
    const shown = run(mods(true), { type: "hold-elapsed" });
    expect(reduceHint(shown, mods(false)).mode).toBeNull();
    expect(reduceHint(shown, { type: "blur" })).toEqual(INITIAL_HINT_STATE);
  });

  it("ignores hold-elapsed when cmd was never down", () => {
    expect(reduceHint(INITIAL_HINT_STATE, { type: "hold-elapsed" }).mode).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/shortcutHints.test.ts 2>&1 | tail -6`
Expected: FAIL — cannot find module `./shortcutHints`.

- [ ] **Step 3: Implement** — create `app/src/lib/shortcutHints.ts`:

```ts
// Holding the command key for HINT_HOLD_MS reveals the shortcut badges
// on tabs, hub tabs and sidebar rows. The state machine is a pure
// reducer so its rules -- a typed shortcut must NOT flash hints, blur
// must clear them -- are testable without a DOM.
import { readonly, writable, type Readable } from "svelte/store";
import { cmdHeld } from "./platform";

export type HintMode = "cmd" | "cmd-shift" | "cmd-alt";

export interface HintState {
  /// The command key is down and the hold timer is running or elapsed.
  armed: boolean;
  /// Another key was pressed during this hold: no hints until release.
  cancelled: boolean;
  mode: HintMode | null;
}

export type HintEvent =
  | { type: "modifier-state"; cmd: boolean; shift: boolean; alt: boolean }
  | { type: "other-key" }
  | { type: "hold-elapsed" }
  | { type: "blur" };

export const INITIAL_HINT_STATE: HintState = { armed: false, cancelled: false, mode: null };
export const HINT_HOLD_MS = 500;

function modeFor(shift: boolean, alt: boolean): HintMode {
  if (shift) return "cmd-shift";
  if (alt) return "cmd-alt";
  return "cmd";
}

export function reduceHint(state: HintState, event: HintEvent): HintState {
  switch (event.type) {
    case "modifier-state": {
      if (!event.cmd) return INITIAL_HINT_STATE;
      if (state.cancelled) return { ...state, armed: true };
      // Already showing: follow the modifiers live.
      if (state.mode) return { ...state, mode: modeFor(event.shift, event.alt) };
      return { ...state, armed: true };
    }
    case "other-key":
      return state.armed ? { armed: true, cancelled: true, mode: null } : state;
    case "hold-elapsed":
      if (!state.armed || state.cancelled) return state;
      return { ...state, mode: state.mode ?? "cmd" };
    case "blur":
      return INITIAL_HINT_STATE;
  }
}

const state = writable<HintState>(INITIAL_HINT_STATE);
const modeStore = writable<HintMode | null>(null);
export const hintMode: Readable<HintMode | null> = readonly(modeStore);

export function installHintTracking(): () => void {
  let current = INITIAL_HINT_STATE;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function apply(event: HintEvent): void {
    const next = reduceHint(current, event);
    const wasArmed = current.armed && !current.cancelled;
    current = next;
    state.set(next);
    modeStore.set(next.mode);

    const shouldRun = next.armed && !next.cancelled && next.mode === null;
    if (shouldRun && !wasArmed) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        apply({ type: "hold-elapsed" });
      }, HINT_HOLD_MS);
    }
    if (!next.armed || next.cancelled) {
      if (timer) clearTimeout(timer);
      timer = null;
    }
  }

  const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt", "CapsLock"]);

  function onKeydown(e: KeyboardEvent): void {
    if (!MODIFIER_KEYS.has(e.key)) {
      apply({ type: "other-key" });
      return;
    }
    apply({ type: "modifier-state", cmd: cmdHeld(e), shift: e.shiftKey, alt: e.altKey });
  }

  function onKeyup(e: KeyboardEvent): void {
    if (!MODIFIER_KEYS.has(e.key)) return;
    apply({ type: "modifier-state", cmd: cmdHeld(e), shift: e.shiftKey, alt: e.altKey });
  }

  function onBlur(): void {
    apply({ type: "blur" });
  }

  function onVisibility(): void {
    if (document.visibilityState === "hidden") apply({ type: "blur" });
  }

  // Capture, like the shortcut listener: xterm stops propagation first.
  window.addEventListener("keydown", onKeydown, true);
  window.addEventListener("keyup", onKeyup, true);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    if (timer) clearTimeout(timer);
    window.removeEventListener("keydown", onKeydown, true);
    window.removeEventListener("keyup", onKeyup, true);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibility);
    apply({ type: "blur" });
  };
}
```

- [ ] **Step 4: Install it in the app** — in `app/src/routes/+page.svelte`: import `installHintTracking` from `$lib/shortcutHints`, add `let uninstallHints: (() => void) | null = null;` beside `uninstallShortcuts`, set `uninstallHints = installHintTracking();` right after `uninstallShortcuts = installKeyboardShortcuts();`, and call `uninstallHints?.();` in `onDestroy`.

- [ ] **Step 5: Verify**

Run: `npx vitest run src/lib/shortcutHints.test.ts 2>&1 | tail -4` → PASS.
Run: `npm run check 2>&1 | grep COMPLETED` → `0 ERRORS`.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/shortcutHints.ts app/src/lib/shortcutHints.test.ts app/src/routes/+page.svelte
git commit -m "feat(app): hold-cmd hint mode tracking"
```

---

### Task 6: Badge component + pane tab and hub tab hints

**Files:**
- Create: `app/src/lib/ui/ShortcutHint.svelte`
- Modify: `app/src/lib/Pane.svelte` (tab button, ~line 305-325 and styles)
- Modify: `app/src/routes/+page.svelte` (hub tab button, ~line 124-134 and styles)

**Interfaces:**
- Consumes: `hintMode` (Task 5), `hintDigitFor` (Task 2).
- Produces: `<ShortcutHint text={string} />`.

- [ ] **Step 1: Create the badge** — `app/src/lib/ui/ShortcutHint.svelte`:

```svelte
<script lang="ts">
  // The small key badge shown while the command key is held. Purely
  // presentational: each surface decides WHEN to render one and
  // positions it; this owns only how it looks.
  let { text }: { text: string } = $props();
</script>

<span class="shortcut-hint" aria-hidden="true">{text}</span>

<style>
  .shortcut-hint {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    border: 1px solid var(--ws-accent, var(--border));
    border-radius: 3px;
    background: var(--surface-overlay);
    color: var(--text);
    font-family: monospace;
    font-size: 10px;
    line-height: 1;
    pointer-events: none;
  }
</style>
```

- [ ] **Step 2: Pane tabs** — in `app/src/lib/Pane.svelte`:

Add to the script block:

```ts
  import { hintMode } from "./shortcutHints";
  import { hintDigitFor } from "./shortcuts";
  import ShortcutHint from "./ui/ShortcutHint.svelte";
```

and render the badge inside the tab button, immediately after the pin glyph block (before the `{#if editingSessionId === sessionId}`):

```svelte
        {#if $hintMode === "cmd" && isFocused && hintDigitFor(tabIndex, leaf.tabs.length) !== null}
          <ShortcutHint text={String(hintDigitFor(tabIndex, leaf.tabs.length))} />
        {/if}
```

(`isFocused` and `tabIndex` are already in scope — `tabIndex` is the `{#each leaf.tabs as sessionId, tabIndex}` binding, `isFocused` the pane's existing focus flag. The hint only appears on the focused pane, which is the pane ⌘-digits act on.)

- [ ] **Step 3: Hub tabs** — in `app/src/routes/+page.svelte`:

Add to the script block:

```ts
  import { hintMode } from "$lib/shortcutHints";
  import { hintDigitFor } from "$lib/shortcuts";
  import ShortcutHint from "$lib/ui/ShortcutHint.svelte";
```

and inside the hub tab `{#each hubViews as view (view.id)}` button, after the label:

```svelte
                {#if $hintMode === "cmd" && hintDigitFor(hubViews.indexOf(view), hubViews.length) !== null}
                  <ShortcutHint text={String(hintDigitFor(hubViews.indexOf(view), hubViews.length))} />
                {/if}
```

Change the `{#each}` to bind the index instead of calling `indexOf`: `{#each hubViews as view, viewIndex (view.id)}` and use `viewIndex`.

- [ ] **Step 4: Verify**

Run: `npm run check 2>&1 | grep -E 'COMPLETED|ERROR'` → `0 ERRORS`.
Run: `npx vitest run 2>&1 | grep Tests` → all pass.

Then launch the app (`npm run tauri dev`) and hold ⌘ for half a second: digits appear on the focused pane's tabs in a session page, and on the hub tabs in a workspace page. Typing ⌘T does not flash them.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/ui/ShortcutHint.svelte app/src/lib/Pane.svelte app/src/routes/+page.svelte
git commit -m "feat(app): hold-cmd number badges on pane tabs and hub tabs"
```

---

### Task 7: Sidebar page and workspace hints

**Files:**
- Modify: `app/src/lib/Sidebar.svelte` (page row ~line 406, workspace rows ~line 555 and ~line 586, styles)

**Interfaces:**
- Consumes: `hintMode` (Task 5), `hintDigitFor` (Task 2), `sidebarWorkspaceOrder` (Task 3), `ShortcutHint` (Task 6).

- [ ] **Step 1: Script** — add to `app/src/lib/Sidebar.svelte`:

```ts
  import { hintMode } from "./shortcutHints";
  import { hintDigitFor } from "./shortcuts";
  import ShortcutHint from "./ui/ShortcutHint.svelte";
  import { sidebarWorkspaceOrder } from "./workspace";

  // ⌘⌥-number addresses workspaces in the order this sidebar renders
  // them, which is Unfiled first -- the same helper the router uses.
  const orderedWorkspaces = $derived(sidebarWorkspaceOrder($layoutState.workspaces));

  function pageHint(ws: Workspace, index: number): string | null {
    if ($hintMode !== "cmd-shift" || ws.id !== $layoutState.activeWorkspaceId) return null;
    const digit = hintDigitFor(index, ws.pages.length);
    return digit === null ? null : String(digit);
  }

  function workspaceHint(workspaceId: string): string | null {
    if ($hintMode !== "cmd-alt") return null;
    const index = orderedWorkspaces.findIndex((w) => w.id === workspaceId);
    const digit = index === -1 ? null : hintDigitFor(index, orderedWorkspaces.length);
    return digit === null ? null : String(digit);
  }
```

- [ ] **Step 2: Page rows** — inside the `{#each ws.pages as page, pageIndex (page.id)}` block's `.page-row`, render the badge right before the page name (the `{#if editingPageId === page.id}` input / `.page-name` span pair):

```svelte
          {#if pageHint(ws, pageIndex)}
            <ShortcutHint text={pageHint(ws, pageIndex) ?? ""} />
          {/if}
```

- [ ] **Step 3: Workspace rows** — in BOTH workspace rows (the Unfiled `.workspace-row.pinned` block and the `{#each regularWorkspaces as ws (ws.id)}` `.workspace-row` block), immediately before the `.workspace-name` span:

```svelte
          {#if workspaceHint(ws.id)}
            <ShortcutHint text={workspaceHint(ws.id) ?? ""} />
          {/if}
```

- [ ] **Step 4: Verify**

Run: `npm run check 2>&1 | grep -E 'COMPLETED|ERROR'` → `0 ERRORS`, no new warnings.
Run: `npx vitest run 2>&1 | grep Tests` → all pass.

In the app: hold ⌘⇧ → numbers on the active workspace's page rows; hold ⌘⌥ → numbers on every workspace row, Unfiled = 1. Pressing the combination navigates to the badged row.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/Sidebar.svelte
git commit -m "feat(app): hold-cmd-shift/alt badges on sidebar pages and workspaces"
```

---

### Task 8: Shortcut hints in button tooltips

**Files:**
- Modify: `app/src/lib/ui/IconButton.svelte`
- Modify: `app/src/lib/Pane.svelte` (New Tab button, ~line 389)
- Modify: `app/src/lib/TitleBar.svelte` (Split Right / Split Down / Close Pane buttons)

**Interfaces:**
- Consumes: `formatShortcut`, `ShortcutId` (Task 2); `isMacSync` (Task 1); `hintMode` (Task 5).
- Produces: `IconButton` gains `shortcut?: ShortcutId`.

- [ ] **Step 1: IconButton** — in `app/src/lib/ui/IconButton.svelte`, add to `Props`:

```ts
    /// A registered shortcut for this action: appended to the tooltip
    /// ("New Tab (⌘T)") and shown as a badge while the command key is
    /// held. Formatting is per-platform, resolved in one place.
    shortcut?: ShortcutId;
```

add `shortcut` to the destructured props, add the imports

```ts
  import { formatShortcut, type ShortcutId } from "../shortcuts";
  import { isMacSync } from "../platform";
  import { hintMode } from "../shortcutHints";
  import ShortcutHint from "./ShortcutHint.svelte";
```

replace the derived tip with

```ts
  const baseTip = $derived(tip === undefined ? label : tip);
  const shortcutText = $derived(shortcut ? formatShortcut(shortcut, isMacSync()) : null);
  const tipText = $derived(baseTip && shortcutText ? `${baseTip} (${shortcutText})` : baseTip);
```

and render the badge after the optional text, inside the button:

```svelte
  {#if shortcutText && $hintMode === "cmd"}
    <ShortcutHint text={shortcutText} />
  {/if}
```

- [ ] **Step 2: Tag the buttons**

`app/src/lib/Pane.svelte`, the New Tab button:

```svelte
    <IconButton icon={Plus} label="New Tab" size={14} shortcut="new-tab" onclick={() => addTab(active)} />
```

`app/src/lib/TitleBar.svelte`: add `shortcut="split-right"` to the Split Right button, `shortcut="split-down"` to Split Down, and `shortcut="close-tab"` to the Close Pane button **only if that button closes the focused tab**; if it calls `handleClosePane` (closing the whole pane, not the tab), leave it without a shortcut — ⌘W closes a tab, not a pane, and a wrong hint is worse than none. Read the handler before deciding.

- [ ] **Step 3: Verify**

Run: `npm run check 2>&1 | grep -E 'COMPLETED|ERROR'` → `0 ERRORS`.
Run: `npx vitest run 2>&1 | grep Tests` → all pass.

In the app: hovering New Tab shows "New Tab (⌘T)"; holding ⌘ puts a `⌘T` badge on it.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/ui/IconButton.svelte app/src/lib/Pane.svelte app/src/lib/TitleBar.svelte
git commit -m "feat(app): shortcut hints in icon button tooltips and badges"
```

---

### Task 9: Full verification and card

**Files:**
- Create: `.gavin-root/plans/keyboard-shortcuts.md` (at execution start; tick as tasks land)

- [ ] **Step 1: Run everything**

From `app/`: `npm run check 2>&1 | tail -1`, `npx vitest run 2>&1 | tail -4`.
From the repo root: `cargo test --workspace 2>&1 | grep -E 'test result|FAILED'`.
Expected: 0 errors, all suites green (the Rust side is untouched but must stay green).

- [ ] **Step 2: Manual pass** — record results on the card:

1. Session page: ⌘1…⌘5 switch tabs in the focused pane; ⌘9 = last, ⌘0 = first; a digit past the end does nothing.
2. Two panes side by side: digits act on the **focused** pane, and only that pane shows badges.
3. Workspace page (e.g. Kanban): ⌘1…⌘n switch hub tabs in the order rendered.
4. ⌘⇧-number switches pages; ⌘⌥-number switches workspaces with Unfiled = 1.
5. Hold ⌘ for half a second → badges; add Shift → page badges; add Alt → workspace badges; release → gone.
6. Type ⌘T quickly → a tab opens and no badges flash.
7. ⌘Tab to another app and back → no stuck badges.
8. Tooltip on New Tab reads "New Tab (⌘T)".
9. ⌘W still closes a tab and still refuses on a pinned tab; ⌘Q still quits the app.

- [ ] **Step 3: Card status** — set the card to `Done` when Step 2 passes; leave it `In Progress` with the failing item unticked otherwise.

---

## Self-review notes

- Spec coverage: §1 platform → Task 1. §2 `shortcuts.ts` → Task 2 (`hintDigitFor` included). §3 bindings/routing, ordering helper, guard change → Tasks 3 & 4. §4 hints (reducer, store, install, badge surfaces) → Tasks 5, 6, 7. §5 tooltips → Task 8. §6 testing → each task's tests plus Task 9.
- Deviation from spec §2, deliberate: `Chord` carries `key` (letters) rather than `code`, and digits are matched by `digitFromCode` on `event.code`. Matching letters on `code` would silently change behaviour for non-QWERTY layouts, which the spec's K4 rationale (shifted/alt digits) never required. The spec's K4 has been amended to say exactly this.
- `resolveIndex(9, count)` and `hintDigitFor` agree by construction: 9 is the last item, and the badge only advertises it when no positional digit reaches that item.
