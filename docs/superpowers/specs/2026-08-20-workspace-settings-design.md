# Workspace Settings — Design (sub-project A)

**Status:** approved 2026-08-20. Sub-project A of two; sub-project B
(multi-agent MCP writers) is specified separately and depends on this one.

**Goal:** a per-workspace Settings tab covering name, colour, root folder,
notifications, and the coding agent — profile, launch command, and the
instructions-file name that is hardcoded as `CLAUDE.md` today.

---

## 1. Scope

**In:** the Settings hub tab; the storage split between `config.json` and
`.gavin-root/config.toml`; name, colour, root binding, two notification
toggles, agent profile, launch command, agent-file name; de-hardcoding
`CLAUDE.md` across the frontend; the agent-file rename flow.

**Out (sub-project B):** MCP writers for Codex, Gemini, Cursor and
opencode; the inline-guidance question for agents without a native skill
mechanism; user-specified MCP config paths for the `custom` profile. In
this sub-project every non-Claude profile carries `mcp_supported: false`
and the integration row says so plainly.

**Out entirely:** global (cross-workspace) settings; theming beyond the
accent colour; per-session overrides of any of these.

## 2. Decisions

Continuing the log in
`docs/superpowers/brainstorms/2026-08-06-agent-orchestration-brainstorm.md`
(D1–D34).

- **D35 — Split by nature.** Project facts live in `.gavin-root/config.toml`
  (committed, agent-readable): agent profile, instructions-file name,
  launch command. Machine-local preferences live in `config.json`:
  workspace name, colour, root path, notification toggles. `rootPath`
  cannot live in `config.toml` — it is the path *to* the directory that
  contains it.
- **D36 — Agent = profile plus overridable filename.** A profile sets
  instructions file, launch command and (later) MCP layout coherently, but
  the filename is separately overridable, so `AGENTS.md` with `claude-code`
  is expressible. A `custom` profile takes a filename and command only.
- **D37 — Settings is a hub tab**, `requiresRoot: false`, placed last in
  `HUB_VIEWS`. It must work unrooted because binding the root is one of
  its jobs.
- **D38 — Notifications are two per-workspace toggles** (needs-input,
  finished), both defaulting to on so existing workspaces are unchanged.
  Focus suppression stays a fixed rule, not a setting.
- **D39 — Six profiles ship**, conventions verified against current
  upstream documentation (§4). Only `claude-code` supports MCP setup in
  this sub-project.
- **D40 — Decomposed into A then B.** A delivers every setting the user
  asked for and is shippable alone.
- **D41 — The launch command is a project fact**, moving from
  `config.json` to `config.toml` with a one-time carry-over.
- **D42 — Changing the agent-file name never touches a file silently.**
  It prompts; choosing Move performs a real rename; an existing target is
  never overwritten (upholds D10, create-only).
- **D43 — Workspace colour reaches the focused-tab indicator, the drag
  drop-indicators, and a sidebar stripe.** Semantic greens are untouched.
- **D56 — Settings owns every folder-picking and integration action; the
  hub folder bar is read-only and sits above the tabs.** Added 2026-08-21.
  D37 made Settings work unrooted *because* binding the root is one of its
  jobs — this finishes that thought: the ⚙ picker, the "Set root…" /
  "Re-pick…" buttons and the "Agent integration" setup row all render only
  in the `settings` variant of `WorkspaceRootControl`. The `banner` variant
  keeps one job, *stating* which folder the workspace is bound to, so it
  belongs above the tab navigator (workspace-wide context, not a property
  of the open page) rather than under it. An unbound or missing root is
  still not a dead end: the banner offers "Open settings", which switches
  the hub view instead of opening a folder dialog.

## 3. Storage and ownership

### 3.1 The two files

```toml
# .gavin-root/config.toml — committed, agent-readable
version = 1
name = "my-repo"            # existing context-name key, untouched
[agent]
profile = "claude-code"
file    = "CLAUDE.md"       # absent = the profile's default
command = "claude --model opus"
```

```jsonc
// config.json — machine-local, per workspace
{
  "id": "...", "name": "my-repo", "pages": [], "activePageId": null,
  "activeView": null, "rootPath": "/Users/me/code/my-repo",
  "mainSessionId": null,
  "color": "#4a9eff",           // new; absent = default accent
  "notifyNeedsInput": true,     // new; absent = true
  "notifyFinished": true        // new; absent = true
}
```

