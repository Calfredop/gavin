# UI Design Tokens & Light/Dark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the app a two-tier CSS token system and an app-global Light/Dark/System preference that visibly repaints the application shell.

**Architecture:** A theme-independent primitive ramp plus a semantic alias layer re-pointed per theme, in one plain `.css` file imported once from a new `+layout.svelte`. A pure TS module resolves preference + system appearance into an effective theme; a Svelte 5 `$state` store stamps it on `<html data-theme>`. Persistence joins the existing `persist_workspaces` funnel in Rust rather than adding a second save path.

**Tech Stack:** SvelteKit 2 (Svelte 5 runes, `ssr = false`), Tauri 2, vitest, Rust (serde/anyhow).

**Spec:** `docs/superpowers/specs/2026-08-21-ui-design-tokens-design.md`

## Global Constraints

- All frontend paths are relative to `app/`. Run `npm test` from `app/`; run `cargo test` from `app/src-tauri/`.
- Frontend tests are colocated as `<module>.test.ts` next to the module, and must be `include`d by `src/**/*.{test,spec}.ts` (vite.config.js).
- `theme.css` must be a plain `.css` file, never a Svelte `<style>` block — Svelte scopes component styles and would compile the `:root` rules away.
- Bare `:root` carries the **dark** values. Dark is the fallback everywhere (spec §4.2, §5.1).
- Tier-2 token names are fixed by spec §4.2 — exactly these 22, no additions: `--surface-base`, `--surface-raised`, `--surface-overlay`, `--surface-sunken`, `--surface-hover`, `--surface-selected`, `--border`, `--border-strong`, `--border-focus`, `--text`, `--text-muted`, `--text-subtle`, `--text-inverted`, `--accent`, `--accent-hover`, `--accent-text`, `--success`, `--success-text`, `--warning`, `--warning-text`, `--danger`, `--danger-text`.
- `--ws-accent` and `--row-accent` are **not** part of this system. Do not rename, re-point, or remove them.
- Rust: every `persist_workspaces` call site must pass the new theme argument. There are six.
- Commit after each task.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/ui/theme.css` | CREATE — tier 1 ramps, tier 2 roles, both themes |
| `src/lib/ui/theme.ts` | CREATE — pure `resolveTheme`, `parseThemePref`; no I/O |
| `src/lib/ui/theme.test.ts` | CREATE — unit tests for the above |
| `src/lib/ui/themeState.svelte.ts` | CREATE — `$state` store, Tauri wiring, DOM stamping |
| `src/routes/+layout.svelte` | CREATE — imports `theme.css`, renders children |
| `src/app.html` | MODIFY — pre-boot `data-theme` stamp |
| `src/lib/backend.ts` | MODIFY — `getThemePref` / `setThemePref` wrappers |
| `src-tauri/src/config.rs` | MODIFY — `AppConfig.theme` + tests |
| `src-tauri/src/session.rs` | MODIFY — `ThemePref` state, funnel param, 2 commands |
| `src-tauri/src/lib.rs` | MODIFY — `manage` + `invoke_handler` registration |
| `src/lib/SettingsHubView.svelte` | MODIFY — Appearance section |
| `src/routes/+page.svelte`, `TitleBar`, `Sidebar`, `Pane`, `WindowControls` | MODIFY — beachhead migration |

---

### Task 1: Pure theme resolution

**Files:**
- Create: `app/src/lib/ui/theme.ts`
- Test: `app/src/lib/ui/theme.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type ThemePref = "light" | "dark" | "system"`; `type EffectiveTheme = "light" | "dark"`; `resolveTheme(pref: ThemePref, system: EffectiveTheme | null): EffectiveTheme`; `parseThemePref(value: string | null | undefined): ThemePref`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { resolveTheme, parseThemePref, type ThemePref } from "./theme";

describe("resolveTheme", () => {
  it("returns an explicit preference regardless of the system appearance", () => {
    for (const system of ["light", "dark", null] as const) {
      expect(resolveTheme("light", system)).toBe("light");
      expect(resolveTheme("dark", system)).toBe("dark");
    }
  });

  it("follows the system appearance when the preference is system", () => {
    expect(resolveTheme("system", "light")).toBe("light");
    expect(resolveTheme("system", "dark")).toBe("dark");
  });

  it("falls back to dark when system is unavailable", () => {
    expect(resolveTheme("system", null)).toBe("dark");
  });
});

describe("parseThemePref", () => {
  it("accepts the three valid literals", () => {
    for (const pref of ["light", "dark", "system"] as ThemePref[]) {
      expect(parseThemePref(pref)).toBe(pref);
    }
  });

  it("falls back to system for anything else", () => {
    for (const bad of ["", "  ", "Dark", "auto", "#fff", "light; x"]) {
      expect(parseThemePref(bad)).toBe("system");
    }
    expect(parseThemePref(null)).toBe("system");
    expect(parseThemePref(undefined)).toBe("system");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npm test -- src/lib/ui/theme.test.ts`
