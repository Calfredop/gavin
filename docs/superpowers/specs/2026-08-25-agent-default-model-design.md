# Agent Default Model — Design

**Status:** approved 2026-08-25.

**Goal:** a default model for the coding agent, settable globally and per
workspace, with popular picks offered where they exist and free text
everywhere else. Enabling the global settings surface is part of the job:
it does not exist yet.

---

## 1. Scope

**In:** a `model` setting in workspace Settings ▸ Agent; a Global Settings
modal behind the sidebar footer's disabled row, holding Theme and a default
model per agent profile; per-profile model flags and preset lists in the
Rust profile table; composing the model onto the launch command; the storage
split; the compat gate.

**Out:** per-session model overrides; a model picker in the init wizard;
anything else in the global panel; discovering a CLI's model catalogue at
runtime.

## 2. Decisions

Continuing the log from `2026-08-20-workspace-settings-design.md` (D35–D57).

- **D58 — Global settings exist, and they are a modal.** The workspace
  settings spec put them out of scope (§1), and the sidebar footer has
  carried a disabled "Settings · Coming soon" row ever since. They cannot
  be a hub tab: every hub tab takes a `workspaceId` and renders inside one
  workspace, which is the wrong shape for a preference that spans all of
  them. A modal from the footer row is the smallest surface that is
  honestly app-global. It takes over Theme from the footer, so one setting
  is not offered in two places.
- **D59 — A default model is per profile, not one string.** `opus` is
  noise to Codex. A single global field would silently produce a bad flag
  the moment a workspace switched profiles, so the global default is a map
  keyed by profile id, and a workspace inherits the entry for the profile
  it actually runs.
- **D60 — Per workspace the model is a project fact; globally it is a
  machine preference.** Straight application of D35 and D41: the launch
  command already lives in `.gavin-root/config.toml` because it describes
  the project's agent, and the model is a flag on that command. The global
  default has no project to live in and no repo to be committed to, so it
  goes in `config.json` beside `theme`.
- **D61 — The model is appended to a separate `launchCommand`; `command`
  is never rewritten.** `command` is what the Settings box edits and writes
  back to config.toml, so folding a flag into it would persist the flag and
  then append it again next time. Launchers read `launchCommand`; the
  settings panel reads `command`.
- **D62 — Presets ship only where a CLI names stable aliases.** Verified
  from each CLI's own `--help` on 2026-08-25: `claude --model` documents
  `fable`, `opus`, `sonnet` — pointers to the latest model of each tier,
  which never go stale. Nothing else offers that: `opencode models` is a
  per-user catalogue built from whichever providers that user configured,
  and Gemini's and Codex's names are dated ids that rot. Those profiles get
  a flag and an empty preset list, i.e. free text only. This is the posture
  `prompt_arg` and `headless_args` already take in the same table — empty
  where the convention is unverified, because a wrong value lands in
  somebody's argv.
- **D63 — Clearing a workspace model removes the key.**
  `set_root_config_field` rejects empty values today, which is right for
  every existing key: they all have a profile default underneath, so an
  empty `command` means nothing. `model` is the first key with a real
  fallback below it (the global default), so clearing it has a meaning and
  needs a path. Only `model` gets it.

## 3. Storage

### 3.1 Per workspace — `.gavin-root/config.toml`

```toml
[agent]
profile = "claude-code"
command = "claude"
model   = "opus"          # new; absent = inherit the global default
```

Reads ride the existing watcher, exactly as the rest of `[agent]` does
(workspace-settings spec §3.2): `parse_context_config` gains
`model: get("model")`, `protocol::AgentConfig` gains
`model: Option<String>` behind `#[serde(default)]` so an older daemon's
tree still parses. No new request for reads.

Writes go through the existing `SetRootConfigField`, with `"model"` added
to the daemon's allow-list and the D63 empty-value path:

```rust
if key == "model" && value.trim().is_empty() {
    doc["agent"].as_table_mut().map(|t| t.remove("model"));
    // ...write and return
}
```

### 3.2 Globally — `config.json`

```jsonc
{
  "theme": "dark",
  "agentModels": { "claude-code": "opus", "gemini": "gemini-flash-latest" }
}
```

`AppConfig` gains `agent_models: HashMap<String, String>` (serde-default,
so an existing config loads). It is the fifth field that must be *carried
through* `persist_workspaces` rather than reconstructed — the exact hazard
D48 names, which already bit `session_names` and `file_tabs`. It is
therefore threaded as a sixth parameter, placed **after** `theme` so it is
never adjacent to another `HashMap<String, String>` in the argument list,
backed by a `AgentModels(Mutex<..>)` managed state like `ThemePref`, and
pinned by its own regression test alongside
`persist_workspaces_carries_theme_through`.