`agentCommand` is removed from `Workspace` after the carry-over in §3.4.

### 3.2 Reads ride the existing watcher

`scan_root` already opens each context's `config.toml` to parse `name`
(`parse_context_name`). It gains the `[agent]` block, surfaced on the root
context of the tree push. Consequences:

- No new request is needed for reads.
- An agent or a `git pull` editing `config.toml` updates the panel within
  ~3s, through machinery already proven by the plan-file watcher.
- `GavinContext` gains `agent: Option<AgentConfig>` (only ever populated
  for the root context; `.gavin` sub-contexts have no agent block).

```rust
pub struct AgentConfig {
    pub profile: Option<String>,
    pub file: Option<String>,
    pub command: Option<String>,
}
```

All three fields are optional: a `config.toml` predating this work parses
cleanly with every field `None`, and defaults apply.

### 3.3 Writes get one new request

`SetRootConfigField { root_path, key, value }` where `key` is one of
`profile` / `file` / `command`, mirroring `SetPlanFrontmatterField`'s
shape and its allow-list discipline. Rejects unknown keys, empty values,
and values containing a newline.

This is a protocol change: **`PROTOCOL_VERSION` 6 → 7**, and
`protocol/src/lib.rs`'s test pinning that constant moves with it. The
existing handshake (app bootstrap probe and `gavin-mcp` connect) already
surfaces a stale daemon with an actionable message, so no new failure UI
is needed.

**Dependency:** `toml_edit` becomes a direct dependency of the daemon.
It is already in the tree — `toml 0.8`, used today by
`parse_context_name`, is built on it — so this adds no new transitive
dependencies. Plain `toml`
round-trips through a data structure and discards comments, key order and
formatting — unacceptable for a file the user and their agents hand-edit.
Sub-project B needs format-preserving TOML for Codex's
`.codex/config.toml` regardless, so hand-rolling a line editor here would
be work thrown away twice.

### 3.4 Migration

`agentCommand` currently sits in `config.json` (D34). On the first read of
a rooted workspace after upgrade:

1. If `config.toml` has no `[agent].command` **and** `config.json` has a
   non-empty `agentCommand`, write the value through to `config.toml`.
2. Thereafter `config.json`'s `agentCommand` is ignored, and the field is
   dropped from the struct.

An unrooted workspace has nowhere to carry the value to; its
`agentCommand` is simply dropped, which costs nothing because
`startMainAgent` already refuses to run without a root.

### 3.5 Failure modes

| Condition | Behaviour |
| --- | --- |
| `config.toml` absent | Defaults apply (`claude-code`, `CLAUDE.md`, `claude`); panel fully usable. The scanner already treats absent as normal (`config_warning: false`) |
| `config.toml` unparseable | Existing `configWarning` surfaces; agent fields render read-only. Never overwrite a file we cannot parse |
| Daemon write fails | Existing `setError` path — the same banner every other write uses |
| Root missing on disk | Existing "Root not found" behaviour, unchanged |

## 4. Agent profiles

### 4.1 The table

Defined in Rust, fetched by the frontend through a command — the pattern
`viewable_extensions()` already establishes, so there is one source of
truth rather than a Rust copy and a TypeScript copy that drift.

```rust
pub struct AgentProfile {
    pub id: &'static str,
    pub label: &'static str,
    pub instructions_file: &'static str,
    pub command: &'static str,
    pub mcp_supported: bool,
}
```

| id | label | instructions file | command | MCP in A |
| --- | --- | --- | --- | --- |
| `claude-code` | Claude Code | `CLAUDE.md` | `claude` | yes |
| `codex` | Codex CLI | `AGENTS.md` | `codex` | no |
| `gemini` | Gemini CLI | `GEMINI.md` | `gemini` | no |
| `cursor` | Cursor | `AGENTS.md` | `cursor` | no |
| `opencode` | opencode | `AGENTS.md` | `opencode` | no |
| `custom` | Custom… | (user-supplied) | (user-supplied) | no |

