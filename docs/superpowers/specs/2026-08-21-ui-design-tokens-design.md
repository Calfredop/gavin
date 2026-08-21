# UI Design Tokens & Light/Dark — Design (sub-project 1 of 4)

**Status:** approved 2026-08-21. Sub-project 1 of four in the UI
unification effort; sub-projects 2–4 (IconButton primitive, component
migration, third-party surfaces) are specified separately and all depend
on this one.

**Goal:** replace the app's 106 hardcoded hex literals with a two-tier
token system, add an app-global Light/Dark/System preference that
actually repaints the shell, and leave the per-workspace accent colour
working exactly as it does today.

This picks up the thread the workspace-settings spec deferred: its §1
listed "theming beyond the accent colour" as out of scope entirely.

---

## 1. Scope

**In:** the token vocabulary (both tiers, both themes); `theme.css`;
theme resolution and persistence including the Tauri system-appearance
listener; the `AppConfig.theme` field, its managed state and the
`persist_workspaces` threading; the Light/Dark/System control in the
Settings hub; migration of the five app-shell components that prove the
tokens work.

**Out (sub-project 2):** the `IconButton` primitive and the ~6 divergent
icon-button styles it replaces.

**Out (sub-project 3):** the remaining 47 components and their ~600
hex literals.

**Out (sub-project 4):** the xterm terminal theme and the CodeMirror
`oneDark` swap. Both stay dark under a light theme after this
sub-project — see §7.

**Out entirely:** spacing, radius, font-size and icon-size scales;
per-workspace theme; user-authored themes; high-contrast mode.

## 2. Decisions

Continuing the log from `2026-08-20-workspace-settings-design.md`
(D1–D43).

- **D44 — Decomposed into four, tokens first.** Sub-projects 2, 3 and 4
  all consume tier-2 token names, so the vocabulary has to exist and be
  validated before any of them start. Building `IconButton` first
  against today's literals would mean touching it twice.
- **D45 — Two tiers, not one flat list.** A theme-independent primitive
  ramp, plus a semantic alias layer that is re-pointed per theme.
  A flat per-theme list of literals means every light value is
  hand-picked with nothing tying it to its dark counterpart, and the two
  lists drift. The indirection is the thing that keeps them honest.
- **D46 — The light end of the ramp is authored, not inverted.** The app
  has no value between `#eee` and `#fff`, which is the band light
  surfaces live in, so `--grey-13` and `--grey-14` are new (§4.1). A
  light theme produced by inverting a dark ramp reads muddy: light
  surfaces need lower-contrast borders than their dark counterparts,
  which is not where a mirror of the dark values lands.
- **D47 — Theme is app-global with a System option, not per-workspace.**
  The per-workspace accent (D35, D43) is a *label* — it distinguishes
  workspaces from each other, and the sidebar shows several at once.
  Light/dark is a *rendering mode* for the whole window; the sidebar has
  no coherent answer if two visible workspaces disagree. System is
  included because `tauri.conf.json` pins no `theme`, so
  `getCurrentWindow().theme()` reports the real macOS appearance and
  `onThemeChanged()` fires on the auto light/dark schedule.
- **D48 — Theme becomes a fourth managed state threaded through
  `persist_workspaces`.** `config.rs` documents the carry-through trap
  twice — a field not carried through "will silently reset to empty on
  the next save." The fix already exists in the codebase:
  `persist_workspaces` is a deliberate funnel, and its doc comment says
  centralizing it "is what makes the rule structural rather than just
  documented: every save site funnels through here instead of each
  independently reconstructing the `AppConfig` literal."

  So theme follows `SessionNames`/`FileTabs`/`BoardTabs` exactly: a
  `ThemePref(Mutex<Option<String>>)` managed state, a new parameter on
  `persist_workspaces`, and `get_theme_pref`/`set_theme_pref` commands
  shaped like `get_session_names`/`set_session_name`.

  *Revised during planning.* The original decision gave theme its own
  read-modify-write command to avoid the trap. That would have added a
  second save path bypassing the funnel — precisely what the funnel
  exists to prevent. Joining the funnel is both safer and the
  established pattern; the cost is updating its six call sites.
