# Session Status Detection — Part 2 (Frontend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the already-shipped backend's per-session status
(`idle`/`working`/`waiting_for_input`) in the frontend: a per-tab status
dot, sidebar count badges, and OS notifications on the two
notification-worthy transitions.

**Architecture:** A new `sessionStatusById` map in the existing
`layoutState.ts` store, populated by a `session-status-changed` Tauri event
listener (mirroring the already-shipped `cwd-changed`/`cwdBySessionId`
precedent exactly). A new `notifications.ts` module decides whether a
transition is worth an OS notification and fires it via
`@tauri-apps/plugin-notification`, suppressed whenever the app window is
OS-frontmost. `Pane.svelte` reads the map to render a per-tab dot;
`Sidebar.svelte` reads it to render `waiting_for_input` count badges on page
and workspace rows.

**Tech Stack:** Svelte 5 (a mix of runes in `.svelte` files and a plain
`svelte/store` in `layoutState.ts`, deliberately not runes there — see that
file's own header comment history), TypeScript, Vitest,
`@tauri-apps/plugin-notification` (new dependency, added in Task 1).

## Global Constraints

- This plan is frontend-only. No Rust daemon/protocol logic changes — Task
  1's Rust-side changes are pure Tauri plugin registration/config (Cargo
  dependency, plugin init call, capability grant), not application logic.
  Part 1 (backend, already shipped, commit `64f5263`) is done; this plan
  only consumes what it already produces.
- The Tauri event this plan listens for is `"session-status-changed"`, with
  payload `(id: string, status: string)` — a 2-tuple, exactly matching the
  existing `"cwd-changed"` event's shape (verified against the current
  `app/src-tauri/src/session.rs` relay arm before writing this plan).
  `status` is one of exactly three wire values: `"idle"`, `"working"`,
  `"waiting_for_input"`. `"exited"` is never sent over this event (Part 1's
  own constraint, already enforced daemon-side) — no frontend code in this
  plan needs to handle that value.
- Per-tab indicator: `idle` shows **no dot at all** — not a neutral/gray
  dot. Only `working` and `waiting_for_input` render something.
- Sidebar badges show a count of `waiting_for_input` sessions only — not an
  aggregate across all three states. `working` is background information,
  not something a badge draws the eye to (spec's own wording).
- Notification suppression: suppressed whenever gavin's window is the
  OS-frontmost/focused window, **regardless of which pane is internally
  focused** — not scoped to "this exact pane is on screen."
- Exactly two transitions are notification-worthy: a transition *into*
  `waiting_for_input` (from any prior state), and `working` → `idle`. No
  other transition (e.g. `idle` → `working`, or `waiting_for_input` →
  `working`) ever fires a notification.
- Notification permission is requested **lazily** — checked via
  `isPermissionGranted()` on every notification-worthy transition, but
  `requestPermission()` is only ever called the first time a real
  notification-worthy transition occurs, never at app startup.
- This plan ships **no** shell-integration onboarding UI, setup wizard, or
  documentation implying the user must configure their shell. Heuristic-mode
  detection (Part 1) must look complete and correct with zero user setup.
- Every task must leave `npm run check` and `npm test` (run from `app/`)
  fully green before its commit.

---

### Task 1: Add the `tauri-plugin-notification` dependency

**Files:**
- Modify: `app/src-tauri/Cargo.toml`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src-tauri/capabilities/default.json`
- Modify: `app/package.json`

**Interfaces:**
- Produces: the `@tauri-apps/plugin-notification` npm package and its
  matching Rust plugin, registered and permission-granted, ready for
  Task 3's `notifications.ts` to import `isPermissionGranted`,
  `requestPermission`, and `sendNotification` from
  `@tauri-apps/plugin-notification`.

This is pure dependency/config wiring — no application logic. Verified
before writing this plan (do not re-derive): `tauri-plugin-notification`'s
own `default` permission set (`permissions/default.toml` in the plugin's
source, v2) already includes `allow-is-permission-granted`,
`allow-request-permission`, and `allow-notify` — unlike
`clipboard-manager` (this project's own prior lesson, see project memory),
`notification:default` genuinely is sufficient for the three JS functions
this plan needs. Still confirm this yourself against the real generated ACL
in Step 5 below, per this project's standing discipline — don't take even a
verified-in-advance claim as a substitute for checking the actual build
output.

- [ ] **Step 1: Add the Rust dependency**

In `app/src-tauri/Cargo.toml`, find the existing plugin dependencies:

```toml
tauri-plugin-opener = "2"
tauri-plugin-dialog = "2"
tauri-plugin-clipboard-manager = "2"
tauri-plugin-os = "2"
```

Add `tauri-plugin-notification` immediately after, matching the existing
style (unpinned major version `"2"`):

```toml
tauri-plugin-opener = "2"
tauri-plugin-dialog = "2"
tauri-plugin-clipboard-manager = "2"
tauri-plugin-os = "2"
tauri-plugin-notification = "2"
```

- [ ] **Step 2: Register the plugin**

In `app/src-tauri/src/lib.rs`, find the existing plugin registration chain:

```rust
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_os::init())
```

Add the notification plugin immediately after, matching the existing style:

```rust
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
```

- [ ] **Step 3: Add the JS package**

Run:

```bash
cd /Users/coalpila/CloudStation/Coding/gavin/app && npm install @tauri-apps/plugin-notification
```

Expected: `package.json`'s dependencies gain
`"@tauri-apps/plugin-notification": "^2..."` (whatever version npm
resolves), alongside the existing `@tauri-apps/plugin-clipboard-manager`,
`@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-opener`,
`@tauri-apps/plugin-os` entries. `package-lock.json` updates accordingly.

- [ ] **Step 4: Grant the capability**

In `app/src-tauri/capabilities/default.json`, find the `"permissions"` array:

```json
  "permissions": [
    "core:default",
    "core:window:allow-close",
    "core:window:allow-destroy",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-start-dragging",
    "opener:default",
    "dialog:default",
    "clipboard-manager:allow-read-text",
    "clipboard-manager:allow-write-text",
    "os:allow-platform"
  ]