Conventions verified 2026-08-20 against upstream documentation. The MCP
config layouts recorded for sub-project B, **not implemented here**:
Claude `.mcp.json` (`mcpServers.<key>`), Gemini `.gemini/settings.json`
(`mcpServers.<key>`), Cursor `.cursor/mcp.json` (`mcpServers.<key>`),
Codex `.codex/config.toml` (`[mcp_servers.<key>]`, TOML), opencode
`opencode.json` (`mcp.<key>` with `type: "local"` and `command` as an
array). Three share one JSON shape, differing only in path.

`ClaudeCodeProfile` in `agent_setup.rs` becomes the first row of this
table rather than a standalone const — widening D4's seam exactly as its
own comment anticipated. Its `mcp_config`, `server_key`, `skill_dir` and
`skill_file` fields move to a separate `McpLayout`, held only by profiles
where `mcp_supported` is true.

### 4.2 Resolution order

For any workspace: `config.toml`'s explicit value, else the profile's
default, else the `claude-code` default. Expressed once as a pure
function so the panel, the hub label, the home tile and the agent-file
view cannot disagree.

### 4.3 De-hardcoding `CLAUDE.md`

Four sites today:

| Site | Change |
| --- | --- |
| `AgentFileHubView.svelte` | Path from resolved config, not the literal. Its comment explaining the hardcoding is removed with it |
| `HomeHubView.svelte` | Both the probed path and the tile's label |
| `workspaceViews.ts` | The `label: "CLAUDE.md"` entry |
| `agent_setup.rs` | Reads the profile row, not the const |

`HubView.label` is a static string in a `const` array, but this label now
varies per workspace. Rather than widening the type to accept a function,
a pure `hubLabel(view, agentFileName)` resolver in `workspace.ts` is
called by the nav. `HUB_VIEWS` stays a plain data table, and the resolver
is unit-testable.

### 4.4 The MCP integration row

Copy becomes profile-driven. With `mcp_supported: true` it reads as today,
naming the profile's own files. With `mcp_supported: false` the button is
absent and the row states why — "MCP integration isn't available for
Codex CLI yet" — rather than offering an action that would write the
wrong file.

## 5. The Settings tab

`{ id: "settings", label: "Settings", icon: Settings,
component: SettingsHubView, requiresRoot: false }`, last in `HUB_VIEWS`.

```
Workspace
  Name    [ my-repo                    ]
  Colour  ● ● ● ● ● ● ● ●   [ custom ]   preview: ━━━━━━━━
  Root    [ ~/code/my-repo          … ]   ← WorkspaceRootControl, embedded

Notifications
  [✓] When a session needs my input
  [✓] When a session finishes working
      Never shown while gavin is focused.

Agent                          (needs a root folder)
  Profile  [ Claude Code            ▾ ]
  Command  [ claude --model opus      ]
  File     [ CLAUDE.md                ]
  ✓ MCP integration — set up / update
```

`WorkspaceRootControl.svelte` is **embedded, not reimplemented** — 215
lines, already tested, owning the picker and the init modal. The slim
banner stays on other hub tabs for discoverability; its button navigates
here.

Unrooted, the Agent group renders disabled with "Bind a root folder to
configure the agent" — honest, because those settings live in a file under
that root.

### 5.1 Save semantics

**Live-apply; no Save button.** Each field commits on change or blur,
matching the app throughout: drags write frontmatter immediately, the
editor autosaves after ~1s, sidebar rename commits on Enter. An explicit
Save would import the dirty-state and conflict handling that sub-project 4
demonstrated is the fiddly part. The single exception is the agent-file
rename (§6), which prompts because it can move a file.

### 5.2 External change while the panel is open

A watcher push must not clobber typing. **A focused input keeps its
value; unfocused fields update.** Same instinct as the editor's conflict
handling, without the banner, since these are single values rather than a
document.

## 6. The agent-file rename flow

One flow covers both routes: editing the File field, and switching profile
when the filename has not been overridden (`claude-code` → `codex` implies
`CLAUDE.md` → `AGENTS.md`).

| Situation | Behaviour |
| --- | --- |
| Old file exists, target does not | Prompt: **Leave it** / **Move file**. Move renames on disk, carrying content and the marker block |
| Target already exists | No move offered; point only, with the reason shown. Never overwrite (D10) |
| Old file does not exist | Point silently. No prompt for a file that is not there |
| Name empty or contains `/` | Inline error; nothing written; the setting is unchanged |