- **D49 — Pre-boot stamp from `prefers-color-scheme`.** `ssr = false`
  and the stored preference arrives asynchronously from Tauri, so there
  is a window before `data-theme` is set. An inline script in `app.html`
  guesses from the CSS media query. A user on System sees no flash at
  all; a user who overrode their preference sees at most one frame of
  the other theme.
- **D50 — `#3a3a3a` splits in two.** It is today's single most ambiguous
  value: 38 occurrences, serving as both a raised background and a
  hairline border. It becomes `--surface-overlay` in the former case and
  `--border` in the latter, and those diverge in light mode.
- **D51 — The beachhead is the app shell.** Five components, chosen
  because the user always sees them and because between them they
  exercise every token group. Shipping tokens with zero consumers means
  the vocabulary is designed against nothing.
- **D52 — Light elevation runs darker-forward.** Added after the visual
  pass. The dark theme lightens a surface as it comes forward
  (`#1e1e1e` base → `#3a3a3a` overlay); mirroring that in light put
  `--surface-overlay` at `#fff` over a `#fbfbfb` bar, and the title
  bar's buttons disappeared. Light therefore inverts the direction:
  `#fff > #fbfbfb > #f4f4f4 > #eee > #ddd`, monotonic, every layer
  separable. This is the concrete form of D46's "not inverted" — the
  *ordering* flips too, not only the values.

## 3. File layout

Four new files in the `app/src/lib/ui/` gavin context, plus one new
route file:

```
app/src/lib/ui/
├── theme.css              tier 1 + tier 2, both themes
├── theme.ts               pure: resolveTheme, parseThemePref
├── theme.test.ts          vitest, colocated per repo convention
└── themeState.svelte.ts   $state store: pref, effective, apply, subscribe
app/src/routes/
└── +layout.svelte         NEW — imports theme.css once
```

`theme.css` is a plain `.css` file rather than a Svelte `<style>` block.
Svelte scopes component styles, which would compile the `:root` rules
away; Vite injects a plain stylesheet globally on import. Today the repo
has no `.css` file at all and no `+layout.svelte` — only `+layout.ts`,
which sets `ssr = false`. The new layout does nothing but import the
stylesheet and render its children.

## 4. Token vocabulary

### 4.1 Tier 1 — ramps

Theme-independent. Defined once on bare `:root`, never redefined.

The neutral ramp consolidates the 19 greys in use today to 16 steps.
Steps 0–12 and step 15 are values already in the codebase, after merging
five near-duplicate pairs (`#2a2a2a`→`#232323`, `#333`→`#3a3a3a`,
`#777`→`#666`, `#aaa`→`#999`, `#ccc`→`#bbb`). Steps 13 and 14 are new,
authored for the light theme per D46 — the app has nothing between
`#eee` and `#fff` today, and that is exactly the band a light theme
needs for its base and raised surfaces.

```
--grey-0  #1a1a1a     --grey-8   #888
--grey-1  #1e1e1e     --grey-9   #999
--grey-2  #232323     --grey-10  #bbb
--grey-3  #2f2f2f     --grey-11  #ddd
--grey-4  #3a3a3a     --grey-12  #eee
--grey-5  #444        --grey-13  #f4f4f4   NEW
--grey-6  #555        --grey-14  #fbfbfb   NEW
--grey-7  #666        --grey-15  #fff
```

Four semantic families, each a five-step ramp seeded from the values
already in use:

| Family | Seed (in use today) | Purpose |
|---|---|---|
| `--blue-*`  | `#4a9eff`, `#7ea8d8`, `#4a6a8a`, `#2a3a4a` | accent, links, run actions |
| `--green-*` | `#8bc98b`, `#3f6b3f`, `#cfe8cf` | success, added lines, ahead counts |
| `--red-*`   | `#e0524a`, `#e08a8a`, `#7a3030` | danger, deletions, errors |
| `--amber-*` | `#d9a648`, `#d9b45c`, `#a15c2f` | warning, dirty state, conflicts |