Expected: FAIL — cannot resolve `./theme`.

- [ ] **Step 3: Write minimal implementation**

```ts
/// The user's stored choice. "system" defers to the OS appearance.
export type ThemePref = "light" | "dark" | "system";

/// What actually gets stamped on <html data-theme>. Never "system".
export type EffectiveTheme = "light" | "dark";

const PREFS: readonly string[] = ["light", "dark", "system"];

/// Dark is the fallback rather than light because dark is the app's
/// look today: a platform that cannot report an appearance keeps the
/// current behaviour instead of flipping to a theme nobody chose.
export function resolveTheme(pref: ThemePref, system: EffectiveTheme | null): EffectiveTheme {
  if (pref !== "system") return pref;
  return system ?? "dark";
}

/// Guards a hand-edited config.json, mirroring normalizeColor in
/// settings.ts: anything that isn't one of the three literals is
/// treated as unset rather than trusted.
export function parseThemePref(value: string | null | undefined): ThemePref {
  if (typeof value !== "string") return "system";
  const trimmed = value.trim();
  return PREFS.includes(trimmed) ? (trimmed as ThemePref) : "system";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npm test -- src/lib/ui/theme.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/ui/theme.ts app/src/lib/ui/theme.test.ts
git commit -m "feat(ui): pure theme resolution"
```

---

### Task 2: The token stylesheet

**Files:**
- Create: `app/src/lib/ui/theme.css`
- Create: `app/src/routes/+layout.svelte`

**Interfaces:**
- Consumes: nothing.
- Produces: the 22 tier-2 custom properties on `:root`, resolving under `[data-theme="dark"]` and `[data-theme="light"]`.

- [ ] **Step 1: Write `theme.css`**

Tier 1 values are fixed by spec §4.1. `NEW` marks values not previously in the codebase.

