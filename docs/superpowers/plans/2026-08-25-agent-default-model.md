# Agent Default Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a default model for the coding agent, settable per workspace and app-wide, that reaches the agent as a flag on its launch command.

**Architecture:** the Rust profile table learns each CLI's model flag and any stable aliases it documents; the per-workspace value rides `[agent] model` in `.gavin-root/config.toml` (project fact) while the app-wide default per profile rides `agentModels` in `config.json` (machine preference); `resolveAgentConfig` composes the two into a new `launchCommand` that every launcher uses, leaving the raw `command` alone for the settings box to edit.

**Tech Stack:** Rust (protocol, daemon, Tauri host), Svelte 5 + TypeScript (app), vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-08-25-agent-default-model-design.md`

## Global Constraints

- **Never `git add -A`, never `git stash`.** The working tree is shared with other agent sessions; stage only files this plan names.
- **Do not commit.** Commits happen when the human asks (CLAUDE.md). Each task ends with green suites, not a commit.
- Checks: `cargo test --workspace`, and in `app/`: `npm test && npm run check && npm run build`.
- The daemon's `gavin::tests` are flaky under full-suite cargo parallelism. Re-run that module alone before calling a failure a regression.
- `PROTOCOL_VERSION` ends this plan at **14** (was 13). `MIN_COMPATIBLE_VERSION` stays 5.
- Preset model lists ship **only** for `claude-code` (`fable`, `opus`, `sonnet`) — spec D62. Never invent a model name for another CLI.
- No attribution to Claude/agents/LLMs in anything that lands in the repo.

---

### Task 1: Model flag and presets on the profile table

**Files:**
- Modify: `app/src-tauri/src/agent_setup.rs` (`AgentProfile`, `AGENT_PROFILES`, `AgentProfileDto`, `agent_profiles()`)
- Test: `app/src-tauri/src/agent_setup.rs` (its existing `#[cfg(test)] mod`)

**Interfaces:**
- Produces: `AgentProfile { model_flag: &'static str, models: &'static [&'static str] }`; `AgentProfileDto { model_flag: String, models: Vec<String> }`, serialized camelCase as `modelFlag` / `models`.

- [x] **Step 1: Write the failing test**

```rust
#[test]
fn only_claude_code_ships_model_presets_and_cursor_has_no_flag() {
    let by = |id: &str| AGENT_PROFILES.iter().find(|p| p.id == id).unwrap();
    // Aliases named by `claude --help`: pointers to the latest model of
    // each tier, so they cannot go stale (spec D62).
    assert_eq!(by("claude-code").models, &["fable", "opus", "sonnet"]);
    assert_eq!(by("claude-code").model_flag, "--model");
    // Verified from each CLI's own --help; no preset names, because
    // theirs are dated ids that rot.
    assert_eq!(by("gemini").model_flag, "--model");
    assert!(by("gemini").models.is_empty());
    assert_eq!(by("opencode").model_flag, "--model");
    assert!(by("opencode").models.is_empty());
    // `cursor` is the IDE launcher -- no model control at all.
    assert_eq!(by("cursor").model_flag, "");
    assert_eq!(by("custom").model_flag, "");
}

#[test]
fn profile_dto_carries_the_model_fields_in_camel_case() {
    let dto = agent_profiles().into_iter().find(|p| p.id == "claude-code").unwrap();
    let json = serde_json::to_value(&dto).unwrap();
    assert_eq!(json["modelFlag"], "--model");
    assert_eq!(json["models"], serde_json::json!(["fable", "opus", "sonnet"]));
}
```

- [x] **Step 2: Run it to verify it fails**

Run: `cargo test -p gavin-app --lib agent_setup 2>&1 | tail -20` (or `cd app/src-tauri && cargo test agent_setup`)
Expected: FAIL — no field `model_flag` on `AgentProfile`.

- [x] **Step 3: Add the fields to the struct**

In `AgentProfile`, after `headless_args`:

```rust
    /// The flag that selects a model, e.g. `--model`. Empty where the
    /// command takes none -- `cursor` is the IDE launcher, and `custom`
    /// is the user's own argv. An empty flag hides every model control
    /// for the profile rather than guessing one, the same posture
    /// `headless_args` takes above.
    pub model_flag: &'static str,
    /// Model names offered as picks. Only ever names the CLI itself
    /// documents as STABLE aliases: `claude --help` names `fable`,
    /// `opus` and `sonnet`, which point at the latest model of each tier
    /// and so never go stale. Everyone else's names are dated ids
    /// (`opencode models` is a per-user catalogue, built from whichever
    /// providers that user configured), so they ship empty and the user
    /// types what they want.
    pub models: &'static [&'static str],
```

- [x] **Step 4: Fill in every row**

`claude-code`: `model_flag: "--model", models: &["fable", "opus", "sonnet"],`
`codex`, `gemini`, `opencode`: `model_flag: "--model", models: &[],`
`cursor`, `custom`: `model_flag: "", models: &[],`

- [x] **Step 5: Widen the DTO**

In `AgentProfileDto` add `pub model_flag: String,` and `pub models: Vec<String>,` (the struct already derives `rename_all = "camelCase"`), and populate both in `agent_profiles()`:

```rust
            model_flag: p.model_flag.to_string(),
            models: p.models.iter().map(|m| m.to_string()).collect(),
```

- [x] **Step 6: Run the tests**

Run: `cd app/src-tauri && cargo test agent_setup`
Expected: PASS.

---

### Task 2: `model` on the wire and in config.toml

**Files:**
- Modify: `crates/protocol/src/lib.rs` (`AgentConfig`, `PROTOCOL_VERSION`, the version assertion)
- Modify: `crates/daemon/src/gavin.rs` (`parse_context_config`, `set_root_config_field`)
- Modify: `app/src/lib/gavin.ts` (`AgentConfig`)
- Test: `crates/daemon/src/gavin.rs` (existing `#[cfg(test)] mod`)

**Interfaces:**
- Consumes: nothing.
- Produces: `AgentConfig.model: Option<String>` (`model` on the frontend type); `set_root_config_field(root, "model", value)` where an empty value removes the key.

- [x] **Step 1: Write the failing test**

Beside `set_root_config_field_writes_each_allowed_key_and_rejects_the_rest`:

```rust
#[test]
fn model_is_settable_and_an_empty_value_clears_it() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(GAVIN_ROOT_DIR)).unwrap();
    set_root_config_field(dir.path(), "model", "opus").unwrap();
    let path = dir.path().join(GAVIN_ROOT_DIR).join("config.toml");
    assert!(std::fs::read_to_string(&path).unwrap().contains("model = \"opus\""));

    // Clearing is what "inherit the global default again" means, and it
    // is the only key with a fallback underneath it (spec D63).
    set_root_config_field(dir.path(), "model", "").unwrap();
    let after = std::fs::read_to_string(&path).unwrap();
    assert!(!after.contains("model"));
    // The rest of [agent] survives the removal.
    set_root_config_field(dir.path(), "command", "claude").unwrap();
    set_root_config_field(dir.path(), "model", "").unwrap();
    assert!(std::fs::read_to_string(&path).unwrap().contains("command = \"claude\""));

    // Every other key still refuses an empty value.
    assert!(set_root_config_field(dir.path(), "command", "").is_err());
}

#[test]
fn parse_context_config_reads_the_model_off_the_agent_block() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.toml");
    std::fs::write(&path, "[agent]\nprofile = \"claude-code\"\nmodel = \"opus\"\n").unwrap();
    let (_, agent, warn) = parse_context_config(&path);
    assert!(!warn);
    assert_eq!(agent.unwrap().model, Some("opus".to_string()));
}
```

- [x] **Step 2: Run it to verify it fails**

Run: `cargo test -p gavin-daemon gavin::tests::model_is_settable`
Expected: FAIL — no field `model` on `AgentConfig`.

- [x] **Step 3: Add the protocol field**

In `crates/protocol/src/lib.rs`, in `AgentConfig` after `mcp_format`:

```rust
    /// The model this workspace's agent launches with, composed onto the
    /// command as `<model_flag> <model>`. Absent means "inherit the
    /// app-wide default for this profile" -- the first key in this block
    /// with a fallback underneath it, which is why it is also the only
    /// one `set_root_config_field` can clear. `default` keeps an older
    /// daemon's tree parseable, exactly as `mcp_file` does above.
    #[serde(default)]
    pub model: Option<String>,
```