### 4.2 Tier 2 — semantic roles

22 tokens. Defined twice: on bare `:root`, which carries the **dark**
values, and under `:root[data-theme="light"]`, which overrides them.
`:root[data-theme="dark"]` is written out explicitly as well, so the
attribute wins in both directions rather than relying on the absence of
a selector.

Dark is the bare-`:root` default so that every unstyled path agrees with
`resolveTheme`'s dark fallback (§5.1): a failed pre-boot stamp, an
unreadable config and an unavailable system appearance all land on the
app's current look rather than on a theme the user never chose.

| Group | Tokens |
|---|---|
| Surface | `--surface-base`, `--surface-raised`, `--surface-overlay`, `--surface-sunken`, `--surface-hover`, `--surface-selected` |
| Border | `--border`, `--border-strong`, `--border-focus` |
| Text | `--text`, `--text-muted`, `--text-subtle`, `--text-inverted` |
| Accent | `--accent`, `--accent-hover`, `--accent-text` |
| Status | `--success`, `--success-text`, `--warning`, `--warning-text`, `--danger`, `--danger-text` |

Dark mode points surfaces at the low end of the neutral ramp and text at
the high end; light mode reverses that, and additionally steps borders
inward (a light-theme hairline is `--grey-11`, not the mirror of
`--grey-4`) because equal-contrast borders read heavier on light
surfaces.

### 4.3 What stays as it is

`--ws-accent` is not part of this system. It is a per-workspace value
chosen by the user from `PALETTE` in `settings.ts`, flows in via
`style:--row-accent` on `Sidebar` and is consumed by `Pane` and
`+page.svelte`. It keeps its current name, its current plumbing, and its
`#4a9eff` fallback.

**Known issue, not fixed here.** `settings.ts:17` documents that the
eight accent swatches were "chosen to stay legible against the
`#1e1e1e`/`#2a2a2a` chrome." That premise does not hold on a light
surface, and some swatches will read poorly there. Re-picking the
palette needs its own visual pass against both themes; it is filed as a
card in the `ui` context rather than folded in here, because it changes
a value users have already chosen and persisted.

## 5. Resolution and persistence

### 5.1 The pure part

```ts
export type ThemePref = "light" | "dark" | "system";
export type EffectiveTheme = "light" | "dark";

export function resolveTheme(
  pref: ThemePref,
  system: EffectiveTheme | null
): EffectiveTheme;

export function parseThemePref(value: string | null | undefined): ThemePref;
```

`resolveTheme` returns `pref` when it is explicit, `system` when the pref
is `"system"`, and `"dark"` when the pref is `"system"` and `system` is
`null`. Dark is the fallback because it is the app's look today, so a
platform that cannot report an appearance keeps the current behaviour
rather than flipping to a theme the user never chose.

`parseThemePref` guards a hand-edited `config.json`, mirroring how
`normalizeColor` in `settings.ts` guards the accent: anything not one of
the three literals becomes `"system"`.

### 5.2 The flow

1. `app.html` inline script reads `prefers-color-scheme` and stamps
   `data-theme` on `<html>` (D49).
2. `bootstrap()` in `layoutState.ts` reads the stored preference.
3. `resolveTheme(pref, await getCurrentWindow().theme())`.
4. `document.documentElement.dataset.theme = effective`.
5. `onThemeChanged()` re-runs steps 3–4 while the pref is `"system"`,
   and is ignored otherwise.
6. The Settings control writes the pref, which re-runs steps 3–4 and
   calls `set_theme_pref`.

Both `theme()` and `onThemeChanged()` are confirmed present in the
installed `@tauri-apps/api/window`.

### 5.3 Storage

