# Terminal Core Refinements — Plan 3: Custom Window Chrome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the OS title bar entirely, replace it with a hand-drawn, OS-conditionally-aligned window-controls bar, and fold the existing toolbar actions into that same strip.

**Architecture:** `tauri.conf.json` gets `"decorations": false`, removing native chrome on every platform. A new `platform.ts` helper (backed by a new `@tauri-apps/plugin-os` dependency) tells the frontend whether it's running on macOS. A new `WindowControls.svelte` renders either three hover-revealed circular "traffic light" buttons (macOS) or three square icon buttons (everywhere else), both wired to the same `getCurrentWindow()` minimize/toggleMaximize/close calls — critically, the close button calls `.close()`, not `.destroy()`, so it triggers the exact same `CloseRequested` event `+page.svelte`'s already-shipped confirm-before-close dialog already intercepts, reusing that flow rather than duplicating it. A new `TitleBar.svelte` absorbs the existing `Toolbar.svelte`'s split/close-pane/preset actions, lays them out on the opposite side from the window controls (OS-conditionally), with a `data-tauri-drag-region` spacer between them so the window remains draggable by its empty space. `Toolbar.svelte` is retired. `TitleBar` renders unconditionally at the top of `+page.svelte` — not just in the "ready" state — since it's now the *only* way to close or minimize the window at all, a guarantee native chrome used to provide in every app state.

**Tech Stack:** Tauri 2 window API (`@tauri-apps/api/window`, already a dependency, already used for `.destroy()`/`.onCloseRequested()`), `@tauri-apps/plugin-os` + `tauri-plugin-os` (new dependency, both npm and Cargo sides), `@lucide/svelte` (already a dependency, already used elsewhere in this project for icons).

## Global Constraints

- `decorations: false` in `tauri.conf.json`'s window config removes native chrome on every platform — this is a static config value, not a runtime permission-gated API call, so it needs no capability grant of its own.
- **Window controls need explicit capability grants beyond `core:default`** — the same lesson this project has now hit three times (window close/destroy in an earlier milestone, clipboard read/write in a later one): a plugin's or core feature's "default" permission set is never safe to assume, and sometimes grants nothing at all (`clipboard-manager:default` was found to grant zero commands). Verify the exact identifiers against the actually-generated ACL schema after building, for both the window-minimize/toggle-maximize permissions and the new `@tauri-apps/plugin-os` permission — do not trust this plan's best-guess names (`core:window:allow-minimize`, `core:window:allow-toggle-maximize`, `os:default`) without checking.
- **The close button must call `.close()`, never `.destroy()`.** `.close()` fires `CloseRequested`, which `+page.svelte`'s existing `onCloseRequested` handler already intercepts to show the "your sessions will keep running" confirm dialog — reusing that flow is the entire point. `.destroy()` bypasses `CloseRequested` and would skip the confirmation entirely, a real regression (this exact `.close()`-vs-`.destroy()` distinction was learned the hard way once already in this project, for the opposite direction — the confirm dialog's own "yes" button needs `.destroy()` specifically to avoid re-triggering itself; the *new* custom close button is a different call site with the opposite requirement, since it should trigger the interception, not bypass it).
- **`TitleBar` must render unconditionally**, above/outside `+page.svelte`'s `status`-conditional overlay branches (`"connecting"`/`"error"`/empty-tree) — not only in the "ready with tree" state the old `<Toolbar />` was confined to. Once native decorations are gone, the custom window controls are the *only* way to minimize or close the window in any app state; confining them to one branch would make the window uncloseable-via-UI while connecting or on a daemon error, a real regression from today's native-chrome-always-present behavior.
- **`data-tauri-drag-region` goes only on an empty spacer element**, never on a wrapper that also contains buttons — nesting interactive buttons inside a drag-region element risks the drag behavior swallowing their clicks on some Tauri versions. The bar's layout is: [window-controls group] [drag-region spacer, flex-grow] [action-buttons group], order flipped by OS.
- **macOS traffic-light convention**: three circular buttons, left-aligned, left-to-right order close/minimize/maximize (red/yellow/green), icons invisible by default and revealed together on hover over the whole group via CSS — not always-visible icons, that's not how real traffic lights behave.
- **Non-macOS convention**: minimize/maximize/close as square icon buttons, right-aligned, Windows ordering (minimize, maximize, close) — always-visible icons (no hover-reveal), matching Windows/most-Linux-DE conventions rather than macOS's.
- **Toolbar action buttons and their click handlers are moved verbatim from the existing, already-shipped `Toolbar.svelte`** — same `splitPane`/`closePane`/`applyPreset` calls, same confirm-gating via `confirmPaneClose` (from an earlier plan), same icon choices. This plan does not change what those buttons do, only where they live.
- **No new automated test surface** — this plan is window-chrome/Tauri-config work with no pure logic to unit-test (mirrors how earlier Tauri-plugin/capability work in this project, e.g. the clipboard integration, had no new automated tests either). Verification is `cargo build`, `npm run check`, `npm run build`, and reading the generated ACL — GUI/interactive behavior (does dragging actually move the window, do the buttons actually minimize/maximize/close, does the OS-conditional layout render correctly) has no automated coverage in this project's agent environment, a documented, standing limitation. This is the one refinement in this whole three-plan batch that changes how the *window itself* behaves, so flag it clearly in every task's report as needing a human at the keyboard before considering it truly done.
- Work happens directly on `main` (no worktree) — an explicit, standing preference for every plan in this project so far.