- [x] **Step 4: Bump the protocol version**

`pub const PROTOCOL_VERSION: u32 = 14;` and update the assertion (`assert_eq!(PROTOCOL_VERSION, 13);` → `14`). Add a line to the constant's doc comment: `/// 14 adds `[agent] model` to SetRootConfigField's allow-list.` No `Request` variant is added, so `min_version_for` and `variant_counts_per_version_band_are_pinned_to_catch_a_missed_bump` are untouched — do not edit either.

- [x] **Step 5: Parse and write it in the daemon**

In `parse_context_config`'s `AgentConfig { .. }` literal add `model: get("model"),`.

In `set_root_config_field`, widen the allow-list and add the clear path **before** the empty-value guard:

```rust
    if !matches!(key, "profile" | "file" | "command" | "mcp_file" | "mcp_format" | "model") {
        anyhow::bail!("not a settable agent key: {key}");
    }
    // `model` alone can be cleared: every other key has a profile default
    // underneath it, so an empty one means nothing, while an empty model
    // means "fall back to the app-wide default" (spec D63).
    if key == "model" && value.trim().is_empty() {
        let path = root.join(GAVIN_ROOT_DIR).join("config.toml");
        let existing = std::fs::read_to_string(&path).unwrap_or_default();
        let mut doc = existing.parse::<toml_edit::DocumentMut>().map_err(|_| {
            anyhow::anyhow!("{} is not valid TOML -- fix or remove it first", path.display())
        })?;
        if let Some(t) = doc.get_mut("agent").and_then(|a| a.as_table_mut()) {
            t.remove("model");
        }
        std::fs::write(&path, doc.to_string())?;
        return Ok(());
    }
    if value.trim().is_empty() || value.contains('\n') {
```

- [x] **Step 6: Mirror the field on the frontend type**

In `app/src/lib/gavin.ts`'s `AgentConfig`, after `mcpFormat`:

```ts
  /// The workspace's chosen model. Optional because an older daemon does
  /// not send it; absent means the app-wide default applies.
  model?: string | null;
```

- [x] **Step 7: Run the tests**

Run: `cargo test -p gavin-protocol && cargo test -p gavin-daemon gavin::tests`
Expected: PASS (run the daemon module alone — it is flaky under full-suite parallelism).

---

### Task 3: The app-wide defaults map in config.json

**Files:**
- Modify: `app/src-tauri/src/config.rs` (`AppConfig`)
- Modify: `app/src-tauri/src/session.rs` (`persist_workspaces` + every call site, new `AgentModels` state, two commands)
- Modify: `app/src-tauri/src/lib.rs` (command registration)
- Modify: `app/src/lib/backend.ts`
- Test: `app/src-tauri/src/session.rs` (`workspaces_data_tests`)

**Interfaces:**
- Produces: Tauri commands `get_agent_model_defaults() -> HashMap<String, String>` and `set_agent_model_default(profile_id: String, model: String)`; `backend.getAgentModelDefaults()` / `backend.setAgentModelDefault(profileId, model)`.

- [x] **Step 1: Write the failing test**

Beside `persist_workspaces_carries_theme_through`:

```rust
    /// The same hazard D48 named for `theme`: `agent_models` is a fifth
    /// carry-through field, so a save that rebuilds AppConfig without it
    /// silently wipes every app-wide model default.
    #[test]
    fn persist_workspaces_carries_agent_models_through() {
        let dir = tempfile::tempdir().unwrap();
        let data = WorkspacesData { workspaces: vec![], active_workspace_id: None };
        let mut models = HashMap::new();
        models.insert("claude-code".to_string(), "opus".to_string());
        persist_workspaces(
            dir.path(),
            &data,
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            Some("light".to_string()),
            models.clone(),
        )
        .unwrap();
        let loaded = crate::config::load(dir.path()).unwrap();
        assert_eq!(loaded.agent_models, models);
        assert_eq!(loaded.theme, Some("light".to_string()));
    }
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd app/src-tauri && cargo test persist_workspaces_carries`
Expected: FAIL — `persist_workspaces` takes 6 arguments, 7 supplied.

- [x] **Step 3: Widen AppConfig**

In `config.rs`'s `AppConfig`, after `theme`:

```rust
    /// App-wide default model per agent profile id, e.g.
    /// `{"claude-code": "opus"}`. A workspace with no `[agent] model` of
    /// its own inherits the entry for the profile it runs. Keyed by
    /// profile because one string cannot serve two CLIs -- `opus` is
    /// noise to Codex. Like theme/session_names/file_tabs/board_tabs it
    /// must be carried through `persist_workspaces`, or it silently
    /// resets on the next save.
    #[serde(default)]
    pub agent_models: HashMap<String, String>,
```

- [x] **Step 4: Thread it through `persist_workspaces`**

Add `agent_models: HashMap<String, String>,` as the **last** parameter (after `theme` — never adjacent to `file_tabs`/`board_tabs`, so two same-typed positionals cannot be transposed), set it in the `AppConfig` literal, and add a `State<AgentModels>` read at each of the five call sites, mirroring the `theme_state` lines already there:

```rust
    let agent_models = agent_models_state.0.lock().unwrap().clone();
```

Declare the state beside `SessionNames`:

```rust
/// App-wide default model per profile id. Tauri-managed like `ThemePref`,
/// and persisted into the same `AppConfig` -- so every command that saves
/// must carry it along (see `SessionNames`).
pub struct AgentModels(pub Mutex<HashMap<String, String>>);
```

and manage it beside `ThemePref` in bootstrap: `app_handle.manage(AgentModels(Mutex::new(config.agent_models)));` — taking the field before `config.theme` is moved, or cloning as needed.

- [x] **Step 5: Add the two commands**

```rust
#[tauri::command]
pub fn get_agent_model_defaults(state: State<AgentModels>) -> HashMap<String, String> {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_agent_model_default(
    profile_id: String,
    model: String,
    // ...the same State params the other savers take
) -> Result<(), String> {
    let agent_models = {
        let mut current = agent_models_state.0.lock().unwrap();
        // An empty model removes the entry: the picker's "(unset)" row
        // must be able to undo a default, not just overwrite it.
        if model.trim().is_empty() {
            current.remove(&profile_id);
        } else {
            current.insert(profile_id, model.trim().to_string());
        }
        current.clone()
    };
    // ...read session_names / file_tabs / board_tabs / theme as the
    // neighbouring commands do, then:
    persist_workspaces(&config_dir, &data, session_names, file_tabs, board_tabs, theme, agent_models)
        .map_err(|e| e.to_string())
}
```

Register both in `lib.rs` beside `session::set_root_config_field`.

- [x] **Step 6: Add the backend bindings**

In `app/src/lib/backend.ts`, beside `setThemePref`:

```ts
/// App-wide default model per agent profile id. A workspace with no model
/// of its own inherits the entry for the profile it runs.
export function getAgentModelDefaults(): Promise<Record<string, string>> {
  return invoke("get_agent_model_defaults");
}

export function setAgentModelDefault(profileId: string, model: string): Promise<void> {
  return invoke("set_agent_model_default", { profileId, model });
}
```

- [x] **Step 7: Run the tests**

Run: `cd app/src-tauri && cargo test`
Expected: PASS.

---

### Task 4: `agentModel.ts` — the pure composition module

**Files:**
- Create: `app/src/lib/agentModel.ts`
- Create: `app/src/lib/agentModel.test.ts`

**Interfaces:**
- Consumes: `AgentProfileInfo` from `./settings` (widened in Task 5 with `modelFlag` and `models`).
- Produces: `commandSpecifiesModel(command, flag): boolean`, `composeLaunchCommand(command, flag, model): string`, `modelOptions(profile, globalDefault): ModelOption[]` where `ModelOption = { value: string; label: string }`, and `CUSTOM_MODEL = "__custom__"`.

- [x] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { commandSpecifiesModel, composeLaunchCommand, modelOptions, CUSTOM_MODEL } from "./agentModel";

describe("commandSpecifiesModel", () => {
  it("finds the flag as a whole token, in every spelling", () => {
    expect(commandSpecifiesModel("claude --model opus", "--model")).toBe(true);
    expect(commandSpecifiesModel("claude --model=opus", "--model")).toBe(true);
    expect(commandSpecifiesModel("gemini -m gemini-flash-latest", "--model")).toBe(true);
    expect(commandSpecifiesModel("opencode -m=x", "--model")).toBe(true);
  });

  it("is not fooled by a substring", () => {
    // The bug a naive includes() would ship: a command that merely
    // contains the letters would suppress the flag entirely.
    expect(commandSpecifiesModel("claude --modelling", "--model")).toBe(false);
    expect(commandSpecifiesModel("run --dry-model", "--model")).toBe(false);
    expect(commandSpecifiesModel("claude", "--model")).toBe(false);
  });
});

describe("composeLaunchCommand", () => {
  it("appends the flag and the model", () => {
    expect(composeLaunchCommand("claude", "--model", "opus")).toBe("claude --model opus");
  });

  it("leaves the command alone when there is nothing to add", () => {
    expect(composeLaunchCommand("claude", "--model", "")).toBe("claude");
    expect(composeLaunchCommand("cursor", "", "opus")).toBe("cursor");
  });

  it("defers to a model the command already names", () => {
    // What the user typed by hand is the more specific statement of
    // intent, and two --model flags is an argv error.
    expect(composeLaunchCommand("claude --model sonnet", "--model", "opus")).toBe(
      "claude --model sonnet"
    );
  });

  it("quotes nothing and trims the model", () => {
    expect(composeLaunchCommand("claude", "--model", "  opus  ")).toBe("claude --model opus");
  });
});

describe("modelOptions", () => {
  const claude = { id: "claude-code", modelFlag: "--model", models: ["fable", "opus", "sonnet"] };
  const gemini = { id: "gemini", modelFlag: "--model", models: [] };

  it("leads with an inherit row that names what it inherits", () => {
    expect(modelOptions(claude, "opus")[0]).toEqual({ value: "", label: "Default (opus)" });
    expect(modelOptions(claude, "")[0]).toEqual({ value: "", label: "(unset)" });
  });

  it("offers every preset, then Custom", () => {
    const opts = modelOptions(claude, "");
    expect(opts.map((o) => o.value)).toEqual(["", "fable", "opus", "sonnet", CUSTOM_MODEL]);
  });

  it("offers Custom alone for a profile with no presets", () => {
    expect(modelOptions(gemini, "").map((o) => o.value)).toEqual(["", CUSTOM_MODEL]);
  });
});
```

- [x] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run src/lib/agentModel.test.ts`
Expected: FAIL — cannot resolve `./agentModel`.

- [x] **Step 3: Write the module**

```ts
/// Composing a chosen model onto an agent's launch command. Pure and
/// separate from settings.ts because every launcher needs it and the
/// settings panel needs its option lists -- the .svelte files stay
/// templates over this.

/// The sentinel a picker uses for "type your own". Never a model name
/// itself, and never written to config: choosing it reveals a text box,
/// and what the user types is what gets stored.
export const CUSTOM_MODEL = "__custom__";

export interface ModelOption {
  value: string;
  label: string;
}

/// The short spelling of every model flag we ship. A profile's flag is
/// the long form; a hand-written command may use either.
function flagAliases(flag: string): string[] {
  return flag === "--model" ? ["--model", "-m"] : [flag];
}

/// Whether the command already names a model. Token-wise, not a
/// substring match: `--modelling` contains `--model` and means something
/// else entirely.
export function commandSpecifiesModel(command: string, flag: string): boolean {
  if (!flag) return false;
  const aliases = flagAliases(flag);
  return command
    .split(/\s+/)
    .some((token) => aliases.some((a) => token === a || token.startsWith(`${a}=`)));
}

/// `command` plus `<flag> <model>`, when there is a model to add, a flag
/// to add it with, and the command does not already carry one. Returns
/// `command` untouched otherwise -- callers hand this straight to a
/// shell, so silently doing nothing is the safe failure.
export function composeLaunchCommand(command: string, flag: string, model: string): string {
  const chosen = model.trim();
  if (!chosen || !flag || commandSpecifiesModel(command, flag)) return command;
  return `${command} ${flag} ${chosen}`;
}

/// The rows a model picker renders: inherit, then each preset, then
/// Custom. The inherit row is labelled with the value it inherits so the
/// panel never shows an empty box that is secretly doing something.
export function modelOptions(
  profile: { modelFlag: string; models: string[] },
  globalDefault: string
): ModelOption[] {
  if (!profile.modelFlag) return [];
  const inherited = globalDefault.trim();
  return [
    { value: "", label: inherited ? `Default (${inherited})` : "(unset)" },
    ...profile.models.map((m) => ({ value: m, label: m })),
    { value: CUSTOM_MODEL, label: "Custom…" },
  ];
}
```

- [x] **Step 4: Run to verify it passes**

Run: `cd app && npx vitest run src/lib/agentModel.test.ts`
Expected: PASS, 9 tests.

---

### Task 5: Resolution — `model` and `launchCommand`

**Files:**
- Modify: `app/src/lib/settings.ts` (`AgentProfileInfo`, `ResolvedAgent`, `resolveAgentConfig`)
- Modify: `app/src/lib/settings.test.ts`
- Modify: `app/src/lib/layoutState.ts` (`agentModelDefaultsStore`, `resolvedAgentFor`, `startMainAgent`, bootstrap load, `setAgentField` key union)
- Modify: `app/src/lib/cardRunActions.ts:85,146`, `app/src/lib/orchestrationState.ts:424,478`, `app/src/lib/layoutState.ts:759`, `app/src/lib/GitWorktreeSwitcher.svelte:38`, `app/src/lib/SetupWizard.svelte:28`, `app/src/lib/WorkspaceRootControl.svelte:27`, `app/src/lib/SettingsHubView.svelte:34`

**Interfaces:**
- Consumes: `composeLaunchCommand` from Task 4; `backend.getAgentModelDefaults` from Task 3.
- Produces: `ResolvedAgent.model: string`, `ResolvedAgent.launchCommand: string`; `resolveAgentConfig(config, profiles, globalModels)`; `agentModelDefaultsStore: Writable<Record<string, string>>`.

- [x] **Step 1: Write the failing tests**

Add to `settings.test.ts`'s `resolveAgentConfig` describe (and add `modelFlag`/`models` to its `PROFILES` fixture rows — `claude-code` gets `"--model"` and `["fable","opus","sonnet"]`, `codex` `"--model"` and `[]`, `custom` `""` and `[]`):

```ts
  it("prefers the workspace model over the global default", () => {
    const r = resolveAgentConfig({ profile: "claude-code", file: null, command: null, model: "sonnet" }, PROFILES, {
      "claude-code": "opus",
    });
    expect(r.model).toBe("sonnet");
    expect(r.launchCommand).toBe("claude --model sonnet");
  });

  it("inherits the global default for the RESOLVED profile only", () => {
    const globals = { "claude-code": "opus", codex: "some-codex-model" };
    expect(resolveAgentConfig({ profile: "codex", file: null, command: null }, PROFILES, globals).model).toBe(
      "some-codex-model"
    );
    // An unknown profile resolves to claude-code, so it inherits
    // claude-code's default -- not the one it asked for.
    expect(resolveAgentConfig({ profile: "nope", file: null, command: null }, PROFILES, globals).model).toBe("opus");
  });

  it("leaves launchCommand equal to command when no model resolves", () => {
    const r = resolveAgentConfig({ profile: "claude-code", file: null, command: null }, PROFILES, {});
    expect(r.model).toBe("");
    expect(r.launchCommand).toBe(r.command);
  });

  it("never folds the model into command", () => {
    // command is what the Settings box writes back; a flag folded in
    // would be persisted and then appended a second time.
    const r = resolveAgentConfig({ profile: "claude-code", file: null, command: "claude" }, PROFILES, {
      "claude-code": "opus",
    });
    expect(r.command).toBe("claude");
    expect(r.launchCommand).toBe("claude --model opus");
  });

  it("adds no flag for a profile that has none", () => {
    const r = resolveAgentConfig({ profile: "custom", file: null, command: "my-agent" }, PROFILES, {
      custom: "whatever",
    });
    expect(r.launchCommand).toBe("my-agent");
  });
```

- [x] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run src/lib/settings.test.ts`
Expected: FAIL — expected 3 arguments, got 2 / `launchCommand` undefined.

- [x] **Step 3: Widen the types and the resolver**

In `settings.ts`, add to `AgentProfileInfo`:

```ts
  /// The flag that selects a model; empty where the CLI takes none.
  modelFlag: string;
  /// Stable model aliases offered as picks; empty where the CLI has none.
  models: string[];
```

Add to `ResolvedAgent`:

```ts
  /// The model this workspace launches with: its own, else the app-wide
  /// default for the resolved profile, else "".
  model: string;
  /// `command` with the model flag composed on. What every LAUNCHER
  /// uses; `command` above stays the raw configured value, because that
  /// is what the settings box edits and writes back.
  launchCommand: string;
```

Widen the signature and compute both at the end of the returned object:

```ts
export function resolveAgentConfig(
  config: AgentConfig | null | undefined,
  profiles: AgentProfileInfo[],
  globalModels: Record<string, string>
): ResolvedAgent {
```

```ts
  const profileId = effective?.id ?? FALLBACK_PROFILE;
  const command = nonEmpty(config?.command) ?? nonEmpty(effective?.command) ?? nonEmpty(fallback?.command) ?? "claude";
  // Keyed by the RESOLVED profile, not the requested one: a config
  // naming a profile that no longer exists runs claude-code, so it must
  // inherit claude-code's default rather than a dead row's.
  const model = nonEmpty(config?.model) ?? nonEmpty(globalModels[profileId]) ?? "";
  const modelFlag = effective?.modelFlag ?? "";
```

and return `model`, `modelFlag`-composed `launchCommand: composeLaunchCommand(command, modelFlag, model)`, reusing `profileId`/`command` in the fields that already computed them inline.

- [x] **Step 4: Add the store and load it at bootstrap**

In `layoutState.ts`, beside `mcpFormatsStore`:

```ts
/// App-wide default model per profile id, from config.json. Empty until
/// bootstrap fetches it; resolveAgentConfig treats a missing entry as "no
/// model", so an early call is safe rather than wrong.
export const agentModelDefaultsStore = writable<Record<string, string>>({});
```

Load it where `agentProfilesStore` is populated at bootstrap, and add a setter:

```ts
export async function setAgentModelDefault(profileId: string, model: string): Promise<void> {
  try {
    await backend.setAgentModelDefault(profileId, model);
    agentModelDefaultsStore.update((m) => {
      const next = { ...m };
      if (model.trim()) next[profileId] = model.trim();
      else delete next[profileId];
      return next;
    });
  } catch (e) {
    setError(String(e));
  }
}
```

Widen `setAgentField`'s key union with `| "model"`.

Update `resolvedAgentFor` to pass `get(agentModelDefaultsStore)`.

- [x] **Step 5: Point every launcher at `launchCommand`**

Change `.command` → `.launchCommand` at exactly these launch sites, leaving every *display* site on `.command`:

- `layoutState.ts:759` (`buildRunCommand(resolvedAgentFor(...).command, prompt)`)
- `layoutState.ts` `startMainAgent`'s `backend.createSession(ws.rootPath, ...)`
- `cardRunActions.ts:85` and `:146`
- `orchestrationState.ts:424` and `:478`
- `GitWorktreeSwitcher.svelte:38`

Update the four direct `resolveAgentConfig` callers (`SettingsHubView`, `SetupWizard`, `WorkspaceRootControl`, `GitWorktreeSwitcher`) to pass `$agentModelDefaultsStore` as the third argument.

- [x] **Step 6: Run the suites**

Run: `cd app && npm test && npm run check`
Expected: PASS. `npm run check` is the one that proves no `resolveAgentConfig` call site was missed.

---

### Task 6: The Global Settings modal

**Files:**
- Create: `app/src/lib/GlobalSettingsModal.svelte`
- Modify: `app/src/lib/Sidebar.svelte` (footer row + theme move)

**Interfaces:**
- Consumes: `modelOptions`/`CUSTOM_MODEL` (Task 4), `agentProfilesStore`/`agentModelDefaultsStore`/`setAgentModelDefault` (Task 5), `themeState`.
- Produces: `GlobalSettingsModal` with prop `onClose: () => void`.

- [x] **Step 1: Write the component**

A `Modal`-wrapped panel with two `<section>`s, styled from `SettingsHubView.svelte`'s `.row` / `h3` / `.hint` rules so the two panels read as one family:

- **Appearance** — the `THEME_OPTIONS` segmented `IconButton` group lifted verbatim out of the sidebar footer, still driving `themeState.setPref`.
- **Agent defaults** — `{#each $agentProfilesStore.filter((p) => p.modelFlag) as profile}` a row with the profile label and a `<select>` built from `modelOptions(profile, "")`; selecting `CUSTOM_MODEL` reveals a text input that commits on blur/Enter through `setAgentModelDefault(profile.id, value)`. A row whose stored default is not among the presets starts in the custom state showing that value.
- A `.hint`: "Used by any workspace that sets no model of its own."

- [x] **Step 2: Enable the sidebar row and move the theme control**

Replace the disabled button:

```svelte
    <button class="footer-row" onclick={() => (showGlobalSettings = true)}>
      <Settings size={12} />
      <span>Settings</span>
    </button>
```

Delete the `.theme-row` div (and its now-unused `.theme-row`/`.theme-toggle` CSS if nothing else uses them), keeping the `THEME_OPTIONS` import only where it is still referenced. Render the modal at the bottom beside `WorkspaceCreateModal`:

```svelte
{#if showGlobalSettings}
  <GlobalSettingsModal onClose={() => (showGlobalSettings = false)} />
{/if}
```

- [x] **Step 3: Verify**

Run: `cd app && npm run check && npm run build`
Expected: PASS, with no unused-import or unused-CSS warnings from `Sidebar.svelte`.

---

### Task 7: The workspace Model row, gated

**Files:**
- Modify: `app/src/lib/daemonCompat.ts` (`FEATURE_MIN_VERSION`)
- Modify: `app/src/lib/SettingsHubView.svelte`
- Modify: `app/src/lib/smokeChecklist.ts`
- Test: `app/src/lib/daemonCompat.test.ts` if one exists, else `settings.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `FEATURE_MIN_VERSION.agentModel = 14`.

- [x] **Step 1: Add the gate**

```ts
  // `[agent] model`. A v13 daemon's SetRootConfigField allow-list has no
  // `model` key, so the write comes back as a refusal rather than
  // landing -- the row is disabled with the reason instead of failing on
  // blur.
  agentModel: 14,
```

- [x] **Step 2: Add the Model row**

In `SettingsHubView.svelte`, directly under the Command row, mirroring the existing draft/focus discipline (`focused === "model"` keeps a draft from being overwritten by a watcher push):

- a `<select>` from `modelOptions(profileInfo, globalDefaultForProfile)` bound to the stored value, plus the revealed custom input;
- committing calls `setAgentField(workspaceId, "model", value)` — including `""`, which clears it (Task 2's D63 path);
- the whole control is `disabled` with `title={blockedReason}` when `featureBlockedReason($daemonCompat, "agentModel")` is non-null;
- for a profile with no `modelFlag`, render a `.hint` instead: `Set the model in Command — {profileLabel} takes no model flag gavin knows.`

- [x] **Step 3: Add the smoke items**

In the "Agent" (or nearest) section of `SMOKE_SECTIONS`:

```ts
      {
        id: "global-settings-modal",
        text: "Sidebar footer's Settings opens the global panel, and its Theme control still flips the theme",
        hint: "The footer no longer has its own theme toggle — the panel's is the only one.",
      },
      {
        id: "agent-model-launch",
        text: "A workspace Model set to Custom shows up in the next agent launch's command line",
        hint: "Run a card; the terminal's first line should read `claude --model <what you typed>`.",
      },
```

- [x] **Step 4: Full verification**

Run: `cargo test --workspace` (re-run `cargo test -p gavin-daemon gavin::tests` alone if that module fails), then `cd app && npm test && npm run check && npm run build`.
Expected: all green.

- [x] **Step 5: Report**

Report what is green, and that the daemon must be rebuilt and restarted (a human action) before the workspace Model row leaves its disabled state — the app now speaks v14 and the running daemon speaks v13.