```css
/* Tier 1 -- primitive ramps. Theme-independent: defined once, never
   redefined. Components must NOT reference these directly; they exist
   so the tier-2 roles below can be re-pointed per theme. */
:root {
  --grey-0: #1a1a1a;   --grey-8: #888;
  --grey-1: #1e1e1e;   --grey-9: #999;
  --grey-2: #232323;   --grey-10: #bbb;
  --grey-3: #2f2f2f;   --grey-11: #ddd;
  --grey-4: #3a3a3a;   --grey-12: #eee;
  --grey-5: #444;      --grey-13: #f4f4f4;  /* NEW */
  --grey-6: #555;      --grey-14: #fbfbfb;  /* NEW */
  --grey-7: #666;      --grey-15: #fff;

  --blue-1: #2a3a4a;  --blue-2: #4a6a8a;  --blue-3: #4a9eff;
  --blue-4: #7ea8d8;  --blue-5: #d3e4f7;                      /* 5 NEW */

  --green-1: #2c4a2c;  --green-2: #3f6b3f;  --green-3: #6b8e6b;
  --green-4: #8bc98b;  --green-5: #cfe8cf;                     /* 1 NEW */

  --red-1: #7a3030;  --red-2: #b03a32;  --red-3: #e0524a;
  --red-4: #e08a8a;  --red-5: #f0c0c0;                         /* 2 NEW */

  --amber-1: #6b3d1f;  --amber-2: #a15c2f;  --amber-3: #d9a648;
  --amber-4: #d9b45c;  --amber-5: #e0b08a;                     /* 1 NEW */
}

/* Tier 2 -- semantic roles. Bare :root carries the DARK values so that
   every failure path (pre-boot stamp missing, config unreadable, system
   appearance unavailable) lands on the app's current look. */
:root,
:root[data-theme="dark"] {
  --surface-base: var(--grey-1);
  --surface-raised: var(--grey-3);
  --surface-overlay: var(--grey-4);
  --surface-sunken: var(--grey-0);
  --surface-hover: var(--grey-2);
  --surface-selected: var(--grey-4);

  --border: var(--grey-4);
  --border-strong: var(--grey-6);
  --border-focus: var(--blue-3);

  --text: var(--grey-12);
  --text-muted: var(--grey-9);
  --text-subtle: var(--grey-7);
  --text-inverted: var(--grey-0);

  --accent: var(--blue-3);
  --accent-hover: var(--blue-4);
  --accent-text: var(--blue-4);

  --success: var(--green-4);
  --success-text: var(--green-4);
  --warning: var(--amber-3);
  --warning-text: var(--amber-3);
  --danger: var(--red-3);
  --danger-text: var(--red-4);
}

/* Light borders step INWARD rather than mirroring the dark ones: an
   equal-contrast hairline reads much heavier on a light surface. */
:root[data-theme="light"] {
  --surface-base: var(--grey-15);
  --surface-raised: var(--grey-14);
  --surface-overlay: var(--grey-15);
  --surface-sunken: var(--grey-13);
  --surface-hover: var(--grey-13);
  --surface-selected: var(--grey-12);

  --border: var(--grey-11);
  --border-strong: var(--grey-10);
  --border-focus: var(--blue-3);

  --text: var(--grey-0);
  --text-muted: var(--grey-7);
  --text-subtle: var(--grey-8);
  --text-inverted: var(--grey-15);

  /* Fills stay vivid; anything that renders as TEXT drops to blue-2,
     which clears 4.5:1 on white where blue-3 does not. */
  --accent: var(--blue-3);
  --accent-hover: var(--blue-2);
  --accent-text: var(--blue-2);

  --success: var(--green-2);
  --success-text: var(--green-1);
  --warning: var(--amber-2);
  --warning-text: var(--amber-1);
  --danger: var(--red-2);
  --danger-text: var(--red-1);
}
```

- [ ] **Step 2: Create `+layout.svelte`**

The repo has `+layout.ts` (which sets `ssr = false`) but no `+layout.svelte`. This one exists only to pull the stylesheet in once.

```svelte
<script lang="ts">
  // The app's only global stylesheet. Imported here rather than in a
  // component <style> block because Svelte scopes those, which would
  // compile the :root rules away.
  import "$lib/ui/theme.css";

  let { children } = $props();
</script>

{@render children()}
```

- [ ] **Step 3: Verify the app still builds**

Run: `cd app && npm run check`
Expected: no new errors (pre-existing warnings are fine).

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/ui/theme.css app/src/routes/+layout.svelte
git commit -m "feat(ui): two-tier design token stylesheet"
```

---

### Task 3: Rust persistence

**Files:**
- Modify: `app/src-tauri/src/config.rs` (`AppConfig`, test module)
- Modify: `app/src-tauri/src/session.rs` (`ThemePref`, `persist_workspaces`, 6 call sites, 2 commands)
- Modify: `app/src-tauri/src/lib.rs` (`manage`, `invoke_handler`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: Tauri commands `get_theme_pref() -> Option<String>` and `set_theme_pref(theme: Option<String>) -> Result<(), String>`.

- [ ] **Step 1: Write the failing tests**

Add to the `config.rs` test module:

```rust
#[test]
fn theme_roundtrips() {
    let dir = tempfile::tempdir().unwrap();
    let config = AppConfig { theme: Some("light".to_string()), ..Default::default() };
    save(dir.path(), &config).unwrap();
    assert_eq!(load(dir.path()).unwrap().theme, Some("light".to_string()));
}