Commands: `get_agent_model_defaults() -> HashMap<String, String>` and
`set_agent_model_default(profile_id, model)` where an empty model removes
the entry.

## 4. The profile table

`AgentProfile` gains two fields, surfaced through `AgentProfileDto` as
`modelFlag` and `models`:

| profile | `model_flag` | `models` | why |
|---|---|---|---|
| `claude-code` | `--model` | `fable`, `opus`, `sonnet` | aliases named by its own `--help` |
| `codex` | `--model` | — | dated ids only |
| `gemini` | `--model` | — | dated ids only; `-m/--model` verified from `--help` |
| `cursor` | — | — | the command is the IDE launcher; its positionals are paths |
| `opencode` | `--model` | — | `provider/model`, and the catalogue is per-user (`opencode models`) |
| `custom` | — | — | the user owns the whole command |

An empty `model_flag` means the profile offers no model control at all: the
row is replaced by a hint saying to put the flag in Command. That keeps the
"never put an unverified string in somebody's argv" rule from
`headless_args` intact rather than inventing a second policy.

## 5. Resolution and composition

`resolveAgentConfig(config, profiles, globalModels)` takes the global map
as a third, required argument — required so the compiler names every call
site rather than letting one silently stop inheriting. It returns two new
fields:

- `model` — workspace `[agent] model`, else the global default for the
  **resolved** profile id, else `""`.
- `launchCommand` — `command`, plus `<modelFlag> <model>` when a model
  resolves, the profile has a flag, and the command does not already carry
  one.

The last clause is what stops `claude --model opus --model sonnet` when
someone has already written the flag into Command by hand — the command the
user typed wins, because it is the more specific statement of intent.

Composition lives in a new pure `app/src/lib/agentModel.ts`:

- `commandSpecifiesModel(command, flag)` — token scan for `--model`/`-m`
  and their `=` forms, not a substring match (`--modelling` is not a flag).
- `composeLaunchCommand(command, flag, model)`
- `modelOptions(profile, globalDefault)` — the option list a picker
  renders: the inherit row (labelled with what it inherits), each preset,
  and Custom.

Every launcher moves from `.command` to `.launchCommand`: the main agent,
card runs, orchestration steps, the hidden commit agent, and the worktree
switcher's relaunch. The Settings Command box keeps reading `.command`.

## 6. UI

**`GlobalSettingsModal.svelte`**, opened from the sidebar footer's row,
which stops being disabled. Two sections:

- **Appearance** — Theme, moved out of the footer (D58).
- **Agent defaults** — one row per profile with a `model_flag`: a select
  of `(unset)` + presets + `Custom…`, with `Custom…` revealing a text
  input. A hint under the section says the values apply to any workspace
  that sets no model of its own.

**Workspace Settings ▸ Agent** gains a **Model** row directly under
Command, using the same picker, whose inherit row reads `Default (opus)` —
naming the value it inherits, so the panel never shows an empty box that
is secretly doing something. Profiles with no flag get the hint instead.

## 7. Compatibility

The daemon must allow-list `model` before a workspace write can land, so
`PROTOCOL_VERSION` goes 13 → 14. No `Request` variant is added, so
`min_version_for` and its band-count test are untouched; the assertion
pinning `PROTOCOL_VERSION == 13` moves to 14.

`FEATURE_MIN_VERSION.agentModel = 14` in `daemonCompat.ts`, consumed by
`featureBlockedReason` on the workspace Model row — the only surface that
can produce a `model` payload, which is what the CLAUDE.md rule demands
(an entry with no consumer is a dead gate). Against an older daemon the row
is disabled with the reason; the global panel is unaffected, because it
writes `config.json` through Tauri and never touches the daemon.

## 8. Testing

Rust:

- `set_root_config_field` accepts `model` and removes it on empty (D63).
- `parse_context_config` reads `model` off `[agent]`.
- `persist_workspaces` carries `agent_models` through (the D48 pin).
- `AgentProfileDto` carries `modelFlag`/`models` in the camelCase shape.

TypeScript:

- `agentModel.test.ts` — flag detection including `-m`, `--model=x` and
  the `--modelling` false positive; composition; the already-specified
  case; option lists for a profile with and without presets.
- `settings.test.ts` — `model` and `launchCommand` through the whole
  resolution order, including a global default that applies only to the
  resolved profile.

Rendered UI is not reachable from either suite, so two items go into
`smokeChecklist.ts`: the global panel opens from the footer and its theme
control still drives the theme, and a workspace model set to Custom shows
up in the next agent launch's command line.