No extension is required — Cursor's legacy `.cursorrules` has none, so
demanding `.md` would be wrong.

The move runs app-side as `move_agent_file { root_path, from, to }`,
refusing when the target exists. This follows the existing split:
`agent_setup.rs` already writes `CLAUDE.md` from the app, while the daemon
owns everything under `.gavin*`.

The decision is a pure function, so the table above is directly testable:

```typescript
type RenameDecision = "prompt" | "point" | "error";
function renameDecision(
  oldName: string, newName: string,
  oldExists: boolean, targetExists: boolean
): RenameDecision;
```

## 7. Workspace colour

`color?: string` in `config.json`; absent means today's `#4a9eff`, so
existing workspaces are unchanged.

Plumbed as a CSS custom property, because the two surfaces differ: the
main area shows one workspace at a time, so `--ws-accent` is set once on
the pane container and `.tab.focused` plus the two drop-indicator shadows
read `var(--ws-accent, #4a9eff)`. The sidebar shows every workspace at
once, so each row carries its own inline `--ws-accent`.

Eight presets, legible against the `#1e1e1e`/`#2a2a2a` chrome:

| | | | | | | | |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `#4a9eff` | `#59c36a` | `#2dd4bf` | `#a78bfa` | `#f472b6` | `#f87171` | `#fb923c` | `#fbbf24` |
| blue (default) | green | teal | purple | pink | red | orange | yellow |

Custom colours use a native `<input type="color">` — no dependency.

**A live preview of the actual indicator** is shown rather than enforcing
a contrast floor: a nearly-black accent is the user's call, but they
should see it before committing.

**Validation happens before the value reaches a style attribute.** A pure
`normalizeColor(value)` accepts `#rrggbb` and returns the default
otherwise, so a hand-edited `config.json` cannot inject arbitrary text
into CSS.

## 8. Testing

This codebase has no Svelte component tests — vitest here cannot
preprocess `.svelte`, so a test that merely imports a component fails at
collection. Everything decidable therefore lives in pure modules.

**TypeScript** (`settings.ts`, `workspace.ts`):

- `normalizeColor` — accepts `#rrggbb`, rejects `#fff`, `red`,
  `"; background: url(x)"`, empty; falls back to the default.
- `validateAgentFileName` — rejects empty, whitespace-only, and any value
  containing `/`; accepts `AGENTS.md` and extensionless `.cursorrules`.
- `renameDecision` — the four rows of §6, one assertion each.
- `hubLabel` — returns the agent file's name for the agent-file view and
  the static label for every other.
- `resolveAgentConfig` — explicit value beats profile default beats
  `claude-code` default; unknown profile id falls back rather than throwing.

**Rust:**

- The profile table: every row's `instructions_file` and `command`
  non-empty; exactly one row with `mcp_supported: true` in this
  sub-project; ids unique.
- `config.toml` round-trip through `SetRootConfigField` for each allowed
  key; unknown key rejected; newline in value rejected.
- `toml_edit` preservation: a file with comments and unusual key order
  survives a write with both intact.
- The `agentCommand` carry-over: runs once, is a no-op when
  `[agent].command` already exists, and is skipped for unrooted
  workspaces.
- `scan_root` surfaces `[agent]` on the root context, `None` on `.gavin`
  sub-contexts, and an unparseable file still sets `config_warning`.
- Protocol shape tests for the new request and the bumped version.

**Manual:** a new "Workspace settings" checklist section in
`smokeChecklist.ts`, covering the panel's rendering, the colour reaching
both surfaces, the rename prompt's three outcomes, live-apply, the
disabled-unrooted state, and an external `config.toml` edit updating the
panel while a focused field keeps its text.

## 9. Open items for sub-project B

- Codex, Gemini, Cursor and opencode MCP writers; `toml_edit` is already
  a dependency by then.
- What replaces `.claude/skills/gavin/SKILL.md` for agents with no native
  skill mechanism — inline guidance in the instructions file, or a
  profile-neutral guide file the marker block points to.
- Custom MCP config path and shape for the `custom` profile.