#[test]
fn absent_theme_loads_as_none() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(config_path(dir.path()), r#"{"workspaces":[]}"#).unwrap();
    assert_eq!(load(dir.path()).unwrap().theme, None);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app/src-tauri && cargo test theme_roundtrips absent_theme_loads_as_none`
Expected: FAIL — `AppConfig` has no field `theme`.

- [ ] **Step 3: Add the field**

In `config.rs`, inside `AppConfig` after `board_tabs`:

```rust
    /// App-global light/dark preference: "light", "dark", or absent for
    /// System -- the same "absent means default" convention as
    /// `Workspace::color`. Like session_names/file_tabs/board_tabs this
    /// must be carried through `persist_workspaces`, or it silently
    /// resets on the next save.
    #[serde(default)]
    pub theme: Option<String>,
```

Then fix the exhaustive struct literals in the existing tests (e.g. `save_then_load_roundtrips`) by adding `theme: None,`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd app/src-tauri && cargo test --lib config::`
Expected: PASS.

- [ ] **Step 5: Thread it through the funnel**

In `session.rs`, next to `BoardTabs`:

```rust
/// App-global light/dark preference. Same always-carry persistence
/// contract as FileTabs/BoardTabs.
pub struct ThemePref(pub Mutex<Option<String>>);
```

Add a `theme: Option<String>` parameter to `persist_workspaces` and pass it into the `AppConfig` literal. Update **all six** call sites (`session.rs:234, 270, 298, 328, 1091`, plus the new setter in step 6) to read `theme_state.0.lock().unwrap().clone()` — each of those commands needs a `theme_state: State<ThemePref>` parameter added.

- [ ] **Step 6: Add the commands**

```rust
#[tauri::command]
pub fn get_theme_pref(state: State<ThemePref>) -> Option<String> {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_theme_pref(
    theme: Option<String>,
    app_handle: AppHandle,
    state: State<WorkspacesState>,
    names_state: State<SessionNames>,
    file_tabs_state: State<FileTabs>,
    board_tabs_state: State<BoardTabs>,
    theme_state: State<ThemePref>,
) -> Result<(), String> {
    // An absent/blank value clears the override back to System rather
    // than persisting an empty string -- same shape as set_session_name.
    let theme = {
        let mut current = theme_state.0.lock().unwrap();
        *current = theme.filter(|t| !t.trim().is_empty());
        current.clone()
    };
    let data = state.0.lock().unwrap().clone();
    let session_names = names_state.0.lock().unwrap().clone();
    let file_tabs = file_tabs_state.0.lock().unwrap().clone();
    let board_tabs = board_tabs_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    persist_workspaces(&config_dir, &data, session_names, file_tabs, board_tabs, theme)
        .map_err(|e| e.to_string())
}
```

In `lib.rs`: `.manage(session::ThemePref(std::sync::Mutex::new(None)))` alongside the other `manage` calls, seeded from the loaded config at bootstrap the same way the other states are; and add `session::get_theme_pref, session::set_theme_pref` to `invoke_handler`.

- [ ] **Step 7: Add the regression test**

This is the test D48 exists to justify — it proves saving workspaces cannot wipe the theme.

```rust
#[test]
fn persist_workspaces_carries_theme_through() {
    let dir = tempfile::tempdir().unwrap();
    let data = WorkspacesData { workspaces: vec![], active_workspace_id: None };
    persist_workspaces(
        dir.path(), &data, HashMap::new(), HashMap::new(), HashMap::new(),
        Some("light".to_string()),
    ).unwrap();
    assert_eq!(crate::config::load(dir.path()).unwrap().theme, Some("light".to_string()));
}
```

- [ ] **Step 8: Run the full Rust suite**

Run: `cd app/src-tauri && cargo test`
Expected: PASS, including the new tests.

- [ ] **Step 9: Commit**

```bash
git add app/src-tauri/src/config.rs app/src-tauri/src/session.rs app/src-tauri/src/lib.rs
git commit -m "feat(ui): persist the app-global theme preference"
```

---

### Task 4: Wire it up

**Files:**
- Create: `app/src/lib/ui/themeState.svelte.ts`
- Modify: `app/src/app.html`
- Modify: `app/src/lib/backend.ts`
- Modify: `app/src/lib/layoutState.ts` (`bootstrap`)

**Interfaces:**
- Consumes: `resolveTheme`, `parseThemePref` (Task 1); `get_theme_pref`/`set_theme_pref` (Task 3).
- Produces: the singleton `themeState`, with reactive `.pref: ThemePref` and `.effective: EffectiveTheme`, and methods `init(): Promise<void>` and `setPref(pref: ThemePref): Promise<void>`.

- [ ] **Step 1: Pre-boot stamp in `app.html`**

Add inside `<head>`, before `%sveltekit.head%`. This runs before first paint; the real preference arrives asynchronously and corrects it.

```html
<script>
  // Pre-boot guess so the first frame isn't the wrong theme. The stored
  // preference comes from Tauri asynchronously and overwrites this.
  try {
    document.documentElement.dataset.theme =
      window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch (_) {
    document.documentElement.dataset.theme = "dark";
  }
</script>
```

- [ ] **Step 2: Backend wrappers in `backend.ts`**

```ts
export function getThemePref(): Promise<string | null> {
  return invoke("get_theme_pref");
}

export function setThemePref(theme: string | null): Promise<void> {
  return invoke("set_theme_pref", { theme });
}
```

- [ ] **Step 3: The store**

```ts
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as backend from "../backend";
import { resolveTheme, parseThemePref, type ThemePref, type EffectiveTheme } from "./theme";

/// "system" is stored as null on the Rust side (absent means default),
/// so it never round-trips as the literal string.
function toStored(pref: ThemePref): string | null {
  return pref === "system" ? null : pref;
}

class ThemeStore {
  pref = $state<ThemePref>("system");
  effective = $state<EffectiveTheme>("dark");

  #apply(system: EffectiveTheme | null): void {
    this.effective = resolveTheme(this.pref, system);
    document.documentElement.dataset.theme = this.effective;
  }

  async #systemTheme(): Promise<EffectiveTheme | null> {
    try {
      const t = await getCurrentWindow().theme();
      return t === "light" || t === "dark" ? t : null;
    } catch {
      // No Tauri window (e.g. vitest, or a browser preview) -- treated
      // as "system unavailable", which resolveTheme maps to dark.
      return null;
    }
  }

  async init(): Promise<void> {
    try {
      this.pref = parseThemePref(await backend.getThemePref());
    } catch {
      this.pref = "system";
    }
    this.#apply(await this.#systemTheme());
    try {
      await getCurrentWindow().onThemeChanged(({ payload }) => {
        // Only meaningful while following the system; an explicit
        // preference must not be overridden by an OS schedule change.
        if (this.pref === "system") {
          this.#apply(payload === "light" ? "light" : "dark");
        }
      });
    } catch {
      // Listener unavailable -- the resolved theme still stands.
    }
  }

  async setPref(pref: ThemePref): Promise<void> {
    this.pref = pref;
    this.#apply(await this.#systemTheme());
    // A failed write leaves the theme applied in memory but unpersisted,
    // matching how the other settings writes behave.
    await backend.setThemePref(toStored(pref)).catch(() => {});
  }
}

export const themeState = new ThemeStore();
```

- [ ] **Step 4: Call it from `bootstrap()`**

In `layoutState.ts`, at the top of `bootstrap()`, before the listener registrations:

```ts
  // Ahead of the workspace listeners: the theme should be correct on the
  // first painted frame, and it has no dependency on workspace state.
  await themeState.init();
```

with `import { themeState } from "./ui/themeState.svelte";` added to the imports.

- [ ] **Step 5: Verify**

Run: `cd app && npm test && npm run check`
Expected: all tests pass; no new check errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/app.html app/src/lib/backend.ts app/src/lib/ui/themeState.svelte.ts app/src/lib/layoutState.ts
git commit -m "feat(ui): resolve and apply the theme at boot"
```

---

### Task 5: The Appearance control

**Files:**
- Modify: `app/src/lib/SettingsHubView.svelte`

**Interfaces:**
- Consumes: `themeState` (Task 4).
- Produces: nothing consumed downstream.

- [ ] **Step 1: Add the section**

The existing sections are per-workspace; this one is not, so it says so. Place it after the Notifications section, following the established `<section><h3>` + `.row` markup.

```svelte
    <section>
      <h3>Appearance</h3>
      <div class="row">
        <span>Theme</span>
        <select
          value={themeState.pref}
          onchange={(e) => void themeState.setPref(e.currentTarget.value as ThemePref)}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
      <p class="hint">Applies to the whole app, not just this workspace.</p>
    </section>
```

Add imports: `import { themeState } from "./ui/themeState.svelte";` and `import type { ThemePref } from "./ui/theme";`.

No new CSS is needed: `SettingsHubView.svelte` already styles `h3` (line 257), `.row` (265), `.row > span:first-child` (271), `.row select` (277) and `.hint` (293), and `.hint` is already used this way at lines 161 and 167.

- [ ] **Step 2: Verify**

Run: `cd app && npm run check`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/SettingsHubView.svelte
git commit -m "feat(ui): Light/Dark/System control in settings"
```

---

### Task 6: Beachhead migration

**Files:**
- Modify: `app/src/routes/+page.svelte`, `app/src/lib/TitleBar.svelte`, `app/src/lib/Sidebar.svelte`, `app/src/lib/Pane.svelte`, `app/src/lib/WindowControls.svelte`

**Interfaces:**
- Consumes: the 22 tier-2 tokens (Task 2).
- Produces: nothing consumed downstream.

Mapping to apply, per spec §4.2 and D50:

| Literal | Token | Where it means this |
|---|---|---|
| `#1e1e1e` | `--surface-base` | app/pane backgrounds |
| `#2f2f2f`, `#2a2a2a` | `--surface-raised` | panels, sidebar |
| `#3a3a3a` | `--surface-overlay` | **when a background** (D50) |
| `#3a3a3a`, `#444` | `--border` | **when a border** (D50) |
| `#555` | `--border-strong` | hover borders |
| `#eee`, `#ddd` | `--text` | primary text |
| `#999`, `#aaa` | `--text-muted` | secondary text |
| `#666`, `#777` | `--text-subtle` | tertiary/disabled |
| `#4a9eff` | `--accent` | accent fills |
| `#7ea8d8`, `#8ab4e0` | `--accent-text` | run actions, links |
| `#8bc98b` | `--success` | ahead counts, added |
| `#d9a648`, `#d9b45c` | `--warning` | dirty state |
| `#e0524a` | `--danger` | errors, close hover |

- [ ] **Step 1: Migrate, one file per commit**

For each of the five files, replace the literals in its `<style>` block per the table. Judge each `#3a3a3a` by the property it sets — `background`/`background-color` → `--surface-overlay`; `border`/`border-*-color`/`outline` → `--border`.

Leave untouched: `var(--ws-accent, #4a9eff)` and `var(--row-accent, transparent)` fallbacks, and the `:global(html, body)` reset in `+page.svelte`.

- [ ] **Step 2: Confirm no literals remain in the five files**

Run:
```bash
cd app && grep -nE "#[0-9a-fA-F]{3,8}\b" src/routes/+page.svelte src/lib/TitleBar.svelte \
  src/lib/Sidebar.svelte src/lib/Pane.svelte src/lib/WindowControls.svelte
```
Expected: only the `--ws-accent`/`--row-accent` fallbacks.

- [ ] **Step 3: Verify**

Run: `cd app && npm test && npm run check`
Expected: all tests pass; no new errors.

- [ ] **Step 4: Manual visual pass**

Launch the app. In Settings → Appearance, switch System → Light → Dark. Confirm for each: the title bar, sidebar, pane tabs and window controls all repaint; the workspace accent stripe and focused-tab indicator still show the workspace's chosen colour; text stays legible throughout. Expect the terminal, editor and all non-beachhead views to stay dark — that is SP3/SP4 (spec §7).

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/+page.svelte app/src/lib/TitleBar.svelte app/src/lib/Sidebar.svelte \
  app/src/lib/Pane.svelte app/src/lib/WindowControls.svelte
git commit -m "refactor(ui): migrate the app shell to design tokens"
```

---

## Done criteria

- `npm test` and `cargo test` both pass.
- Switching Light/Dark/System in Settings repaints the shell and survives a restart.
- The five beachhead files contain no colour literals except the two accent fallbacks.
- Known-incomplete by design (spec §7): 47 components, xterm and CodeMirror stay dark under Light.