---

### Task 1: Enable custom decorations, add OS detection

**Files:**
- Modify: `app/src-tauri/tauri.conf.json`
- Modify: `app/src-tauri/Cargo.toml`
- Modify: `app/package.json`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src-tauri/capabilities/default.json`
- Create: `app/src/lib/platform.ts`

**Interfaces:**
- Produces: `isMacOS(): Promise<boolean>` in `platform.ts` — consumed by Task 3's `TitleBar.svelte`. Wrapped in a `Promise` regardless of whether the underlying plugin call turns out to be sync or async (an `await` on a non-Promise value resolves immediately, so this is safe either way and the call site never needs to know or care which).

- [ ] **Step 1: Remove native decorations**

Open `app/src-tauri/tauri.conf.json`. Add `"decorations": false` to the single window entry under `app.windows`:

```json
  "app": {
    "windows": [
      {
        "title": "gavin",
        "width": 1000,
        "height": 700,
        "decorations": false
      }
    ],
    "security": {
      "csp": null
    }
  },
```

(Everything else in the file is unchanged.)

- [ ] **Step 2: Add the OS-detection dependency**

```bash
cd app && npm install @tauri-apps/plugin-os
```

Open `app/src-tauri/Cargo.toml`. Add `tauri-plugin-os = "2"` to `[dependencies]`, alongside the existing `tauri-plugin-opener`/`tauri-plugin-dialog`/`tauri-plugin-clipboard-manager` entries:

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"
tauri-plugin-dialog = "2"
tauri-plugin-clipboard-manager = "2"
tauri-plugin-os = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
anyhow = "1"
protocol = { path = "../../crates/protocol" }
```

- [ ] **Step 3: Register the plugin**

Open `app/src-tauri/src/lib.rs`. Add `.plugin(tauri_plugin_os::init())` alongside the existing plugin registrations:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_clipboard_manager::init())
    .plugin(tauri_plugin_os::init())
    .manage(session::FrontendReady(std::sync::atomic::AtomicBool::new(false)))
```

- [ ] **Step 4: Build to generate the permission schema, then verify and grant the real identifiers**

Run: `cd app/src-tauri && cargo build`
Expected: builds successfully. This regenerates `app/src-tauri/gen/schemas/` (gitignored, never committed) with every permission identifier the newly-registered `os` plugin actually exposes, alongside the window-control permissions core already defines.

Read the generated schema (e.g. `app/src-tauri/gen/schemas/desktop-schema.json` or wherever the build places it) and confirm, rather than assume:
1. The exact permission identifier for reading the platform (this plan's best guess is `os:default`, but per this project's own hard-learned lesson, a plugin's `:default` permission set sometimes grants nothing at all — check whether `os:default` actually includes the `platform` command, or whether a more specific identifier like `os:allow-platform` is what's actually needed).
2. The exact permission identifiers for `minimize()`/`toggleMaximize()` on the core window API (this plan's best guess is `core:window:allow-minimize`/`core:window:allow-toggle-maximize` — verify both exist with those exact names).

Open `app/src-tauri/capabilities/default.json` and add whatever the verified identifiers turn out to be, alongside the existing permissions:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-close",
    "core:window:allow-destroy",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "opener:default",
    "dialog:default",
    "clipboard-manager:allow-read-text",
    "clipboard-manager:allow-write-text",
    "os:default"
  ]
}
```