```

Add `"notification:default"` at the end:

```json
  "permissions": [
    "core:default",
    "core:window:allow-close",
    "core:window:allow-destroy",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-start-dragging",
    "opener:default",
    "dialog:default",
    "clipboard-manager:allow-read-text",
    "clipboard-manager:allow-write-text",
    "os:allow-platform",
    "notification:default"
  ]
```

- [ ] **Step 5: Build and verify the actual generated ACL**

Run:

```bash
cd /Users/coalpila/CloudStation/Coding/gavin && source "$HOME/.cargo/env"; cargo build
```

Expected: clean build. Then inspect the generated capability schema Tauri
writes during the build (`app/src-tauri/gen/schemas/*.json` — the same
mechanism this project used to catch the `clipboard-manager:default`
grants-nothing trap previously) and confirm `notification:default` actually
resolves to a non-empty permission set that includes
`notification:allow-is-permission-granted`,
`notification:allow-request-permission`, and `notification:allow-notify`
(or their equivalents under whatever key the generated schema uses). If it
does not, use the explicit identifier list instead of `"notification:default"`
in Step 4 and note this deviation in your task report — don't silently
leave a plugin call that will fail at runtime with a permission error.

- [ ] **Step 6: Run the full check**

Run:

```bash
cd /Users/coalpila/CloudStation/Coding/gavin/app && npm run check && npm test
```

Expected: PASS, no new errors (this task adds no application code, so no
new tests are expected here — Task 3 is the first to actually call these
functions).

- [ ] **Step 7: Commit**

```bash
git add app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock app/src-tauri/src/lib.rs app/src-tauri/capabilities/default.json app/package.json app/package-lock.json
git commit -m "feat(app): add tauri-plugin-notification dependency and capability grant"
```

---

### Task 2: `sessionLabel` — a shared session display-name helper

**Files:**
- Modify: `app/src/lib/paths.ts`
- Modify: `app/src/lib/paths.test.ts`
- Modify: `app/src/lib/Pane.svelte`

**Interfaces:**
- Consumes: nothing new (pure function, no dependencies beyond the
  already-exported `folderName` in the same file).
- Produces: `export function sessionLabel(sessionNames: Record<string, string>, cwdBySessionId: Record<string, string>, sessionId: string): string`
  — Task 5 (Pane.svelte's status dot) does not need this, but Task 4's
  `layoutState.ts` wiring imports it to build a notification body for
  Task 3's `notifications.ts`, which itself stays fully decoupled from
  `layoutState.ts`'s shape (see Task 3's own note on why).

`Pane.svelte`'s existing `tabLabel` function already implements exactly the
fallback chain a notification body needs (custom name → cwd folder name →
short id fragment) — extracting it here means Task 4 doesn't duplicate that
logic, and this task's own test coverage doubles as regression protection
for `Pane.svelte`'s existing tab labels.

- [ ] **Step 1: Write the failing test**

In `app/src/lib/paths.test.ts`, add (the file currently only tests
`folderName`; add this as a new `describe` block, keeping the existing
`folderName` tests and their `import { folderName } from "./paths";` line
unchanged):

```ts
import { sessionLabel } from "./paths";

describe("sessionLabel", () => {
  it("prefers a custom session name over anything else", () => {
    expect(sessionLabel({ "s-1": "my override" }, { "s-1": "/Users/alice/proj" }, "s-1")).toBe("my override");
  });

  it("falls back to the cwd's folder name when there's no custom name", () => {
    expect(sessionLabel({}, { "s-1": "/Users/alice/proj" }, "s-1")).toBe("proj");
  });

  it("falls back to a short id fragment when neither a name nor a cwd is known", () => {
    expect(sessionLabel({}, {}, "abcdefgh-1234-5678")).toBe("abcdefgh");
  });

  it("ignores a blank cwd entry and falls back to the id fragment", () => {
    expect(sessionLabel({}, { "s-1": "" }, "s-1")).toBe("s-1");
  });
});
```

(The last case matters: `cwdBySessionId[sessionId]` can be an empty string
if it's present-but-falsy rather than absent — `sessionId.slice(0, 8)` on
`"s-1"` is `"s-1"` itself since it's under 8 characters, which is why this
test uses a short id; this exercises the falsy-vs-absent branch distinctly
from the "genuinely absent" case the previous test already covers.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm test -- paths.test.ts`
Expected: FAIL with `sessionLabel is not a function` or similar (not yet
exported from `paths.ts`).

- [ ] **Step 3: Implement `sessionLabel`**

In `app/src/lib/paths.ts`, the current full file content is:

```ts
export function folderName(cwd: string): string {
  const segments = cwd.split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : cwd;
}
```

Add `sessionLabel` after it:

```ts
export function folderName(cwd: string): string {
  const segments = cwd.split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : cwd;
}

// The same session display-name fallback chain Pane.svelte's tab labels
// use: a custom name override, then the last path segment of the session's
// known cwd, then a short id fragment. Exported so notifications.ts (via
// layoutState.ts, see that module's own notes) can build a readable
// notification body without duplicating this chain.
export function sessionLabel(
  sessionNames: Record<string, string>,
  cwdBySessionId: Record<string, string>,
  sessionId: string
): string {
  const customName = sessionNames[sessionId];
  if (customName) return customName;
  const cwd = cwdBySessionId[sessionId];
  return cwd ? folderName(cwd) : sessionId.slice(0, 8);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm test -- paths.test.ts`
Expected: PASS, all `sessionLabel` and `folderName` tests green.

- [ ] **Step 5: Refactor `Pane.svelte`'s `tabLabel` to use it**

In `app/src/lib/Pane.svelte`, find the existing `tabLabel` function:

```ts
  function tabLabel(sessionId: string): string {
    const customName = $layoutState.sessionNames[sessionId];
    if (customName) return customName;
    const cwd = $layoutState.cwdBySessionId[sessionId];
    return cwd ? folderName(cwd) : sessionId.slice(0, 8);
  }
```

Replace it with:

```ts
  function tabLabel(sessionId: string): string {
    return sessionLabel($layoutState.sessionNames, $layoutState.cwdBySessionId, sessionId);
  }
```

Find the existing import line:

```ts
  import { folderName } from "./paths";
```

Replace it with (the `folderName` import is no longer used directly in this
file — `tabTooltip`, the other label function in this file, uses the raw
`cwd` value, not `folderName`'s output, so it's untouched by this change):

```ts
  import { sessionLabel } from "./paths";
```

- [ ] **Step 6: Run the full check**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm run check && npm test`
Expected: PASS. `npm run check` in particular confirms the now-unused
`folderName` import was correctly removed (an unused import is a
`svelte-check` warning in this project's configuration).

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/paths.ts app/src/lib/paths.test.ts app/src/lib/Pane.svelte
git commit -m "refactor(app): extract sessionLabel, reused by Pane's tab labels and the upcoming notifications module"
```

---

### Task 3: `notifications.ts` — transition filtering, suppression, lazy permission

**Files:**
- Create: `app/src/lib/notifications.ts`
- Create: `app/src/lib/notifications.test.ts`

**Interfaces:**
- Consumes: `isPermissionGranted`, `requestPermission`, `sendNotification`
  from `@tauri-apps/plugin-notification` (Task 1); `getCurrentWindow` from
  `@tauri-apps/api/window` (already used elsewhere in this codebase, e.g.
  `TitleBar.svelte`).
- Produces: `export type SessionStatus = "idle" | "working" | "waiting_for_input";`
  and `export async function maybeNotifyStatusChange(sessionId: string, previousStatus: SessionStatus | undefined, newStatus: SessionStatus, label: string): Promise<void>`
  — Task 4's `layoutState.ts` calls this, passing an already-resolved
  display `label` string (via Task 2's `sessionLabel`) rather than raw
  session-name/cwd maps. This is deliberate: `notifications.ts` never
  imports `layoutState.ts` or knows its shape, which keeps this module
  fully self-contained and independently testable (and avoids a
  `layoutState.ts` ↔ `notifications.ts` circular import, since Task 4's
  `layoutState.ts` needs to import *this* module to call it).

This task also defines `SessionStatus` as the single source of truth for
the three wire status values — Task 4 imports this type rather than
redefining it.

**Design decision on heuristic-mode notification noise (resolving an open
question from this plan's own dispatch, documented here rather than
silently picked):** project memory from Part 1's completion flags that, in
heuristic mode (any session that has never seen an OSC 133 marker — the
default, zero-setup case), *any* 2-second output pause reads as
`working → idle`, so a buffering `npm install`/`curl`/compile step can fire
a false "finished" notification. The ideal refinement — only notify on
`working → idle` when the working state was OSC-133-derived — needs the
daemon to surface its internal `seen_osc133` flag over the wire, which it
does not do today (`Response::StatusChanged` carries only `{id, status}`,
no per-session detection-mode indicator). Adding that would be a Part 1
(backend) protocol change, out of scope for this frontend-only plan. This
task therefore implements the spec's literal two-transition rule exactly as
written (`isNotificationWorthy` below), accepting the documented
heuristic-mode false-positive rate as-is rather than silently building
around it or silently leaving it unaddressed. If this proves too noisy in
practice once used, the fix is a small follow-up plan surfacing
`seen_osc133` as a new field on the existing `StatusChanged` event (additive
to the wire shape, not a breaking change) — not something to speculatively
build now against an unconfirmed problem.

- [ ] **Step 1: Write the failing tests**

Create `app/src/lib/notifications.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(),
}));

import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { maybeNotifyStatusChange } from "./notifications";

function mockWindow(isFocused: boolean): void {
  vi.mocked(getCurrentWindow).mockReturnValue({ isFocused: vi.fn().mockResolvedValue(isFocused) } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWindow(false);
  vi.mocked(isPermissionGranted).mockResolvedValue(true);
});

describe("maybeNotifyStatusChange", () => {
  it("notifies on a transition into waiting_for_input", async () => {
    await maybeNotifyStatusChange("s-1", "working", "waiting_for_input", "my-project");
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendNotification).mock.calls[0][0] as { title: string; body: string };
    expect(call.body).toContain("my-project");
  });

  it("notifies on a transition into waiting_for_input even from idle (not just from working)", async () => {
    await maybeNotifyStatusChange("s-1", "idle", "waiting_for_input", "my-project");
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("notifies on working -> idle", async () => {
    await maybeNotifyStatusChange("s-1", "working", "idle", "my-project");
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("does not notify on idle -> working", async () => {
    await maybeNotifyStatusChange("s-1", "idle", "working", "my-project");
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does not notify on waiting_for_input -> working", async () => {
    await maybeNotifyStatusChange("s-1", "waiting_for_input", "working", "my-project");
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does not notify when there is no previous status and the new status isn't waiting_for_input", async () => {
    // The very first StatusChanged a session ever receives (previousStatus
    // undefined) is a baseline, not a transition -- idle/working as a
    // first-ever value must never read as "working -> idle" or similar.
    await maybeNotifyStatusChange("s-1", undefined, "idle", "my-project");
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does notify when the very first status a session ever receives is waiting_for_input", async () => {
    await maybeNotifyStatusChange("s-1", undefined, "waiting_for_input", "my-project");
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("suppresses the notification entirely when the window is frontmost", async () => {
    mockWindow(true);
    await maybeNotifyStatusChange("s-1", "working", "idle", "my-project");
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does not notify when permission was never granted and the user declines the lazy request", async () => {
    vi.mocked(isPermissionGranted).mockResolvedValue(false);
    vi.mocked(requestPermission).mockResolvedValue("denied");
    await maybeNotifyStatusChange("s-1", "working", "idle", "my-project");
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("requests permission only once across multiple notification-worthy transitions, not on every one", async () => {
    vi.mocked(isPermissionGranted).mockResolvedValue(false);
    vi.mocked(requestPermission).mockResolvedValue("denied");
    await maybeNotifyStatusChange("s-1", "working", "idle", "my-project");
    await maybeNotifyStatusChange("s-2", "working", "idle", "other-project");
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("does not call requestPermission at all once permission is already granted", async () => {
    vi.mocked(isPermissionGranted).mockResolvedValue(true);
    await maybeNotifyStatusChange("s-1", "working", "idle", "my-project");
    expect(requestPermission).not.toHaveBeenCalled();
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("checks window focus before ever touching permission state, for a non-notification-worthy transition", async () => {
    await maybeNotifyStatusChange("s-1", "idle", "working", "my-project");
    expect(isPermissionGranted).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm test -- notifications.test.ts`
Expected: FAIL — `./notifications` doesn't exist yet.

- [ ] **Step 3: Implement `notifications.ts`**

Create `app/src/lib/notifications.ts`:

```ts
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type SessionStatus = "idle" | "working" | "waiting_for_input";

// Requested at most once per app run -- after a denied (or not-yet-decided)
// result, this stays true so a later notification-worthy transition
// doesn't re-prompt the OS permission dialog every single time. If the
// user later grants it via OS settings, isPermissionGranted() picks that
// up on its own on the next call; this flag only ever gates
// requestPermission() itself, not the isPermissionGranted() check.
let permissionRequested = false;

async function ensurePermission(): Promise<boolean> {
  if (await isPermissionGranted()) return true;
  if (permissionRequested) return false;
  permissionRequested = true;
  return (await requestPermission()) === "granted";
}

function isNotificationWorthy(previousStatus: SessionStatus | undefined, newStatus: SessionStatus): boolean {
  if (newStatus === "waiting_for_input") return true;
  return previousStatus === "working" && newStatus === "idle";
}

// Called for every status transition a session reports; no-ops unless the
// specific transition is one of the two the design calls out as actually
// worth interrupting the user for. previousStatus is undefined for a
// session's very first-ever status report (its Attach-time baseline) --
// that's never treated as a transition, since there's nothing to
// transition *from*, except waiting_for_input, which is always
// notification-worthy regardless of what (if anything) came before it.
export async function maybeNotifyStatusChange(
  sessionId: string,
  previousStatus: SessionStatus | undefined,
  newStatus: SessionStatus,
  label: string
): Promise<void> {
  if (!isNotificationWorthy(previousStatus, newStatus)) return;

  // Suppressed whenever gavin is the OS-frontmost window at all, regardless
  // of which pane is internally focused -- being in front of the app
  // already means the in-app status dot/badge is enough; checked before
  // touching permission state so a suppressed notification never
  // needlessly prompts for permission either.
  if (await getCurrentWindow().isFocused()) return;

  if (!(await ensurePermission())) return;

  const body = newStatus === "waiting_for_input" ? `${label} needs your input` : `${label} finished`;
  sendNotification({ title: "gavin", body });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm test -- notifications.test.ts`
Expected: PASS, all 12 tests green.

- [ ] **Step 5: Run the full check**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm run check && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/notifications.ts app/src/lib/notifications.test.ts
git commit -m "feat(app): add notifications.ts -- transition filtering, frontmost suppression, lazy permission"
```

---

### Task 4: Wire `sessionStatusById` into `layoutState.ts`

**Files:**
- Modify: `app/src/lib/layoutState.ts`
- Modify: `app/src/lib/layoutState.test.ts`
- Modify: `app/src/lib/confirmClose.test.ts`

**Interfaces:**
- Consumes: `SessionStatus`, `maybeNotifyStatusChange` from `./notifications`
  (Task 3); `sessionLabel` from `./paths` (Task 2).
- Produces: `LayoutState.sessionStatusById: Record<string, SessionStatus>`;
  `export function handleSessionStatusChanged(sessionId: string, status: SessionStatus): void`
  — Task 5 (`Pane.svelte`) and Task 6 (`Sidebar.svelte`) both read
  `$layoutState.sessionStatusById` directly, the same way they already read
  `$layoutState.cwdBySessionId`.

Adding a new required field to `LayoutState` breaks every existing
full-object-literal construction of that type, regardless of task
boundaries — the same class of gap this project's own Workspaces Part 1
plan hit for its Rust schema (see project memory: "additive-first"
migration lesson) applies here to TypeScript. This task fixes every such
site as part of its own scope, not a follow-up.

- [ ] **Step 1: Write the failing test for the new action**

In `app/src/lib/layoutState.test.ts`, add `vi.mock("./notifications", ...)`
alongside the existing mocks near the top of the file. Find:

```ts
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
```

Add immediately after it:

```ts
vi.mock("./notifications", () => ({
  maybeNotifyStatusChange: vi.fn(),
}));
```

Find the import block:

```ts
import * as backend from "./backend";
import {
  layoutState,
  splitPane,
  addTab,
  closeSession,
  switchToTab,
  focusPane,
  handleSessionExited,
  handleCwdChanged,
  closePane,
  setSessionName,
  createWorkspace,
  renameWorkspace,
  switchWorkspace,
  closeWorkspace,
  createPage,
  renamePage,
  switchPage,
  closePage,
  movePaneOrTab,
  reorderTabWithinPane,
  reorderWorkspaceAction,
  movePageAction,
  bootstrap,
  teardown,
} from "./layoutState";
```

Replace it with (adding the `./notifications` import and
`handleSessionStatusChanged` to the `./layoutState` import list):

```ts
import * as backend from "./backend";
import * as notifications from "./notifications";
import {
  layoutState,
  splitPane,
  addTab,
  closeSession,
  switchToTab,
  focusPane,
  handleSessionExited,
  handleCwdChanged,
  handleSessionStatusChanged,
  closePane,
  setSessionName,
  createWorkspace,
  renameWorkspace,
  switchWorkspace,
  closeWorkspace,
  createPage,
  renamePage,
  switchPage,
  closePage,
  movePaneOrTab,
  reorderTabWithinPane,
  reorderWorkspaceAction,
  movePageAction,
  bootstrap,
  teardown,
} from "./layoutState";
```

Every full `LayoutState` object literal in this file needs
`sessionStatusById: {}` added alongside the existing `cwdBySessionId: {}`
field. There are exactly two such literals in this file. Find (in the
`setState` helper function):

```ts
function setState(workspaces: Workspace[], activeWorkspaceId: string | null, focusedSessionId: string | null): void {
  layoutState.set({
    status: "ready",
    errorMessage: "",
    workspaces,
    activeWorkspaceId,
    focusedSessionId,
    cwdBySessionId: {},
    sessionNames: {},
  });
}
```

Replace with:

```ts
function setState(workspaces: Workspace[], activeWorkspaceId: string | null, focusedSessionId: string | null): void {
  layoutState.set({
    status: "ready",
    errorMessage: "",
    workspaces,
    activeWorkspaceId,
    focusedSessionId,
    cwdBySessionId: {},
    sessionNames: {},
    sessionStatusById: {},
  });
}
```

Find (in the `beforeEach` block):

```ts
beforeEach(() => {
  vi.clearAllMocks();
  layoutState.set({
    status: "connecting",
    errorMessage: "",
    workspaces: [],
    activeWorkspaceId: null,
    focusedSessionId: null,
    cwdBySessionId: {},
    sessionNames: {},
  });
});
```

Replace with:

```ts
beforeEach(() => {
  vi.clearAllMocks();
  layoutState.set({
    status: "connecting",
    errorMessage: "",
    workspaces: [],
    activeWorkspaceId: null,
    focusedSessionId: null,
    cwdBySessionId: {},
    sessionNames: {},
    sessionStatusById: {},
  });
});
```

Now add the new test. Find the existing `describe("handleCwdChanged", ...)`
block and add this immediately after it:

```ts
describe("handleSessionStatusChanged", () => {
  it("stores the new status under the session's id", () => {
    handleSessionStatusChanged("a", "working");
    expect(get(layoutState).sessionStatusById["a"]).toBe("working");
  });

  it("overwrites a previous status for the same session", () => {
    handleSessionStatusChanged("a", "working");
    handleSessionStatusChanged("a", "idle");
    expect(get(layoutState).sessionStatusById["a"]).toBe("idle");
  });

  it("leaves other sessions' statuses untouched", () => {
    handleSessionStatusChanged("a", "working");
    handleSessionStatusChanged("b", "waiting_for_input");
    expect(get(layoutState).sessionStatusById).toEqual({ a: "working", b: "waiting_for_input" });
  });

  it("hands the previous and new status to maybeNotifyStatusChange, before overwriting the map", () => {
    handleSessionStatusChanged("a", "working");
    handleSessionStatusChanged("a", "idle");
    expect(notifications.maybeNotifyStatusChange).toHaveBeenNthCalledWith(1, "a", undefined, "working", "a");
    expect(notifications.maybeNotifyStatusChange).toHaveBeenNthCalledWith(2, "a", "working", "idle", "a");
  });

  it("resolves the notification label via sessionNames, falling back the same way tab labels do", () => {
    setState([], null, null);
    layoutState.update((s) => ({ ...s, sessionNames: { a: "my-session" } }));
    handleSessionStatusChanged("a", "waiting_for_input");
    expect(notifications.maybeNotifyStatusChange).toHaveBeenCalledWith("a", undefined, "waiting_for_input", "my-session");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm test -- layoutState.test.ts`
Expected: FAIL to even compile/run — `handleSessionStatusChanged` isn't
exported yet, and `sessionStatusById` isn't a valid `LayoutState` field yet.

- [ ] **Step 3: Extend `LayoutState` and add the action**

In `app/src/lib/layoutState.ts`, find the top imports:

```ts
import { writable, get } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { LayoutNode } from "./layout";
import * as layout from "./layout";
import * as backend from "./backend";
import * as terminalRegistry from "./terminalRegistry";
import * as workspace from "./workspace";
import type { Workspace, WorkspacesData } from "./workspace";
```

Replace with:

```ts
import { writable, get } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { LayoutNode } from "./layout";
import * as layout from "./layout";
import * as backend from "./backend";
import * as terminalRegistry from "./terminalRegistry";
import * as workspace from "./workspace";
import type { Workspace, WorkspacesData } from "./workspace";
import { sessionLabel } from "./paths";
import { maybeNotifyStatusChange, type SessionStatus } from "./notifications";

export type { SessionStatus };
```

(Re-exporting `SessionStatus` from `layoutState.ts` means Task 5/6's
`Pane.svelte`/`Sidebar.svelte` can import it from the same module they
already import `layoutState` from, if they need the type — they don't
strictly need to for this plan's own tasks, but this keeps the type
discoverable from the state module that owns the field using it, matching
how `Workspace`/`Page` are re-exported from `workspace.ts` and imported by
`Sidebar.svelte` today.)

Find the `LayoutState` interface and `initialState`:

```ts
export interface LayoutState {
  status: "connecting" | "ready" | "error";
  errorMessage: string;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  focusedSessionId: string | null;
  cwdBySessionId: Record<string, string>;
  sessionNames: Record<string, string>;
}

const initialState: LayoutState = {
  status: "connecting",
  errorMessage: "",
  workspaces: [],
  activeWorkspaceId: null,
  focusedSessionId: null,
  cwdBySessionId: {},
  sessionNames: {},
};
```

Replace with:

```ts
export interface LayoutState {
  status: "connecting" | "ready" | "error";
  errorMessage: string;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  focusedSessionId: string | null;
  cwdBySessionId: Record<string, string>;
  sessionNames: Record<string, string>;
  sessionStatusById: Record<string, SessionStatus>;
}

const initialState: LayoutState = {
  status: "connecting",
  errorMessage: "",
  workspaces: [],
  activeWorkspaceId: null,
  focusedSessionId: null,
  cwdBySessionId: {},
  sessionNames: {},
  sessionStatusById: {},
};
```

Find the existing `handleCwdChanged` function:

```ts
// Shared by the "cwd-changed" event listener in bootstrap() and this
// file's own tests. Entries are never removed when a session closes; a
// stale in-memory map entry per session that ever existed in one app run
// is not a meaningful memory concern.
export function handleCwdChanged(sessionId: string, cwd: string): void {
  layoutState.update((s) => ({ ...s, cwdBySessionId: { ...s.cwdBySessionId, [sessionId]: cwd } }));
}
```

Add `handleSessionStatusChanged` immediately after it:

```ts
// Shared by the "cwd-changed" event listener in bootstrap() and this
// file's own tests. Entries are never removed when a session closes; a
// stale in-memory map entry per session that ever existed in one app run
// is not a meaningful memory concern.
export function handleCwdChanged(sessionId: string, cwd: string): void {
  layoutState.update((s) => ({ ...s, cwdBySessionId: { ...s.cwdBySessionId, [sessionId]: cwd } }));
}

// Shared by the "session-status-changed" event listener in bootstrap() and
// this file's own tests. Reads the *previous* status before overwriting
// the map -- undefined for a session's first-ever status report -- and
// hands both values plus a resolved display label to notifications.ts,
// which decides whether the specific transition is worth an OS
// notification. Like handleCwdChanged, entries are never removed on
// session exit.
export function handleSessionStatusChanged(sessionId: string, status: SessionStatus): void {
  const state = get(layoutState);
  const previousStatus = state.sessionStatusById[sessionId];
  layoutState.update((s) => ({ ...s, sessionStatusById: { ...s.sessionStatusById, [sessionId]: status } }));
  const label = sessionLabel(state.sessionNames, state.cwdBySessionId, sessionId);
  void maybeNotifyStatusChange(sessionId, previousStatus, status, label);
}
```

Find `bootstrap()`'s existing `"cwd-changed"` listener:

```ts
  unlisteners.push(
    await listen<[string, string]>("cwd-changed", (event) => {
      handleCwdChanged(event.payload[0], event.payload[1]);
    })
  );
```

Add the new listener immediately after it:

```ts
  unlisteners.push(
    await listen<[string, string]>("cwd-changed", (event) => {
      handleCwdChanged(event.payload[0], event.payload[1]);
    })
  );
  unlisteners.push(
    await listen<[string, SessionStatus]>("session-status-changed", (event) => {
      handleSessionStatusChanged(event.payload[0], event.payload[1]);
    })
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm test -- layoutState.test.ts`
Expected: PASS, all `handleSessionStatusChanged` tests green plus every
pre-existing test in this file still green (confirming the two literal-object
fixups in Step 1 were both necessary and sufficient).

- [ ] **Step 5: Fix the remaining literal-object construction site**

`app/src/lib/confirmClose.test.ts` also constructs a full `LayoutState`
object literal, independently of `layoutState.test.ts`. Find:

```ts
function setActivePage(workspaces: Workspace[], activeWorkspaceId: string | null): void {
  layoutState.set({
    status: "ready",
    errorMessage: "",
    workspaces,
    activeWorkspaceId,
    focusedSessionId: null,
    cwdBySessionId: {},
    sessionNames: {},
  });
}
```

Replace with:

```ts
function setActivePage(workspaces: Workspace[], activeWorkspaceId: string | null): void {
  layoutState.set({
    status: "ready",
    errorMessage: "",
    workspaces,
    activeWorkspaceId,
    focusedSessionId: null,
    cwdBySessionId: {},
    sessionNames: {},
    sessionStatusById: {},
  });
}
```

- [ ] **Step 6: Run the full check**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm run check && npm test`
Expected: PASS across every test file — `npm run check` in particular is
what would catch any *other* full-`LayoutState`-literal construction site
this plan's own file-reading missed, since a missing required field is a
TypeScript compile error, not a silent runtime gap.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/layoutState.ts app/src/lib/layoutState.test.ts app/src/lib/confirmClose.test.ts
git commit -m "feat(app): wire sessionStatusById and handleSessionStatusChanged into layoutState"
```

---

### Task 5: Per-tab status dot (`Pane.svelte`)

**Files:**
- Modify: `app/src/lib/Pane.svelte`

**Interfaces:**
- Consumes: `$layoutState.sessionStatusById` (Task 4).

No new test file — this task is pure Svelte template/style, in the same
file whose existing drag-and-drop and tab-rename logic already has no
dedicated automated tests (verified per this project's own consistently-
documented "GUI-only, manually verified" limitation for exactly this class
of change). `npm run check` still validates the template compiles and
types correctly.

- [ ] **Step 1: Add a status-dot helper and render it**

In `app/src/lib/Pane.svelte`, find the existing `tabLabel`/`tabTooltip`
functions (now using `sessionLabel`, per Task 2):

```ts
  function tabLabel(sessionId: string): string {
    return sessionLabel($layoutState.sessionNames, $layoutState.cwdBySessionId, sessionId);
  }

  function tabTooltip(sessionId: string): string {
    return $layoutState.sessionNames[sessionId] ?? $layoutState.cwdBySessionId[sessionId] ?? sessionId;
  }
```

Add a new helper immediately after `tabTooltip`:

```ts
  function tabTooltip(sessionId: string): string {
    return $layoutState.sessionNames[sessionId] ?? $layoutState.cwdBySessionId[sessionId] ?? sessionId;
  }

  // idle intentionally returns null here -- no dot at all is the idle
  // indicator, not a neutral-colored one (see this plan's Global
  // Constraints). waiting_for_input is "request attention" in the UI --
  // the internal/data-model name stays unchanged, matching the existing
  // Rust enum.
  function tabStatusDot(sessionId: string): { class: string; title: string } | null {
    const status = $layoutState.sessionStatusById[sessionId];
    if (status === "working") return { class: "status-working", title: "Working" };
    if (status === "waiting_for_input") return { class: "status-waiting", title: "Request attention" };
    return null;
  }
```

Find the tab button's label rendering:

```ts
        {#if editingSessionId === sessionId}
          <input
            class="tab-label-input"
            bind:this={editInput}
            bind:value={editValue}
            onclick={(e) => e.stopPropagation()}
            onblur={commitEdit}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelEdit();
              }
            }}
          />
        {:else}
          <Tooltip text={tabTooltip(sessionId)}>
            <span class="tab-label" ondblclick={() => startEditing(sessionId)}>{tabLabel(sessionId)}</span>
          </Tooltip>
        {/if}
```

Replace with (adding the status dot right after the label/input, before the
close button):

```ts
        {#if editingSessionId === sessionId}
          <input
            class="tab-label-input"
            bind:this={editInput}
            bind:value={editValue}
            onclick={(e) => e.stopPropagation()}
            onblur={commitEdit}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelEdit();
              }
            }}
          />
        {:else}
          <Tooltip text={tabTooltip(sessionId)}>
            <span class="tab-label" ondblclick={() => startEditing(sessionId)}>{tabLabel(sessionId)}</span>
          </Tooltip>
        {/if}
        {#if tabStatusDot(sessionId)}
          {@const dot = tabStatusDot(sessionId)}
          <span class="status-dot {dot?.class}" title={dot?.title}></span>
        {/if}
```

- [ ] **Step 2: Add the dot's styles**

In `app/src/lib/Pane.svelte`'s `<style>` block, find:

```css
  .tab-label {
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
```

Add immediately after it:

```css
  .tab-label {
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .status-dot.status-working {
    background: #4a9eff;
  }
  .status-dot.status-waiting {
    background: #e0524a;
  }
```

- [ ] **Step 3: Run the full check**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm run check && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/Pane.svelte
git commit -m "feat(app): render a per-tab working/request-attention status dot"
```

---

### Task 6: Sidebar `waiting_for_input` count badges

**Files:**
- Modify: `app/src/lib/Sidebar.svelte`

**Interfaces:**
- Consumes: `$layoutState.sessionStatusById` (Task 4); `layout.allSessionIds`
  (already exists, used elsewhere in this codebase, e.g. `layoutState.ts`'s
  `closePage`).

Same as Task 5: pure Svelte template/style, no dedicated test file, matching
this project's established convention for this exact class of UI-only
change; `npm run check` validates it compiles and types correctly.

- [ ] **Step 1: Import `allSessionIds` and add count helpers**

In `app/src/lib/Sidebar.svelte`, find the existing import:

```ts
  import { presetSingle } from "./layout";
```

Replace with:

```ts
  import { presetSingle, allSessionIds } from "./layout";
```

Find the `isExpanded`/`toggleExpand` functions:

```ts
  function isExpanded(workspaceId: string): boolean {
    return expanded.has(workspaceId);
  }

  function toggleExpand(workspaceId: string): void {
```

Add two new helper functions immediately before `isExpanded`:

```ts
  // The count this plan's sidebar badges show -- waiting_for_input only,
  // never a generic aggregate across all three states (see this plan's
  // Global Constraints: "working" is background information, not
  // something a badge needs to draw the eye to).
  function waitingForInputCount(page: Page): number {
    return allSessionIds(page.layout).filter((id) => $layoutState.sessionStatusById[id] === "waiting_for_input").length;
  }

  function workspaceWaitingForInputCount(ws: Workspace): number {
    return ws.pages.reduce((sum, page) => sum + waitingForInputCount(page), 0);
  }

  function isExpanded(workspaceId: string): boolean {
    return expanded.has(workspaceId);
  }

  function toggleExpand(workspaceId: string): void {
```

- [ ] **Step 2: Render the page-row badge**

Find, inside the `{#snippet pageList(ws: Workspace)}` block:

```ts
        {:else}
          <span
            class="page-name"
            ondblclick={() => startEditingPage(page.id, page.name)}
            onclick={() => switchPage(ws.id, page.id)}
          >{page.name}</span>
        {/if}
        <button
          class="close-page"
```

Replace with (adding the badge between the name and the close button):

```ts
        {:else}
          <span
            class="page-name"
            ondblclick={() => startEditingPage(page.id, page.name)}
            onclick={() => switchPage(ws.id, page.id)}
          >{page.name}</span>
        {/if}
        {#if waitingForInputCount(page) > 0}
          <span class="waiting-badge">{waitingForInputCount(page)}</span>
        {/if}
        <button
          class="close-page"
```

- [ ] **Step 3: Render the workspace-row badges**

There are two workspace-row blocks (the pinned Unfiled row and the regular,
reorderable list) — both need the badge. Find the pinned row's markup:

```ts
          <span class="workspace-name" onclick={() => switchWorkspace(ws.id)}>{ws.name}</span>
          <button class="add-page" aria-label="New Page" title="New Page" onclick={() => quickAddPage(ws.id)}>
            <Plus size={12} />
          </button>
        </div>
        {#if isExpanded(ws.id)}
          {@render pageList(ws)}
        {/if}
      </div>
    {/if}
```

Replace with:

```ts
          <span class="workspace-name" onclick={() => switchWorkspace(ws.id)}>{ws.name}</span>
          {#if workspaceWaitingForInputCount(ws) > 0}
            <span class="waiting-badge">{workspaceWaitingForInputCount(ws)}</span>
          {/if}
          <button class="add-page" aria-label="New Page" title="New Page" onclick={() => quickAddPage(ws.id)}>
            <Plus size={12} />
          </button>
        </div>
        {#if isExpanded(ws.id)}
          {@render pageList(ws)}
        {/if}
      </div>
    {/if}
```

Find the regular-workspaces row's equivalent markup (this one has the
editable-name conditional, unlike the pinned row above — the badge goes
after that whole `{#if editingWorkspaceId === ws.id} ... {:else} ... {/if}`
block, not inside either branch):

```ts
          {:else}
            <span
              class="workspace-name"
              ondblclick={() => startEditingWorkspace(ws.id, ws.name)}
              onclick={() => switchWorkspace(ws.id)}
            >{ws.name}</span>
          {/if}
          <button class="add-page" aria-label="New Page" title="New Page" onclick={() => quickAddPage(ws.id)}>
```

Replace with:

```ts
          {:else}
            <span
              class="workspace-name"
              ondblclick={() => startEditingWorkspace(ws.id, ws.name)}
              onclick={() => switchWorkspace(ws.id)}
            >{ws.name}</span>
          {/if}
          {#if workspaceWaitingForInputCount(ws) > 0}
            <span class="waiting-badge">{workspaceWaitingForInputCount(ws)}</span>
          {/if}
          <button class="add-page" aria-label="New Page" title="New Page" onclick={() => quickAddPage(ws.id)}>
```

- [ ] **Step 4: Add the badge's styles**

In `app/src/lib/Sidebar.svelte`'s `<style>` block, find:

```css
  .add-page,
  .close-workspace,
  .close-page {
    background: transparent;
    border: none;
    color: #999;
    cursor: pointer;
    padding: 2px;
    opacity: 0.6;
    flex: 0 0 auto;
  }
```

Add immediately before it:

```css
  .waiting-badge {
    flex: 0 0 auto;
    background: #e0524a;
    color: #fff;
    border-radius: 8px;
    padding: 0 5px;
    font-size: 0.85em;
    line-height: 1.4;
    min-width: 14px;
    text-align: center;
  }
  .add-page,
  .close-workspace,
  .close-page {
    background: transparent;
    border: none;
    color: #999;
    cursor: pointer;
    padding: 2px;
    opacity: 0.6;
    flex: 0 0 auto;
  }
```

- [ ] **Step 5: Run the full check**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm run check && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/Sidebar.svelte
git commit -m "feat(app): add waiting_for_input count badges to sidebar page and workspace rows"
```

---

## Not covered by this plan (deliberately, per the design spec)

- Any shell-integration setup UI/onboarding/documentation — the spec's own
  non-goal, restated here since it is easy to accidentally reach for once
  the heuristic's coarseness becomes visible in testing.
- An "exited" pane UI — out of scope per the spec; sessions are still
  simply removed from the tree on exit.
- Notification click-through/actions — a plain notification is sufficient
  for this milestone.
- Manual GUI verification of the dot colors, badge counts, and an actual OS
  notification appearing — per this project's consistently-documented
  limitation, these need a human with the real Tauri window and (for the
  notification permission dialog specifically) real macOS notification
  permission state, neither available in the automated verification
  environment. Flag this explicitly in the final report rather than
  claiming full verification.