`AppConfig` in `config.rs` gains:

```rust
/// App-global light/dark preference. `None` means System — the same
/// "absent means default" convention as `Workspace::color`. Like
/// session_names/file_tabs/board_tabs, carried through
/// persist_workspaces or it silently resets on the next save.
#[serde(default)]
pub theme: Option<String>,
```

Per D48 this joins the existing funnel rather than getting its own save
path:

- `session.rs` gains `pub struct ThemePref(pub Mutex<Option<String>>)`,
  `manage`d in `lib.rs` alongside the others.
- `persist_workspaces` gains a `theme: Option<String>` parameter; all
  **six** call sites (`session.rs:234, 270, 298, 328, 1091` and the new
  setter) pass it.
- `get_theme_pref` / `set_theme_pref` commands mirror
  `get_session_names` / `set_session_name`, registered in `lib.rs`.

`AppConfig` derives `Default`, but the `config.rs` test module builds it
with exhaustive struct literals (e.g. `save_then_load_roundtrips`);
those literals need the new field.

### 5.4 Failure modes

| Failure | Behaviour |
|---|---|
| `theme()` returns `null` | Treated as System-unavailable; falls back to dark (§5.1) |
| Stored value is garbage | `parseThemePref` yields `"system"` |
| `set_theme_pref` fails | The in-memory theme still applies; the change is simply not persisted, consistent with how other settings writes behave |
| `config.json` predates this field | `#[serde(default)]` yields `None` → System |

## 6. Beachhead migration

Five components, plus the Settings control:

| File | Exercises |
|---|---|
| `routes/+page.svelte` | `--surface-base`, tab chrome, `--ws-accent` interop |
| `TitleBar.svelte` | `--surface-overlay`, one of the divergent icon-button styles |
| `Sidebar.svelte` | `--surface-raised`, `--surface-selected`, `--row-accent` plumbing |
| `Pane.svelte` | `--border`, `--surface-hover`, drop markers on `--ws-accent` |
| `WindowControls.svelte` | `--text-muted`, `--danger` |
| `SettingsHubView.svelte` | The Light/Dark/System control itself |

Between them these touch every tier-2 group, which is the point of
choosing them (D51).

## 7. Known limitation after this sub-project

Flipping to Light repaints the shell while 47 components keep their
literals, and both large content surfaces stay dark: the terminal
(`terminalRegistry.ts:124` constructs `new Terminal({ convertEol: false })`
with no theme object at all, so xterm's own default — white on black —
applies) and the editor (`codeMirror.ts:114` hard-wires
`themeOneDark.oneDark`).

This is expected, and is why the effort is decomposed. Sub-project 3
resolves the components; sub-project 4 resolves the two third-party
surfaces. Light mode should be described as incomplete until both land.

## 8. Testing

**`theme.test.ts`** — `resolveTheme` across all three prefs × three
system values (`"light"`, `"dark"`, `null`); `parseThemePref` for each
valid literal, for `null`/`undefined`, and for a garbage string.

**`config.rs`** — extend `save_then_load_roundtrips` to assert the theme
field survives a round trip; add a test asserting `set_workspaces_state`
does not clobber a stored theme, which is the regression D48 exists to
prevent.

**Not automated.** The CSS itself, and whether the light palette actually
reads well. That is a manual visual pass over the five beachhead
components in both themes, plus a check that the eight accent swatches
still resolve against a light surface (expected to surface problems —
see §4.3).

## 9. Open items for sub-projects 2–4

- Re-pick `PALETTE` for two-theme legibility (§4.3).
- Whether `IconButton` needs component-level tokens or can sit directly
  on tier 2 — deferred until sub-project 2 has real variants to fit.
- Whether the migration in sub-project 3 goes file-by-file or
  token-group-by-token-group across all files.
- xterm accepts a full `ITheme` object with 16 ANSI colours; deciding
  whether those derive from the tier-1 families or are authored
  separately is sub-project 4's call.