(Use the actually-confirmed identifiers in place of any of this plan's guesses that turned out wrong.)

- [ ] **Step 5: Implement `platform.ts`**

Verify the exact import path and the exact string `platform()` returns for macOS (this plan's best guess: the function is `platform` exported from `@tauri-apps/plugin-os`, and it returns `"macos"` on macOS) against the installed package's type definitions (`node_modules/@tauri-apps/plugin-os`) before finalizing — the same verify-don't-assume discipline as Step 4's permission identifiers.

Create `app/src/lib/platform.ts`:

```typescript
import { platform } from "@tauri-apps/plugin-os";

export async function isMacOS(): Promise<boolean> {
  return (await platform()) === "macos";
}
```

- [ ] **Step 6: Verify**

Run: `cd app/src-tauri && cargo build`
Expected: builds cleanly.

Run: `cd app && npm run check`
Expected: no type errors.

Run: `cd app && npm run build`
Expected: builds cleanly.

No automated test exists for this task (per Global Constraints). Note in your report that you cannot verify decorations are actually gone, or that `isMacOS()` returns the correct value on this machine, without a human running the built app.

- [ ] **Step 7: Commit**

```bash
git add app/src-tauri/tauri.conf.json app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock \
  app/package.json app/package-lock.json app/src-tauri/src/lib.rs \
  app/src-tauri/capabilities/default.json app/src/lib/platform.ts
git commit -m "feat(app): remove native window decorations, add OS detection"
```

(`app/src-tauri/gen/schemas/` is gitignored — do not add it.)

---

### Task 2: `WindowControls.svelte`

**Files:**
- Create: `app/src/lib/WindowControls.svelte`

**Interfaces:**
- Consumes: Task 1's OS-detection result, passed in as a prop (this component doesn't call `isMacOS()` itself — `TitleBar`, Task 3, resolves it once and passes it down, so both the window-controls' layout choice and `TitleBar`'s own OS-conditional bar-ordering stay in sync from one source of truth).
- Produces: `WindowControls.svelte` component, props `{ macOS: boolean }`. Consumed by Task 3's `TitleBar.svelte`.

- [ ] **Step 1: Implement `WindowControls.svelte`**

Create `app/src/lib/WindowControls.svelte`:

```svelte
<script lang="ts">
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { X, Minus, Square } from "@lucide/svelte";

  let { macOS }: { macOS: boolean } = $props();

  function minimize(): void {
    getCurrentWindow().minimize();
  }

  function toggleMaximize(): void {
    getCurrentWindow().toggleMaximize();
  }

  function close(): void {
    // close(), not destroy() -- close() fires CloseRequested, which
    // +page.svelte's existing onCloseRequested handler already intercepts
    // with the "your sessions will keep running" confirm dialog. Reusing
    // that flow here (rather than duplicating a second confirm prompt) is
    // the whole reason this calls close() instead of destroy().
    getCurrentWindow().close();
  }
</script>

{#if macOS}
  <div class="mac-controls">
    <button class="mac-btn close" aria-label="Close" title="Close" onclick={close}>
      <X size={8} />
    </button>
    <button class="mac-btn minimize" aria-label="Minimize" title="Minimize" onclick={minimize}>
      <Minus size={8} />
    </button>
    <button class="mac-btn maximize" aria-label="Maximize" title="Maximize" onclick={toggleMaximize}>
      <Square size={6} />
    </button>
  </div>
{:else}
  <div class="default-controls">
    <button aria-label="Minimize" title="Minimize" onclick={minimize}>
      <Minus size={14} />
    </button>
    <button aria-label="Maximize" title="Maximize" onclick={toggleMaximize}>
      <Square size={14} />
    </button>
    <button aria-label="Close" title="Close" class="close" onclick={close}>
      <X size={14} />
    </button>
  </div>
{/if}

<style>
  .mac-controls {
    display: flex;
    gap: 8px;
    padding: 0 12px;
    align-items: center;
  }
  .mac-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: none;
    padding: 0;
    cursor: pointer;
    color: transparent;
  }
  .mac-controls:hover .mac-btn {
    color: rgba(0, 0, 0, 0.5);
  }
  .mac-btn.close {
    background: #ff5f57;
  }
  .mac-btn.minimize {
    background: #febc2e;
  }
  .mac-btn.maximize {
    background: #28c840;
  }

  .default-controls {
    display: flex;
    align-items: center;
    height: 100%;
  }
  .default-controls button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 100%;
    background: transparent;
    border: none;
    color: #ccc;
    cursor: pointer;
  }
  .default-controls button:hover {
    background: #3a3a3a;
  }
  .default-controls button.close:hover {
    background: #e81123;
    color: #fff;
  }
</style>
```

- [ ] **Step 2: Verify**

Run: `cd app && npm run check`
Expected: no type errors.

Run: `cd app && npm run build`
Expected: builds cleanly.

No automated GUI test exists for this task. Note in your report that actual button clicks (does minimize/maximize/close genuinely act on the window), hover-reveal behavior on the macOS variant, and visual appearance are all unverified pending a human at the keyboard — this component isn't mounted anywhere yet (Task 3 does that).

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/WindowControls.svelte
git commit -m "feat(app): add OS-conditional window control buttons"
```

---

### Task 3: `TitleBar.svelte` — absorb the toolbar, retire `Toolbar.svelte`, mount unconditionally

**Files:**
- Create: `app/src/lib/TitleBar.svelte`
- Delete: `app/src/lib/Toolbar.svelte`
- Modify: `app/src/routes/+page.svelte`

**Interfaces:**
- Consumes: Task 1's `isMacOS()`; Task 2's `WindowControls.svelte`; `layoutState.ts`'s existing `layoutState`/`splitPane`/`closePane`/`applyPreset` (unchanged, already shipped); `layout.ts`'s existing preset builders (unchanged, already shipped); `confirmClose.ts`'s existing `confirmPaneClose` (unchanged, already shipped).
- Produces: `TitleBar.svelte` component (no props), mounted unconditionally at the top of `+page.svelte`. Nothing here is consumed by any later task — this is the last task in this plan.

- [ ] **Step 1: Implement `TitleBar.svelte`**

Create `app/src/lib/TitleBar.svelte` — this is `Toolbar.svelte`'s existing script and action buttons, moved verbatim, plus the new OS-conditional bar structure:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { layoutState, splitPane, closePane, applyPreset } from "./layoutState";
  import { presetSingle, presetSideBySide, presetGrid2x2 } from "./layout";
  import { confirmPaneClose } from "./confirmClose";
  import { Columns2, Rows2, X, Square, Grid2x2 } from "@lucide/svelte";
  import WindowControls from "./WindowControls.svelte";
  import { isMacOS } from "./platform";

  let macOS = $state(false);
  onMount(async () => {
    macOS = await isMacOS();
  });

  async function split(direction: "row" | "column"): Promise<void> {
    const id = $layoutState.focusedSessionId;
    if (id) await splitPane(id, direction);
  }

  async function handleClosePane(): Promise<void> {
    const id = $layoutState.focusedSessionId;
    if (!id) return;
    if (await confirmPaneClose(id)) {
      await closePane(id);
    }
  }

  async function applySingle(): Promise<void> {
    await applyPreset(([id]) => presetSingle(id), 1);
  }
  async function applySideBySide(): Promise<void> {
    await applyPreset(([a, b]) => presetSideBySide(a, b), 2);
  }
  async function applyGrid(): Promise<void> {
    await applyPreset(([a, b, c, d]) => presetGrid2x2(a, b, c, d), 4);
  }
</script>

{#snippet actions()}
  <button aria-label="Split Right" title="Split Right" onclick={() => split("row")}>
    <Columns2 size={16} />
  </button>
  <button aria-label="Split Down" title="Split Down" onclick={() => split("column")}>
    <Rows2 size={16} />
  </button>
  <button aria-label="Close Pane" title="Close Pane" onclick={handleClosePane}>
    <X size={16} />
  </button>
  <div class="presets">
    <span>Presets:</span>
    <button onclick={applySingle}><Square size={14} /> Single</button>
    <button onclick={applySideBySide}><Columns2 size={14} /> Side by Side</button>
    <button onclick={applyGrid}><Grid2x2 size={14} /> 2×2 Grid</button>
  </div>
{/snippet}

<div class="titlebar">
  {#if macOS}
    <WindowControls {macOS} />
    <div class="drag-spacer" data-tauri-drag-region></div>
    <div class="actions">{@render actions()}</div>
  {:else}
    <div class="actions">{@render actions()}</div>
    <div class="drag-spacer" data-tauri-drag-region></div>
    <WindowControls {macOS} />
  {/if}
</div>

<style>
  .titlebar {
    display: flex;
    align-items: center;
    background: #2a2a2a;
    color: #ccc;
    font-family: sans-serif;
    font-size: 0.8em;
    flex: 0 0 auto;
    height: 40px;
  }
  .drag-spacer {
    flex: 1 1 auto;
    height: 100%;
  }
  .actions {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 4px 8px;
  }
  .actions button {
    display: flex;
    align-items: center;
    gap: 4px;
    background: #3a3a3a;
    border: none;
    color: #ccc;
    padding: 4px 8px;
    border-radius: 3px;
    cursor: pointer;
  }
  .actions button:hover {
    background: #4a4a4a;
  }
  .presets {
    display: flex;
    gap: 4px;
    align-items: center;
    margin-left: 8px;
  }
</style>
```

- [ ] **Step 2: Retire `Toolbar.svelte`**

```bash
git rm app/src/lib/Toolbar.svelte
```

- [ ] **Step 3: Mount `TitleBar` unconditionally in `+page.svelte`**

Open `app/src/routes/+page.svelte`. Replace the `Toolbar` import with `TitleBar`:

```typescript
import TitleBar from "$lib/TitleBar.svelte";
```

(Remove the old `import Toolbar from "$lib/Toolbar.svelte";` line.)

Restructure the template so `<TitleBar />` renders unconditionally, above/outside the status-conditional branches — **this is the one behavior-affecting change in this task**, since it's what keeps the window closeable/minimizable in every app state, not just "ready":

```svelte
<div class="app">
  <TitleBar />
  {#if $layoutState.status === "connecting"}
    <div class="overlay">
      <p>Connecting…</p>
    </div>
  {:else if $layoutState.status === "error"}
    <div class="overlay">
      <p>Couldn't connect to the daemon.</p>
      <p class="detail">{$layoutState.errorMessage}</p>
    </div>
  {:else if $layoutState.tree}
    <div class="tree">
      <LayoutTree node={$layoutState.tree} path={[]} />
    </div>
  {:else}
    <div class="overlay">
      <button onclick={newSessionFromEmpty}>New Session</button>
    </div>
  {/if}
</div>
```

(Note `<Toolbar />` is simply gone from the `{:else if $layoutState.tree}` branch — its job is now `<TitleBar />` at the top, unconditionally. `<LayoutTree>` and everything else in that branch, and the other branches, are otherwise unchanged. The `<script>` block's `import LayoutTree from "$lib/LayoutTree.svelte";` line and everything else in the file besides the two changes above stays exactly as it is.)

- [ ] **Step 4: Verify**

Run: `cd app && npm run check`
Expected: no type errors, and no dangling reference to the deleted `Toolbar.svelte` anywhere.

Run: `grep -rn "lib/Toolbar" app/src` (or equivalent)
Expected: no matches.

Run: `cd app && npm run build`
Expected: builds cleanly.

Run: `cd app && npm test`
Expected: full existing suite still green (this task touches no tested logic, but confirm nothing regressed).

No automated GUI test exists for this task. This is the final integration task for this plan — your report must clearly list everything that still needs a human at the keyboard: does the native title bar genuinely no longer appear on this platform; does dragging the empty part of the new bar move the window; do minimize/maximize/close actually work; does the close button correctly trigger the existing confirm dialog rather than closing immediately; does the OS-conditional layout (traffic lights vs. square buttons, which side the actions land on) render correctly for this machine's OS; do the split/new-tab/close-pane/preset actions still work correctly now that they live in `TitleBar` instead of `Toolbar`; is the bar visible and are its window controls usable during the "Connecting…" and error states, not just once a layout is ready.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/TitleBar.svelte app/src/routes/+page.svelte
git commit -m "feat(app): fold toolbar into a custom, always-visible title bar"
```

## Self-Review Notes

- **Spec coverage:** every element of spec section 3 maps to a task — no native title bar (Task 1's `decorations: false`), custom OS-conditionally-aligned window controls (Tasks 1-2), the freed space hosting toolbar actions (Task 3). Mouse-drag text selection (mentioned in the overall refinements spec's section 1 context, not this section) is unrelated to this plan and untouched.
- **Placeholder scan:** none — every step has complete, concrete code. The three genuinely uncertain details (the OS-plugin's exact permission identifier, the window-minimize/toggle-maximize permission identifiers, and the exact macOS platform string) are each called out as explicit verify-don't-assume steps with a clear reason and a stated best guess, not glossed over.
- **Type consistency:** `isMacOS(): Promise<boolean>` (Task 1) is awaited with that exact signature in `TitleBar.svelte` (Task 3). `WindowControls`'s `{ macOS: boolean }` prop (Task 2) is passed `{macOS}` from `TitleBar`'s own `macOS` state (Task 3) — same name, same type, single source of truth for the OS-conditional decision in both the controls' visual style and the bar's left/right ordering.
- **Behavioral regression check (the reason Task 3's Step 3 change is called out explicitly)**: before this plan, native window chrome meant close/minimize were always available in any app state. This plan's `TitleBar` must render unconditionally to preserve that guarantee — a plan that confined it to the "ready" branch (mirroring old `Toolbar.svelte`'s placement too literally) would introduce a real regression: an unresponsive daemon connection would leave the user with no way to close the window at all.
