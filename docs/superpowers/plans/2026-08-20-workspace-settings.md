# Workspace Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a per-workspace Settings hub tab covering name, colour, root folder, notification toggles and the coding agent — with the agent's instructions-file name (hardcoded `CLAUDE.md` today) becoming configurable.

**Architecture:** project facts (`profile`, `file`, `command`) live in `.gavin-root/config.toml`, read by the daemon's existing `scan_root` and pushed on the existing watcher; machine-local preferences (`color`, notification toggles) live in `config.json`. One new daemon request, `SetRootConfigField`, mirrors `SetPlanFrontmatterField`'s allow-list discipline. The agent profile table lives in Rust and reaches the frontend through a command, following `viewable_extensions()`.

**Tech Stack:** Rust (protocol / daemon / Tauri app), `toml_edit` for format-preserving TOML, Svelte 5 runes, vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-08-20-workspace-settings-design.md` (D35–D43).

## Global Constraints

- Work directly on `main`. No worktree — standing user preference.
- Inline Execution is the standing choice. Push only when the user asks.
- **NO Svelte component tests.** vitest here cannot preprocess `.svelte`; a test that merely *imports* a component fails at collection. All testable logic goes in pure `.ts` modules; components are covered by the manual checklist only.
- In vitest, any backend mock whose result gets `.catch()`ed must be `vi.fn().mockResolvedValue(undefined)`. A bare `vi.fn()` returns `undefined` and throws on `.catch()` — this has bitten three times in this project.
- **Rewrite, never delete,** a pre-existing test that encodes a contract this work deliberately changes (e.g. anything asserting `agentCommand` lives in `config.json`).
- Every `Workspace { .. }` literal must be updated — **there are 10** in `app/src-tauri/src/`. Use the compiler (E0063) as the backstop, never a regex: a regex using `Some\([^)]*\)` silently skipped a site last time because the inner `.to_string()` contains a `)`.
- `#[tauri::command]` must sit **immediately** above its `fn`. A stranded attribute (left above a `const` after an edit) fails with "expected `fn`" and cascades into confusing E0433s.
- Every new command must be registered in `app/src-tauri/src/lib.rs`'s `invoke_handler` list, after `agent_setup::setup_agent_integration`.

## Verified groundwork

Checked against the code before writing this plan — do not re-derive:

- `PROTOCOL_VERSION` is **6**, and the pinning test is named `protocol_version_is_six_until_a_breaking_change_bumps_it` (`crates/protocol/src/lib.rs`). Both the constant *and the test's name* change.
- `Request` is `#[derive(Debug, Clone, Serialize, Deserialize)]` with `#[serde(tag = "type")]`.
- **The watcher already covers `config.toml`.** Its filter matches any event path with a `.gavin`/`.gavin-root` component, and `.gavin-root/config.toml` qualifies. Change-gating compares whole trees via `PartialEq` (the comment calls it load-bearing), so adding `agent` to `GavinContext` makes a config-only edit produce a push. The spec's "reads ride the watcher" claim is **correct**.
- `crates/daemon/Cargo.toml` already has `toml = "0.8"`, which is built on `toml_edit` — making it a direct dependency adds no new transitive crates.
- `WorkspaceRootControl.svelte` takes `{ workspace }` and is rendered at `app/src/routes/+page.svelte:113`, between the hub nav and `<activeViewDef.component>`, so it currently appears above **every** hub tab.
- `+page.svelte` renders the nav label as a bare `{view.label}` expression inside the `{#each}` — that is the single site `hubLabel()` replaces.
- **Real gap:** `handleSessionStatusChanged(sessionId, status)` in `layoutState.ts` has no workspace id, and `maybeNotifyStatusChange` therefore cannot consult per-workspace toggles. `handleSessionExited` already does this lookup inline (page-tree walk plus the `mainSessionId` branch). Task 4 extracts it once as `workspaceIdForSession`; Task 5 makes both callers use it.
- `Sidebar.svelte` has **two** workspace row sites: the pinned Unfiled row (~line 505) and the regular list (~line 540). Both need the colour stripe.

---

## File Structure

**Create**
- `app/src/lib/settings.ts` — pure settings logic: colour normalisation, agent-file validation, the rename decision, agent-config resolution.
- `app/src/lib/settings.test.ts`
- `app/src/lib/SettingsHubView.svelte` — the panel.
- `app/src/lib/ColourPicker.svelte` — palette swatches + custom input + live preview.

**Modify**
- `crates/protocol/src/lib.rs` — `AgentConfig`, `GavinContext.agent`, `SetRootConfigField`, version 7.
- `crates/daemon/src/gavin.rs` — parse `[agent]`, `set_root_config_field`.
- `crates/daemon/src/server.rs` — the new arm.
- `crates/daemon/Cargo.toml` — `toml_edit`.
- `app/src-tauri/src/agent_setup.rs` — `AgentProfile` table + `McpLayout`.
- `app/src-tauri/src/config.rs` — `color`, `notify_needs_input`, `notify_finished`; drop `agent_command`.
- `app/src-tauri/src/session.rs` — the carry-over migration.
- `app/src-tauri/src/lib.rs` — register commands.
- `app/src/lib/backend.ts`, `workspace.ts`, `workspaceViews.ts`, `layoutState.ts`, `notifications.ts`, `gavin.ts`
- `app/src/lib/AgentFileHubView.svelte`, `HomeHubView.svelte`, `WorkspaceRootControl.svelte`, `Pane.svelte`, `Sidebar.svelte`
- `app/src/routes/+page.svelte`
- `app/src/lib/smokeChecklist.ts`

---

### Task 1: Protocol and daemon — `[agent]` config read and write

**Files:**
- Modify: `crates/protocol/src/lib.rs`, `crates/daemon/src/gavin.rs`, `crates/daemon/src/server.rs`, `crates/daemon/Cargo.toml`

**Interfaces:**
- Produces: `protocol::AgentConfig { profile: Option<String>, file: Option<String>, command: Option<String> }`; `GavinContext.agent: Option<AgentConfig>`; `Request::SetRootConfigField { root_path, key, value }`; `gavin::set_root_config_field(root: &Path, key: &str, value: &str) -> anyhow::Result<()>`.

- [ ] **Step 1: Add the dependency.**

In `crates/daemon/Cargo.toml`, beside `toml = "0.8"`:

```toml
toml_edit = "0.22"
```

Run `cargo build -p daemon` to confirm it resolves.

- [ ] **Step 2: Write the failing protocol tests.**

In `crates/protocol/src/lib.rs`'s test module:

```rust
    #[test]
    fn agent_config_serializes_to_the_camel_case_shape_the_frontend_expects() {
        let ctx = GavinContext {
            folder_path: "/ws".to_string(),
            kind: GavinContextKind::Root,
            name: "ws".to_string(),
            plans: vec![],
            docs: vec![],
            specs: vec![],
            has_prd: false,
            config_warning: false,
            agent: Some(AgentConfig {
                profile: Some("claude-code".to_string()),
                file: None,
                command: Some("claude --model opus".to_string()),
            }),
        };
        let json = serde_json::to_value(&ctx).unwrap();
        assert_eq!(
            json["agent"],
            serde_json::json!({
                "profile": "claude-code",
                "file": null,
                "command": "claude --model opus"
            })
        );
    }

    #[test]
    fn set_root_config_field_round_trips() {
        let req = Request::SetRootConfigField {
            root_path: "/ws".to_string(),
            key: "profile".to_string(),
            value: "codex".to_string(),
        };
        let mut buf = Vec::new();
        write_message(&mut buf, &req).unwrap();
        let back: Request = read_message(&mut &buf[..]).unwrap().unwrap();
        match back {
            Request::SetRootConfigField { root_path, key, value } => {
                assert_eq!((root_path.as_str(), key.as_str(), value.as_str()), ("/ws", "profile", "codex"));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }
```

Then **rename** the existing version test and change its value:

```rust
    #[test]
    fn protocol_version_is_seven_until_a_breaking_change_bumps_it() {
        // v7: GavinContext.agent + SetRootConfigField (workspace settings).
        assert_eq!(PROTOCOL_VERSION, 7);
    }
```

> If `write_message`/`read_message` are not the names used by the neighbouring round-trip tests in this file, copy whatever those tests use — match the file, not this plan.

- [ ] **Step 3: Run — expect failure.**

`cargo test -p protocol` → fails: `AgentConfig` not found, and the version test fails on 6 ≠ 7.

- [ ] **Step 4: Implement the protocol changes.**

Bump the constant:

```rust
pub const PROTOCOL_VERSION: u32 = 7;
```

Add beside `GavinContext`:

```rust
/// The root context's `[agent]` block from `.gavin-root/config.toml`.
/// Every field optional: a config.toml predating workspace settings
/// parses cleanly with all three `None`, and the profile defaults apply.
/// Only ever populated for the root context -- `.gavin` sub-contexts have
/// no agent block.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub profile: Option<String>,
    pub file: Option<String>,
    pub command: Option<String>,
}
```

Add the field to `GavinContext` (after `config_warning`):

```rust
    pub agent: Option<AgentConfig>,
```

Add the request variant, after `SetPlanFrontmatterField`:

```rust
    /// Writes one key of `.gavin-root/config.toml`'s `[agent]` table.
    /// Allow-listed to profile/file/command -- like
    /// SetPlanFrontmatterField this must never become an arbitrary-key
    /// writer into a file the user hand-edits.
    SetRootConfigField {
        root_path: String,
        key: String,
        value: String,
    },
```

- [ ] **Step 5: Run** — `cargo test -p protocol` passes. `cargo build` now fails in the daemon: every `GavinContext { .. }` literal is missing `agent`. That is expected and Step 7 fixes it.

- [ ] **Step 6: Write the failing daemon tests.**

In `crates/daemon/src/gavin.rs`'s test module:

```rust
    #[test]
    fn scan_surfaces_the_agent_block_on_the_root_context_only() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        std::fs::write(
            dir.path().join(GAVIN_ROOT_DIR).join("config.toml"),
            "version = 1\n\n[agent]\nprofile = \"codex\"\ncommand = \"codex\"\n",
        )
        .unwrap();
        let sub = dir.path().join("svc");
        std::fs::create_dir_all(sub.join(GAVIN_DIR)).unwrap();

        let tree = scan_root(dir.path());
        let root = tree.contexts.iter().find(|c| c.kind == GavinContextKind::Root).unwrap();
        let agent = root.agent.as_ref().unwrap();
        assert_eq!(agent.profile.as_deref(), Some("codex"));
        assert_eq!(agent.command.as_deref(), Some("codex"));
        assert_eq!(agent.file, None, "absent key stays None so the profile default applies");

        let child = tree.contexts.iter().find(|c| c.kind != GavinContextKind::Root).unwrap();
        assert_eq!(child.agent, None, "only the root context carries an agent block");
    }

    #[test]
    fn a_config_without_an_agent_block_scans_to_none_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap(); // template has no [agent]
        let tree = scan_root(dir.path());
        let root = tree.contexts.iter().find(|c| c.kind == GavinContextKind::Root).unwrap();
        assert_eq!(root.agent, None);
        assert!(!root.config_warning);
    }

    #[test]
    fn set_root_config_field_writes_each_allowed_key_and_rejects_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();

        set_root_config_field(dir.path(), "profile", "codex").unwrap();
        set_root_config_field(dir.path(), "file", "AGENTS.md").unwrap();
        set_root_config_field(dir.path(), "command", "codex --full-auto").unwrap();

        let tree = scan_root(dir.path());
        let agent = tree.contexts[0].agent.as_ref().unwrap();
        assert_eq!(agent.profile.as_deref(), Some("codex"));
        assert_eq!(agent.file.as_deref(), Some("AGENTS.md"));
        assert_eq!(agent.command.as_deref(), Some("codex --full-auto"));

        assert!(set_root_config_field(dir.path(), "version", "9").is_err(), "unknown key");
        assert!(set_root_config_field(dir.path(), "profile", "").is_err(), "empty value");
        assert!(set_root_config_field(dir.path(), "profile", "a\nb").is_err(), "newline");
    }

    #[test]
    fn set_root_config_field_preserves_comments_and_key_order() {
        let dir = tempfile::tempdir().unwrap();
        let g = dir.path().join(GAVIN_ROOT_DIR);
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(
            g.join("config.toml"),
            "# hand-written, keep me\nversion = 1\nname = \"Mine\"\n\n[agent]\n# and me\nprofile = \"claude-code\"\n",
        )
        .unwrap();

        set_root_config_field(dir.path(), "command", "claude --model opus").unwrap();

        let after = std::fs::read_to_string(g.join("config.toml")).unwrap();
        assert!(after.contains("# hand-written, keep me"));
        assert!(after.contains("# and me"));
        assert!(after.contains("name = \"Mine\""));
        assert!(after.contains("command = \"claude --model opus\""));
    }

    #[test]
    fn set_root_config_field_creates_the_agent_table_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let g = dir.path().join(GAVIN_ROOT_DIR);
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(g.join("config.toml"), "version = 1\n").unwrap();

        set_root_config_field(dir.path(), "profile", "gemini").unwrap();

        let tree = scan_root(dir.path());
        assert_eq!(tree.contexts[0].agent.as_ref().unwrap().profile.as_deref(), Some("gemini"));
    }

    #[test]
    fn set_root_config_field_refuses_an_unparseable_file_rather_than_clobbering_it() {
        let dir = tempfile::tempdir().unwrap();
        let g = dir.path().join(GAVIN_ROOT_DIR);
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(g.join("config.toml"), "this is not [ valid toml\n").unwrap();

        assert!(set_root_config_field(dir.path(), "profile", "codex").is_err());
        assert_eq!(
            std::fs::read_to_string(g.join("config.toml")).unwrap(),
            "this is not [ valid toml\n",
            "the file must survive untouched"
        );
    }
```

- [ ] **Step 7: Implement the daemon side.**

`parse_context_name` currently returns `(Option<String>, bool)`. Widen it rather than parsing the file twice — rename it `parse_context_config` and return the agent block too:

```rust
/// A context's display name and (for a root context) its `[agent]` block,
/// from one parse of config.toml. The bool is config_warning: false for a
/// missing file (absent config is normal), true only when the file exists
/// but doesn't parse as TOML.
fn parse_context_config(config_path: &Path) -> (Option<String>, Option<AgentConfig>, bool) {
    let content = match std::fs::read_to_string(config_path) {
        Ok(c) => c,
        Err(_) => return (None, None, false),
    };
    match content.parse::<toml::Table>() {
        Ok(table) => {
            let name = table.get("name").and_then(|v| v.as_str()).map(str::to_string);
            let agent = table.get("agent").and_then(|v| v.as_table()).map(|t| {
                let get = |k: &str| t.get(k).and_then(|v| v.as_str()).map(str::to_string);
                AgentConfig { profile: get("profile"), file: get("file"), command: get("command") }
            });
            (name, agent, false)
        }
        Err(_) => (None, None, true),
    }
}
```

At the call site (currently `let (config_name, config_warning) = parse_context_name(...)`), destructure three values and set `agent` on the built `GavinContext` — **only for the root context**:

```rust
    let (config_name, agent_config, config_warning) = parse_context_config(&gavin_dir.join("config.toml"));
    // ... in the GavinContext literal:
    agent: if kind == GavinContextKind::Root { agent_config } else { None },
```

> Read the surrounding function first: if `kind` is not in scope under that exact name at the literal, use whatever the file already calls it. Every other `GavinContext { .. }` literal in the crate (including in tests) gets `agent: None`.

Add the writer, beside `set_plan_field`:

```rust
/// Writes one `[agent]` key of `.gavin-root/config.toml`. Uses toml_edit
/// so comments, key order and formatting survive -- this file is
/// hand-edited by users and read by their agents. Allow-listed exactly
/// like set_plan_field: never an arbitrary-key writer.
pub fn set_root_config_field(root: &Path, key: &str, value: &str) -> anyhow::Result<()> {
    if !matches!(key, "profile" | "file" | "command") {
        anyhow::bail!("not a settable agent key: {key}");
    }
    if value.trim().is_empty() || value.contains('\n') {
        anyhow::bail!("{key} must be a non-empty single line");
    }
    let path = root.join(GAVIN_ROOT_DIR).join("config.toml");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut doc = existing
        .parse::<toml_edit::DocumentMut>()
        .map_err(|_| anyhow::anyhow!("{} is not valid TOML -- fix or remove it first", path.display()))?;
    doc["agent"][key] = toml_edit::value(value);
    // A freshly created [agent] arrives as an inline table; make it a
    // normal section so the file stays readable to whoever opens it next.
    if let Some(t) = doc["agent"].as_table_mut() {
        t.set_implicit(false);
    }
    std::fs::write(&path, doc.to_string())?;
    Ok(())
}
```

In `crates/daemon/src/server.rs`, beside the `SetPlanFrontmatterField` arm:

```rust
        Request::SetRootConfigField { root_path, key, value } => {
            crate::gavin::set_root_config_field(std::path::Path::new(&root_path), &key, &value)
                .map(|_| Response::Ok)
        }
```

- [ ] **Step 8: Run** — `cargo test -p protocol -p daemon` green. Fix any remaining `GavinContext` literal the compiler names.

- [ ] **Step 9: Commit**

```bash
git add crates && git commit -m "feat(settings): agent config in config.toml, read on scan and written via SetRootConfigField"
```

---

### Task 2: The agent profile table and its commands

**Files:**
- Modify: `app/src-tauri/src/agent_setup.rs`, `app/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `agent_setup::AGENT_PROFILES: &[AgentProfile]`; commands `agent_setup::agent_profiles() -> Vec<AgentProfileDto>` and `agent_setup::move_agent_file(root_path, from, to) -> Result<(), String>`.

- [ ] **Step 1: Write the failing tests** in `agent_setup.rs`'s test module:

```rust
    #[test]
    fn every_profile_row_is_usable_and_ids_are_unique() {
        let mut ids: Vec<&str> = AGENT_PROFILES.iter().map(|p| p.id).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "profile ids must be unique");
        assert_eq!(count, 6, "claude-code, codex, gemini, cursor, opencode, custom");

        for p in AGENT_PROFILES {
            assert!(!p.label.is_empty(), "{} has no label", p.id);
            if p.id == "custom" {
                assert!(p.instructions_file.is_empty(), "custom is user-supplied");
                assert!(p.command.is_empty(), "custom is user-supplied");
            } else {
                assert!(!p.instructions_file.is_empty(), "{} has no instructions file", p.id);
                assert!(!p.command.is_empty(), "{} has no command", p.id);
            }
        }
    }

    #[test]
    fn only_claude_code_supports_mcp_in_this_sub_project() {
        let with_mcp: Vec<&str> =
            AGENT_PROFILES.iter().filter(|p| p.mcp.is_some()).map(|p| p.id).collect();
        assert_eq!(with_mcp, ["claude-code"]);
    }

    #[test]
    fn move_agent_file_renames_and_refuses_an_existing_target() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("CLAUDE.md"), "# mine\n").unwrap();

        move_agent_file(dir.path().to_string_lossy().to_string(), "CLAUDE.md".into(), "AGENTS.md".into())
            .unwrap();
        assert!(!dir.path().join("CLAUDE.md").exists());
        assert_eq!(std::fs::read_to_string(dir.path().join("AGENTS.md")).unwrap(), "# mine\n");

        // Target exists -> refused, both files untouched.
        std::fs::write(dir.path().join("CLAUDE.md"), "# new\n").unwrap();
        assert!(move_agent_file(
            dir.path().to_string_lossy().to_string(),
            "CLAUDE.md".into(),
            "AGENTS.md".into()
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(dir.path().join("AGENTS.md")).unwrap(), "# mine\n");
    }

    #[test]
    fn move_agent_file_rejects_path_traversal() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("CLAUDE.md"), "x").unwrap();
        assert!(move_agent_file(
            dir.path().to_string_lossy().to_string(),
            "CLAUDE.md".into(),
            "../escaped.md".into()
        )
        .is_err());
    }
```

- [ ] **Step 2: Run** — `cargo test -p app agent_setup` fails: `AGENT_PROFILES` not found.

- [ ] **Step 3: Replace `ClaudeCodeProfile` with the table.**

Delete the `ClaudeCodeProfile` struct and the `CLAUDE_CODE` const, and put this in their place:

```rust
/// Where a profile's agent reads MCP config. Held only by profiles that
/// gavin can actually set up; sub-project B fills in the rest (the
/// verified layouts are recorded in the design spec's §4.1).
pub struct McpLayout {
    pub config_file: &'static str,
    pub server_key: &'static str,
    pub skill_dir: &'static str,
    pub skill_file: &'static str,
}

/// D4's seam, widened. The writers below read fields, never literals.
pub struct AgentProfile {
    pub id: &'static str,
    pub label: &'static str,
    /// Empty for `custom`, where the user supplies it.
    pub instructions_file: &'static str,
    /// Empty for `custom`, where the user supplies it.
    pub command: &'static str,
    pub mcp: Option<McpLayout>,
}

pub const AGENT_PROFILES: &[AgentProfile] = &[
    AgentProfile {
        id: "claude-code",
        label: "Claude Code",
        instructions_file: "CLAUDE.md",
        command: "claude",
        mcp: Some(McpLayout {
            config_file: ".mcp.json",
            server_key: "gavin",
            skill_dir: ".claude/skills/gavin",
            skill_file: "SKILL.md",
        }),
    },
    AgentProfile { id: "codex", label: "Codex CLI", instructions_file: "AGENTS.md", command: "codex", mcp: None },
    AgentProfile { id: "gemini", label: "Gemini CLI", instructions_file: "GEMINI.md", command: "gemini", mcp: None },
    AgentProfile { id: "cursor", label: "Cursor", instructions_file: "AGENTS.md", command: "cursor", mcp: None },
    AgentProfile { id: "opencode", label: "opencode", instructions_file: "AGENTS.md", command: "opencode", mcp: None },
    AgentProfile { id: "custom", label: "Custom…", instructions_file: "", command: "", mcp: None },
];

pub fn profile_by_id(id: &str) -> &'static AgentProfile {
    AGENT_PROFILES.iter().find(|p| p.id == id).unwrap_or(&AGENT_PROFILES[0])
}
```

- [ ] **Step 4: Point the existing writers at the table.**

`write_mcp_config`, `write_skill` and `write_instructions_block` take `profile: &ClaudeCodeProfile` today. Change each signature to `layout: &McpLayout` (they only ever use MCP fields) except `write_instructions_block`, which needs the filename — give it `(root: &Path, instructions_file: &str)` and use that instead of `profile.instructions_file`.

In `setup_agent_integration`, resolve the profile before writing:

```rust
pub fn setup_agent_integration(root_path: String) -> Result<Vec<String>, String> {
    let root = Path::new(&root_path);
    let profile = profile_by_id(&read_profile_id(root));
    let Some(layout) = profile.mcp.as_ref() else {
        return Err(format!("MCP integration isn't available for {} yet", profile.label));
    };
    // ... existing body, passing `layout` where `&CLAUDE_CODE` went, and
    // resolved_instructions_file(root, profile) to write_instructions_block.
}
```

with these two helpers:

```rust
/// The profile id recorded in config.toml, defaulting to claude-code.
/// Read directly here rather than routed through the daemon: this is a
/// one-shot read on a user-initiated action, and agent_setup already
/// touches the root's files directly.
fn read_profile_id(root: &Path) -> String {
    let path = root.join(".gavin-root").join("config.toml");
    std::fs::read_to_string(path)
        .ok()
        .and_then(|c| c.parse::<toml::Table>().ok())
        .and_then(|t| {
            t.get("agent")?.as_table()?.get("profile")?.as_str().map(str::to_string)
        })
        .unwrap_or_else(|| "claude-code".to_string())
}

/// config.toml's explicit `file`, else the profile's default.
fn resolved_instructions_file(root: &Path, profile: &AgentProfile) -> String {
    let path = root.join(".gavin-root").join("config.toml");
    std::fs::read_to_string(path)
        .ok()
        .and_then(|c| c.parse::<toml::Table>().ok())
        .and_then(|t| t.get("agent")?.as_table()?.get("file")?.as_str().map(str::to_string))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| profile.instructions_file.to_string())
}
```

> `toml` is already an app dependency only if `agent_setup.rs` compiles with it — check `app/src-tauri/Cargo.toml` and add `toml = "0.8"` there if absent.

- [ ] **Step 5: Add the two commands.**

```rust
/// The profile table, flattened for the frontend. Mirrors
/// fileviewer::viewable_extensions -- one source of truth in Rust rather
/// than a TypeScript copy that drifts.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileDto {
    pub id: String,
    pub label: String,
    pub instructions_file: String,
    pub command: String,
    pub mcp_supported: bool,
}

#[tauri::command]
pub fn agent_profiles() -> Vec<AgentProfileDto> {
    AGENT_PROFILES
        .iter()
        .map(|p| AgentProfileDto {
            id: p.id.to_string(),
            label: p.label.to_string(),
            instructions_file: p.instructions_file.to_string(),
            command: p.command.to_string(),
            mcp_supported: p.mcp.is_some(),
        })
        .collect()
}

/// Renames the agent instructions file. Refuses when the target exists --
/// gavin never overwrites (D10) -- and when either name is not a bare
/// filename, so a settings field can never write outside the root.
#[tauri::command]
pub fn move_agent_file(root_path: String, from: String, to: String) -> Result<(), String> {
    for name in [&from, &to] {
        if name.trim().is_empty() || name.contains('/') || name.contains('\\') {
            return Err(format!("not a bare file name: {name}"));
        }
    }
    let root = Path::new(&root_path);
    let target = root.join(&to);
    if target.exists() {
        return Err(format!("{to} already exists — pointing at it instead of moving"));
    }
    std::fs::rename(root.join(&from), target).map_err(|e| e.to_string())
}
```

- [ ] **Step 6: Register both** in `app/src-tauri/src/lib.rs`, after `agent_setup::setup_agent_integration`:

```rust
            agent_setup::setup_agent_integration,
            agent_setup::agent_profiles,
            agent_setup::move_agent_file
```

- [ ] **Step 7: Run** — `cargo test -p app` green.

- [ ] **Step 8: Commit**

```bash
git add app/src-tauri && git commit -m "feat(settings): agent profile table with profile and move-file commands"
```

---

### Task 3: `config.json` fields and the command migration

**Files:**
- Modify: `app/src-tauri/src/config.rs`, `app/src-tauri/src/session.rs`

**Interfaces:**
- Consumes: `gavin::set_root_config_field` (Task 1), reached via the daemon.
- Produces: `Workspace.color`, `Workspace.notify_needs_input`, `Workspace.notify_finished`; `agent_command` **removed**.

- [ ] **Step 1: Write the failing config tests.**

```rust
    #[test]
    fn settings_fields_default_when_absent_from_an_older_workspace_object() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces": [{"id": "ws-1", "name": "A", "pages": [], "activePageId": null}]}"#,
        )
        .unwrap();
        let ws = &load(dir.path()).unwrap().workspaces[0];
        assert_eq!(ws.color, None, "absent colour means the default accent");
        assert!(ws.notify_needs_input, "notifications default on");
        assert!(ws.notify_finished, "notifications default on");
    }

    #[test]
    fn settings_fields_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = sample_workspace();
        ws.color = Some("#a78bfa".to_string());
        ws.notify_finished = false;
        let config = AppConfig {
            workspaces: vec![ws],
            active_workspace_id: Some("workspace-1".to_string()),
            session_names: HashMap::new(),
            file_tabs: HashMap::new(),
            board_tabs: HashMap::new(),
        };
        save(dir.path(), &config).unwrap();
        assert_eq!(load(dir.path()).unwrap(), config);
    }
```

> `AppConfig`'s field list may have grown — copy the literal from the neighbouring test in the file rather than this plan.

- [ ] **Step 2: Run** — fails: no field `color`.

- [ ] **Step 3: Change the struct.** In `config.rs`'s `Workspace`, **delete** `agent_command` and add:

```rust
    /// Accent colour for this workspace's tab indicator and sidebar
    /// stripe. `#rrggbb`; absent means the default accent. Machine-local
    /// (D35) -- a display preference, like the name.
    #[serde(default)]
    pub color: Option<String>,
    /// Per-workspace notification toggles (D38). Default true so existing
    /// workspaces keep today's behaviour.
    #[serde(default = "default_true")]
    pub notify_needs_input: bool,
    #[serde(default = "default_true")]
    pub notify_finished: bool,
```

and, at module level:

```rust
fn default_true() -> bool {
    true
}
```

- [ ] **Step 4: Fix every literal with the compiler.**

Run `cargo build -p app` and fix each E0063 it names — **10 `Workspace { .. }` literals** across `config.rs` and `session.rs`. Add `color: None, notify_needs_input: true, notify_finished: true, legacy_agent_command: None` and remove `agent_command`. (`legacy_agent_command` is introduced in Step 8; add it in the same pass so the literals are only touched once.) Do **not** use a regex: last time one silently skipped a site whose `Some("…".to_string())` contained the `)` the pattern stopped at. Repeat `cargo build` until clean.

- [ ] **Step 5: Update the shape test.** `workspace_serializes_to_the_camel_case_shape_the_frontend_expects` must now expect `"color": null, "notifyNeedsInput": true, "notifyFinished": true` and **no** `"agentCommand"` key.

Any pre-existing test asserting `agentCommand` round-trips is **rewritten** against the new contract (e.g. `main_session_and_agent_command_roundtrip` becomes `main_session_id_roundtrips`, dropping only the command assertion), never deleted.

- [ ] **Step 6: Write the failing migration test** in `session.rs`:

```rust
    #[test]
    fn carries_a_legacy_agent_command_into_config_toml_once() {
        let dir = tempfile::tempdir().unwrap();
        let g = dir.path().join(".gavin-root");
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(g.join("config.toml"), "version = 1\n").unwrap();
        let root = dir.path().to_string_lossy().to_string();

        // Legacy value present, config.toml has none -> carried over.
        carry_over_agent_command(&root, Some("claude --model opus")).unwrap();
        let after = std::fs::read_to_string(g.join("config.toml")).unwrap();
        assert!(after.contains("command = \"claude --model opus\""));

        // Runs again with a different legacy value -> no-op, the file wins.
        carry_over_agent_command(&root, Some("something-else")).unwrap();
        let after2 = std::fs::read_to_string(g.join("config.toml")).unwrap();
        assert!(after2.contains("command = \"claude --model opus\""));
        assert!(!after2.contains("something-else"));
    }

    #[test]
    fn carry_over_is_a_no_op_without_a_legacy_value() {
        let dir = tempfile::tempdir().unwrap();
        let g = dir.path().join(".gavin-root");
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(g.join("config.toml"), "version = 1\n").unwrap();
        let root = dir.path().to_string_lossy().to_string();
        carry_over_agent_command(&root, None).unwrap();
        assert_eq!(std::fs::read_to_string(g.join("config.toml")).unwrap(), "version = 1\n");
    }
```

- [ ] **Step 7: Implement the migration** in `session.rs`:

```rust
/// One-time carry-over of D34's `agentCommand` from config.json into
/// config.toml (D41). Writes only when config.toml has no
/// `[agent].command`, so the file always wins on later launches and a
/// user's edit is never reverted. Unrooted workspaces have nowhere to
/// carry to and are skipped by the caller -- no loss, since
/// startMainAgent already refuses to run without a root.
fn carry_over_agent_command(root_path: &str, legacy: Option<&str>) -> anyhow::Result<()> {
    let Some(legacy) = legacy.filter(|c| !c.trim().is_empty()) else { return Ok(()) };
    let path = std::path::Path::new(root_path).join(".gavin-root").join("config.toml");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let already = existing
        .parse::<toml::Table>()
        .ok()
        .and_then(|t| Some(t.get("agent")?.as_table()?.contains_key("command")))
        .unwrap_or(false);
    if already {
        return Ok(());
    }
    crate::agent_setup::write_root_config_key(std::path::Path::new(root_path), "command", legacy)
}
```

Rather than duplicate the `toml_edit` writer, expose it once. Add to `agent_setup.rs` (it already owns direct root-file writes):

```rust
/// Same allow-list and format-preserving write as the daemon's
/// set_root_config_field, for the app-side paths that must not depend on
/// a daemon round trip (the launch-command migration).
pub fn write_root_config_key(root: &Path, key: &str, value: &str) -> anyhow::Result<()> {
    if !matches!(key, "profile" | "file" | "command") {
        anyhow::bail!("not a settable agent key: {key}");
    }
    let path = root.join(".gavin-root").join("config.toml");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut doc = existing
        .parse::<toml_edit::DocumentMut>()
        .map_err(|_| anyhow::anyhow!("{} is not valid TOML", path.display()))?;
    doc["agent"][key] = toml_edit::value(value);
    if let Some(t) = doc["agent"].as_table_mut() {
        t.set_implicit(false);
    }
    std::fs::write(&path, doc.to_string())?;
    Ok(())
}
```

Add `toml_edit = "0.22"` to `app/src-tauri/Cargo.toml`.

- [ ] **Step 8: Call it from bootstrap.**

`bootstrap` currently reads the persisted workspaces before `resolve_workspaces`. Because `agent_command` is being removed from the struct, read the legacy value from the raw JSON **before** deserialisation is lossy — simplest correct approach: keep a `#[serde(default)] pub legacy_agent_command: Option<String>` field aliased to the old key for one release:

```rust
    /// D41 migration only: the pre-settings `agentCommand`. Read once at
    /// bootstrap, carried into config.toml, then never written back --
    /// `save` omits it because it serialises as None from then on.
    #[serde(default, rename = "agentCommand", skip_serializing_if = "Option::is_none")]
    pub legacy_agent_command: Option<String>,
```

Then in `bootstrap`, immediately after `reconcile_smoketest_workspace(&mut workspaces);`:

```rust
    for ws in workspaces.iter_mut() {
        if let (Some(root), Some(legacy)) = (ws.root_path.clone(), ws.legacy_agent_command.take()) {
            if let Err(e) = carry_over_agent_command(&root, Some(&legacy)) {
                eprintln!("agent command carry-over failed for {}: {e}", ws.id);
            }
        }
    }
```

Taking the value clears it, so the next `save` drops the key permanently.

- [ ] **Step 9: Run** — `cargo test -p app` green.

- [ ] **Step 10: Commit**

```bash
git add app/src-tauri && git commit -m "feat(settings): colour and notification fields, agent command migrated to config.toml"
```

---

### Task 4: Pure TypeScript logic

**Files:**
- Create: `app/src/lib/settings.ts`, `app/src/lib/settings.test.ts`
- Modify: `app/src/lib/workspace.ts`, `app/src/lib/workspace.test.ts`, `app/src/lib/gavin.ts`

**Interfaces:**
- Produces: `DEFAULT_ACCENT`, `normalizeColor`, `PALETTE`, `validateAgentFileName`, `renameDecision`, `resolveAgentConfig`, `AgentProfileInfo`; and in `workspace.ts`, `hubLabel`, `workspaceIdForSession`.

- [ ] **Step 1: Mirror the wire type** in `app/src/lib/gavin.ts`, beside `GavinContext`:

```typescript
export interface AgentConfig {
  profile: string | null;
  file: string | null;
  command: string | null;
}
```

and add to `GavinContext`:

```typescript
  agent?: AgentConfig | null;
```

- [ ] **Step 2: Write the failing tests** (`settings.test.ts`):

```typescript
import { describe, it, expect } from "vitest";
import {
  DEFAULT_ACCENT,
  PALETTE,
  normalizeColor,
  validateAgentFileName,
  renameDecision,
  resolveAgentConfig,
  type AgentProfileInfo,
} from "./settings";

const PROFILES: AgentProfileInfo[] = [
  { id: "claude-code", label: "Claude Code", instructionsFile: "CLAUDE.md", command: "claude", mcpSupported: true },
  { id: "codex", label: "Codex CLI", instructionsFile: "AGENTS.md", command: "codex", mcpSupported: false },
  { id: "custom", label: "Custom…", instructionsFile: "", command: "", mcpSupported: false },
];

describe("normalizeColor", () => {
  it("accepts a six-digit hex in either case", () => {
    expect(normalizeColor("#a78bfa")).toBe("#a78bfa");
    expect(normalizeColor("#A78BFA")).toBe("#a78bfa");
  });

  it("falls back to the default for anything else", () => {
    for (const bad of ["#fff", "red", "", "  ", "#gggggg", "#a78bfa; background: url(x)", "javascript:alert(1)"]) {
      expect(normalizeColor(bad)).toBe(DEFAULT_ACCENT);
    }
    expect(normalizeColor(undefined)).toBe(DEFAULT_ACCENT);
    expect(normalizeColor(null)).toBe(DEFAULT_ACCENT);
  });

  it("offers a palette whose entries all normalize to themselves", () => {
    expect(PALETTE.length).toBe(8);
    expect(PALETTE[0]).toBe(DEFAULT_ACCENT);
    for (const c of PALETTE) expect(normalizeColor(c)).toBe(c);
  });
});

describe("validateAgentFileName", () => {
  it("accepts a bare file name, with or without an extension", () => {
    expect(validateAgentFileName("AGENTS.md")).toBeNull();
    expect(validateAgentFileName(".cursorrules")).toBeNull();
  });

  it("rejects empty, whitespace-only, and anything with a path separator", () => {
    expect(validateAgentFileName("")).toBeTruthy();
    expect(validateAgentFileName("   ")).toBeTruthy();
    expect(validateAgentFileName("docs/AGENTS.md")).toBeTruthy();
    expect(validateAgentFileName("..\\AGENTS.md")).toBeTruthy();
  });
});

describe("renameDecision", () => {
  it("prompts when the old file exists and the target does not", () => {
    expect(renameDecision("CLAUDE.md", "AGENTS.md", true, false)).toBe("prompt");
  });

  it("points when the target already exists — never overwrite", () => {
    expect(renameDecision("CLAUDE.md", "AGENTS.md", true, true)).toBe("point");
  });

  it("points silently when there is no old file to move", () => {
    expect(renameDecision("CLAUDE.md", "AGENTS.md", false, false)).toBe("point");
  });

  it("errors on an invalid new name", () => {
    expect(renameDecision("CLAUDE.md", "a/b.md", true, false)).toBe("error");
    expect(renameDecision("CLAUDE.md", "", true, false)).toBe("error");
  });

  it("points when the name did not actually change", () => {
    expect(renameDecision("CLAUDE.md", "CLAUDE.md", true, false)).toBe("point");
  });
});

describe("resolveAgentConfig", () => {
  it("prefers explicit config over the profile default", () => {
    const r = resolveAgentConfig({ profile: "codex", file: "NOTES.md", command: "codex --x" }, PROFILES);
    expect(r).toEqual({ profileId: "codex", file: "NOTES.md", command: "codex --x", mcpSupported: false });
  });

  it("falls back to the profile's defaults for absent keys", () => {
    const r = resolveAgentConfig({ profile: "codex", file: null, command: null }, PROFILES);
    expect(r.file).toBe("AGENTS.md");
    expect(r.command).toBe("codex");
  });

  it("falls back to claude-code for a missing or unknown profile", () => {
    expect(resolveAgentConfig(null, PROFILES)).toEqual({
      profileId: "claude-code", file: "CLAUDE.md", command: "claude", mcpSupported: true,
    });
    expect(resolveAgentConfig({ profile: "not-a-thing", file: null, command: null }, PROFILES).profileId).toBe(
      "claude-code"
    );
  });

  it("keeps custom usable only through its explicit values", () => {
    const r = resolveAgentConfig({ profile: "custom", file: "RULES.md", command: "my-agent" }, PROFILES);
    expect(r).toEqual({ profileId: "custom", file: "RULES.md", command: "my-agent", mcpSupported: false });
    // Custom with nothing filled in still resolves to something safe.
    const bare = resolveAgentConfig({ profile: "custom", file: null, command: null }, PROFILES);
    expect(bare.file).toBe("CLAUDE.md");
    expect(bare.command).toBe("claude");
  });

  it("is empty-string safe — a cleared field is not an override", () => {
    const r = resolveAgentConfig({ profile: "codex", file: "  ", command: "" }, PROFILES);
    expect(r.file).toBe("AGENTS.md");
    expect(r.command).toBe("codex");
  });
});
```

- [ ] **Step 3: Run** — `npx vitest run src/lib/settings.test.ts` fails to resolve `./settings`.

- [ ] **Step 4: Implement `settings.ts`:**

```typescript
import type { AgentConfig } from "./gavin";

/// Mirrors AgentProfileDto from agent_setup.rs, fetched via
/// backend.agentProfiles(). Never duplicated as a literal table here --
/// Rust is the single source of truth.
export interface AgentProfileInfo {
  id: string;
  label: string;
  instructionsFile: string;
  command: string;
  mcpSupported: boolean;
}

export const DEFAULT_ACCENT = "#4a9eff";

/// Eight presets chosen to stay legible against the #1e1e1e/#2a2a2a
/// chrome. The default is first so the palette's first swatch is the
/// current look.
export const PALETTE = [
  DEFAULT_ACCENT,
  "#59c36a",
  "#2dd4bf",
  "#a78bfa",
  "#f472b6",
  "#f87171",
  "#fb923c",
  "#fbbf24",
] as const;

const HEX = /^#[0-9a-f]{6}$/i;

/// Validated BEFORE the value reaches a style attribute: a hand-edited
/// config.json must never be able to inject arbitrary text into CSS.
export function normalizeColor(value: string | null | undefined): string {
  if (typeof value !== "string" || !HEX.test(value.trim())) return DEFAULT_ACCENT;
  return value.trim().toLowerCase();
}

/// Returns an error message, or null when the name is usable. No
/// extension is required: Cursor's legacy .cursorrules has none.
export function validateAgentFileName(name: string): string | null {
  if (!name.trim()) return "Enter a file name.";
  if (name.includes("/") || name.includes("\\")) return "Must be a file name, not a path.";
  return null;
}

export type RenameDecision = "prompt" | "point" | "error";

/// The spec's §6 table, as a function. "prompt" means ask before moving;
/// "point" means just record the new name; "error" means reject.
export function renameDecision(
  oldName: string,
  newName: string,
  oldExists: boolean,
  targetExists: boolean
): RenameDecision {
  if (validateAgentFileName(newName)) return "error";
  if (newName === oldName) return "point";
  if (oldExists && !targetExists) return "prompt";
  return "point";
}

export interface ResolvedAgent {
  profileId: string;
  file: string;
  command: string;
  mcpSupported: boolean;
}

const FALLBACK_PROFILE = "claude-code";

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/// Explicit config beats the profile default beats claude-code's default
/// (spec §4.2). Expressed once so the panel, the hub label, the home tile
/// and the agent-file view can never disagree.
export function resolveAgentConfig(
  config: AgentConfig | null | undefined,
  profiles: AgentProfileInfo[]
): ResolvedAgent {
  const requested = nonEmpty(config?.profile) ?? FALLBACK_PROFILE;
  const profile = profiles.find((p) => p.id === requested);
  const fallback = profiles.find((p) => p.id === FALLBACK_PROFILE);
  const effective = profile ?? fallback;
  return {
    profileId: effective?.id ?? FALLBACK_PROFILE,
    // `custom` carries empty defaults, so an unfilled custom profile still
    // resolves to something openable rather than an empty path.
    file:
      nonEmpty(config?.file) ??
      nonEmpty(effective?.instructionsFile) ??
      nonEmpty(fallback?.instructionsFile) ??
      "CLAUDE.md",
    command:
      nonEmpty(config?.command) ??
      nonEmpty(effective?.command) ??
      nonEmpty(fallback?.command) ??
      "claude",
    mcpSupported: effective?.mcpSupported ?? false,
  };
}
```

- [ ] **Step 5: Run** — green.

- [ ] **Step 6: Write the failing `workspace.ts` tests** (`workspace.test.ts`):

```typescript
describe("hubLabel", () => {
  it("shows the resolved agent file for the agent-file view", () => {
    expect(hubLabel({ id: "agent-file", label: "CLAUDE.md" }, "AGENTS.md")).toBe("AGENTS.md");
  });

  it("leaves every other view's label alone", () => {
    expect(hubLabel({ id: "kanban", label: "Kanban" }, "AGENTS.md")).toBe("Kanban");
  });
});

describe("workspaceIdForSession", () => {
  const tree = (id: string) => ({ type: "leaf" as const, tabs: [id], activeTabIndex: 0 });

  it("finds a session in a page tree", () => {
    const state = {
      workspaces: [
        { id: "ws-1", name: "A", pages: [{ id: "p1", name: "P", layout: tree("s-1") }], activePageId: "p1" },
      ],
    };
    expect(workspaceIdForSession(state as never, "s-1")).toBe("ws-1");
  });

  it("finds a main agent session, which lives outside every page tree", () => {
    const state = {
      workspaces: [{ id: "ws-1", name: "A", pages: [], activePageId: null, mainSessionId: "agent-1" }],
    };
    expect(workspaceIdForSession(state as never, "agent-1")).toBe("ws-1");
  });

  it("returns null for a session that belongs to no workspace", () => {
    const state = { workspaces: [{ id: "ws-1", name: "A", pages: [], activePageId: null }] };
    expect(workspaceIdForSession(state as never, "nope")).toBeNull();
  });
});
```

- [ ] **Step 7: Implement in `workspace.ts`:**

```typescript
/// A hub tab's label. Static for every view except the agent-file one,
/// whose label is the workspace's configured file name. Kept as a
/// resolver rather than widening HubView.label to a function, so
/// HUB_VIEWS stays a plain data table.
export function hubLabel(view: { id: string; label: string }, agentFileName: string): string {
  return view.id === "agent-file" ? agentFileName : view.label;
}

/// Which workspace owns a session: page trees first, then the main agent
/// session, which lives outside every tree by D12. Extracted because
/// handleSessionExited and handleSessionStatusChanged both need it and
/// were about to hold a third copy of the walk.
export function workspaceIdForSession(
  state: { workspaces: Workspace[] },
  sessionId: string
): string | null {
  for (const ws of state.workspaces) {
    if (ws.mainSessionId === sessionId) return ws.id;
    for (const page of ws.pages) {
      if (layout.findLeafPath(page.layout, sessionId)) return ws.id;
    }
  }
  return null;
}
```

> `workspace.ts` may not import `layout` yet — add `import * as layout from "./layout";` if absent, and confirm `findLeafPath` is exported under that name.

Also add to the `Workspace` interface, replacing `agentCommand`:

```typescript
  /// Accent colour; absent means the default. Machine-local (D35).
  color?: string;
  /// Per-workspace notification toggles (D38); absent means on.
  notifyNeedsInput?: boolean;
  notifyFinished?: boolean;
```

- [ ] **Step 8: Run** — `npx vitest run` green; `npx svelte-check` will still fail where `agentCommand` is referenced. Task 5 fixes those.

- [ ] **Step 9: Commit**

```bash
git add app/src/lib && git commit -m "feat(settings): pure colour, agent-file and profile-resolution logic"
```

---

### Task 5: State wiring and per-workspace notifications

**Files:**
- Modify: `app/src/lib/backend.ts`, `app/src/lib/layoutState.ts`, `app/src/lib/notifications.ts`, `app/src/lib/layoutState.test.ts`, `app/src/lib/notifications.test.ts`

**Interfaces:**
- Consumes: `settings.ts` and `workspace.ts` (Task 4); the commands from Tasks 1–2.
- Produces: `setAgentField`, `setWorkspaceColor`, `setNotifyFlag`, `agentProfiles`, `moveAgentFile`, `setRootConfigField`.

- [ ] **Step 1: Add the backend wrappers** (`backend.ts`), matching the file's existing style:

```typescript
export function agentProfiles(): Promise<
  Array<{ id: string; label: string; instructionsFile: string; command: string; mcpSupported: boolean }>
> {
  return invoke("agent_profiles");
}

export function moveAgentFile(rootPath: string, from: string, to: string): Promise<void> {
  return invoke("move_agent_file", { rootPath, from, to });
}

export function setRootConfigField(rootPath: string, key: string, value: string): Promise<void> {
  return invoke("set_root_config_field", { rootPath, key, value });
}
```

- [ ] **Step 2: Add the Tauri relay command** for `set_root_config_field` in `session.rs`, beside `set_plan_frontmatter_field`:

```rust
#[tauri::command]
pub fn set_root_config_field(
    root_path: String,
    key: String,
    value: String,
    state: State<CommandConnection>,
) -> Result<(), String> {
    let resp = send_command(&state.0, &Request::SetRootConfigField { root_path, key, value })
        .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}
```

Register `session::set_root_config_field` in `lib.rs`.

- [ ] **Step 3: Write the failing tests** (`layoutState.test.ts`), adding `setWorkspaceColor` and `setNotifyFlag` to the import list and `setRootConfigField: vi.fn().mockResolvedValue(undefined)` plus `agentProfiles: vi.fn().mockResolvedValue([])` and `moveAgentFile: vi.fn().mockResolvedValue(undefined)` to the `./backend` mock (**resolved**, per Global Constraints):

```typescript
describe("workspace settings", () => {
  it("setWorkspaceColor normalizes and persists", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    await setWorkspaceColor("ws-1", "#A78BFA");
    expect(get(layoutState).workspaces[0].color).toBe("#a78bfa");
    expect(backend.setWorkspacesState).toHaveBeenCalled();
  });

  it("setWorkspaceColor rejects junk by storing the default", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    await setWorkspaceColor("ws-1", "red; background: url(x)");
    expect(get(layoutState).workspaces[0].color).toBe("#4a9eff");
  });

  it("setNotifyFlag flips one toggle without touching the other", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    await setNotifyFlag("ws-1", "notifyFinished", false);
    const w = get(layoutState).workspaces[0];
    expect(w.notifyFinished).toBe(false);
    expect(w.notifyNeedsInput).not.toBe(false);
  });

  it("setAgentField writes config.toml through the daemon, not config.json", async () => {
    setState([{ ...ws("ws-1", []), rootPath: "/tmp/ws" }], "ws-1", null);
    await setAgentField("ws-1", "command", "claude --model opus");
    expect(backend.setRootConfigField).toHaveBeenCalledWith("/tmp/ws", "command", "claude --model opus");
    expect(backend.setWorkspacesState).not.toHaveBeenCalled();
  });

  it("setAgentField does nothing without a root", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    await setAgentField("ws-1", "command", "x");
    expect(backend.setRootConfigField).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Implement in `layoutState.ts`.** Delete `setAgentCommand` entirely and add:

```typescript
/// Agent settings live in config.toml (D35/D41), so this goes through the
/// daemon rather than persistWorkspaces. The value comes back on the next
/// watcher push -- no optimistic local copy to fall out of sync.
export async function setAgentField(
  workspaceId: string,
  key: "profile" | "file" | "command",
  value: string
): Promise<void> {
  const ws = get(layoutState).workspaces.find((w) => w.id === workspaceId);
  if (!ws?.rootPath) return;
  try {
    await backend.setRootConfigField(ws.rootPath, key, value);
  } catch (e) {
    setError(String(e));
  }
}

export async function setWorkspaceColor(workspaceId: string, color: string): Promise<void> {
  const state = get(layoutState);
  const normalized = normalizeColor(color);
  const workspaces = state.workspaces.map((w) => (w.id === workspaceId ? { ...w, color: normalized } : w));
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

export async function setNotifyFlag(
  workspaceId: string,
  key: "notifyNeedsInput" | "notifyFinished",
  value: boolean
): Promise<void> {
  const state = get(layoutState);
  const workspaces = state.workspaces.map((w) => (w.id === workspaceId ? { ...w, [key]: value } : w));
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}
```

Import `normalizeColor` from `./settings` and `workspaceIdForSession` from `./workspace`.

- [ ] **Step 5: Make `startMainAgent` use the resolved command.**

It currently reads `ws.agentCommand ?? DEFAULT_AGENT_COMMAND`. Replace with the resolved value from the gavin tree:

```typescript
  const tree = get(gavinTrees)[workspaceId];
  const rootContext = tree?.contexts.find((c) => c.kind === "root");
  const resolved = resolveAgentConfig(rootContext?.agent ?? null, get(agentProfilesStore));
  sessionId = await backend.createSession(ws.rootPath, resolved.command);
```

Add a small store beside the others, hydrated once at bootstrap:

```typescript
/// The Rust profile table, fetched once. Empty until bootstrap fills it;
/// resolveAgentConfig degrades to its own claude-code fallbacks in that
/// window, so an early call is safe rather than wrong.
export const agentProfilesStore = writable<AgentProfileInfo[]>([]);
```

and in `bootstrap`, after the existing hydration calls:

```typescript
  void backend.agentProfiles().then((p) => agentProfilesStore.set(p)).catch(() => {});
```

Delete `DEFAULT_AGENT_COMMAND` and rewrite the existing test that asserts the `"claude"` fallback so it drives the fallback through `resolveAgentConfig` instead of the deleted constant.

- [ ] **Step 6: Deduplicate the session lookup.** In `handleSessionExited`, replace the inline `mainSessionId` search **and** the page-tree walk with `workspaceIdForSession`, keeping the existing early-return behaviour:

```typescript
export function handleSessionExited(sessionId: string): void {
  const state = get(layoutState);
  const owner = workspaceIdForSession(state, sessionId);
  if (owner && state.workspaces.find((w) => w.id === owner)?.mainSessionId === sessionId) {
    clearMainSession(owner);
    return;
  }
  // ... existing page-tree branch, unchanged
```

- [ ] **Step 7: Write the failing notification test** (`notifications.test.ts`):

```typescript
  it("respects the per-workspace toggles", async () => {
    await __resetForTesting();
    vi.mocked(isPermissionGranted).mockResolvedValue(true);
    vi.mocked(getCurrentWindow).mockReturnValue({ isFocused: async () => false } as never);

    await maybeNotifyStatusChange("s-1", "working", "idle", "zsh", { needsInput: true, finished: false });
    expect(sendNotification).not.toHaveBeenCalled();

    await maybeNotifyStatusChange("s-1", "working", "idle", "zsh", { needsInput: true, finished: true });
    expect(sendNotification).toHaveBeenCalledOnce();

    vi.mocked(sendNotification).mockClear();
    await maybeNotifyStatusChange("s-1", "idle", "waiting_for_input", "zsh", { needsInput: false, finished: true });
    expect(sendNotification).not.toHaveBeenCalled();
  });
```

> Match the existing tests' mock setup in this file — copy their `vi.mock` blocks rather than inventing new ones.

- [ ] **Step 8: Implement.** Give `maybeNotifyStatusChange` a fifth parameter and consult it before anything else:

```typescript
export interface NotifyPrefs {
  needsInput: boolean;
  finished: boolean;
}

export async function maybeNotifyStatusChange(
  sessionId: string,
  previousStatus: SessionStatus | undefined,
  newStatus: SessionStatus,
  label: string,
  prefs: NotifyPrefs
): Promise<void> {
  if (!isNotificationWorthy(previousStatus, newStatus)) return;
  // Per-workspace toggles (D38), checked before permission so a silenced
  // workspace never prompts for OS permission either.
  const enabled = newStatus === "waiting_for_input" ? prefs.needsInput : prefs.finished;
  if (!enabled) return;
  if (await getCurrentWindow().isFocused()) return;
  if (!(await ensurePermission())) return;
  const body = newStatus === "waiting_for_input" ? `${label} needs your input` : `${label} finished`;
  sendNotification({ title: "gavin", body });
}
```

And at the call site in `handleSessionStatusChanged`:

```typescript
  const owner = workspaceIdForSession(state, sessionId);
  const ws = owner ? state.workspaces.find((w) => w.id === owner) : undefined;
  // A session owned by no workspace (spawned but not yet landed) keeps
  // today's behaviour rather than going silent.
  void maybeNotifyStatusChange(sessionId, previousStatus, status, label, {
    needsInput: ws?.notifyNeedsInput ?? true,
    finished: ws?.notifyFinished ?? true,
  });
```

- [ ] **Step 9: Run** — `npx vitest run` green.

- [ ] **Step 10: Commit**

```bash
git add app/src app/src-tauri && git commit -m "feat(settings): agent/colour/notification actions and per-workspace notification toggles"
```

---

### Task 6: The Settings panel and de-hardcoding `CLAUDE.md` (5 sites)

**Files:**
- Create: `app/src/lib/SettingsHubView.svelte`, `app/src/lib/ColourPicker.svelte`
- Modify: `app/src/lib/workspaceViews.ts`, `app/src/routes/+page.svelte`, `app/src/lib/WorkspaceRootControl.svelte`, `app/src/lib/AgentFileHubView.svelte`, `app/src/lib/HomeHubView.svelte`

- [ ] **Step 1: Give the root control a variant.** In `WorkspaceRootControl.svelte`, extend Props:

```svelte
  interface Props {
    workspace: Workspace;
    /// "banner" is the hub-wide strip above every tab; "settings" is the
    /// embedded form row, which drops the banner chrome because the
    /// panel already provides a heading.
    variant?: "banner" | "settings";
  }
  let { workspace, variant = "banner" }: Props = $props();
```

Wrap the outermost element with `class:settings={variant === "settings"}` and add:

```css
  .settings .banner,
  .settings .chip {
    margin: 0;
    border: none;
    background: transparent;
    padding: 0;
  }
```

- [ ] **Step 2: Build `ColourPicker.svelte`:**

```svelte
<script lang="ts">
  import { PALETTE, normalizeColor } from "./settings";

  interface Props {
    value: string;
    onChange: (colour: string) => void;
  }
  let { value, onChange }: Props = $props();

  const current = $derived(normalizeColor(value));
</script>

<div class="picker">
  <div class="swatches">
    {#each PALETTE as colour (colour)}
      <button
        type="button"
        class="swatch"
        class:selected={colour === current}
        style:background={colour}
        aria-label="Use {colour}"
        onclick={() => onChange(colour)}
      ></button>
    {/each}
  </div>
  <label class="custom">
    Custom
    <input type="color" value={current} oninput={(e) => onChange(e.currentTarget.value)} />
  </label>
  <!-- A live preview instead of a contrast floor: a near-black accent is
       the user's call, but they should see it before committing. -->
  <span class="preview" style:background={current}></span>
</div>

<style>
  .picker {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .swatches {
    display: flex;
    gap: 5px;
  }
  .swatch {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 2px solid transparent;
    cursor: pointer;
    padding: 0;
  }
  .swatch.selected {
    border-color: #eee;
  }
  .custom {
    display: flex;
    align-items: center;
    gap: 5px;
    color: #999;
    font-family: monospace;
    font-size: 0.8em;
  }
  .custom input {
    width: 26px;
    height: 20px;
    padding: 0;
    background: transparent;
    border: 1px solid #444;
    border-radius: 4px;
  }
  .preview {
    width: 60px;
    height: 3px;
    border-radius: 2px;
  }
</style>
```

- [ ] **Step 3: Build `SettingsHubView.svelte`:**

```svelte
<script lang="ts">
  import { layoutState, renameWorkspace, setWorkspaceColor, setNotifyFlag, setAgentField, agentProfilesStore } from "./layoutState";
  import { gavinTrees } from "./gavinState";
  import { resolveAgentConfig, validateAgentFileName, renameDecision, DEFAULT_ACCENT } from "./settings";
  import * as backend from "./backend";
  import WorkspaceRootControl from "./WorkspaceRootControl.svelte";
  import ColourPicker from "./ColourPicker.svelte";
  import Modal from "./Modal.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const tree = $derived($gavinTrees[workspaceId]);
  const rootContext = $derived(tree?.contexts.find((c) => c.kind === "root"));
  const agent = $derived(resolveAgentConfig(rootContext?.agent ?? null, $agentProfilesStore));
  const configWarning = $derived(Boolean(rootContext?.configWarning));
  const hasRoot = $derived(Boolean(ws?.rootPath));

  // Drafts exist so a watcher push cannot overwrite a field mid-type
  // (spec §5.2): a focused input keeps its draft, everything else follows
  // the store.
  let nameDraft = $state("");
  let commandDraft = $state("");
  let fileDraft = $state("");
  let focused = $state<string | null>(null);
  let fileError = $state<string | null>(null);
  let pendingMove = $state<{ from: string; to: string } | null>(null);

  $effect(() => {
    if (focused !== "name") nameDraft = ws?.name ?? "";
  });
  $effect(() => {
    if (focused !== "command") commandDraft = agent.command;
  });
  $effect(() => {
    if (focused !== "file") fileDraft = agent.file;
  });

  function commitName(): void {
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== ws?.name) void renameWorkspace(workspaceId, trimmed);
  }

  function commitCommand(): void {
    const trimmed = commandDraft.trim();
    if (trimmed && trimmed !== agent.command) void setAgentField(workspaceId, "command", trimmed);
  }

  async function commitFile(): Promise<void> {
    fileError = null;
    const next = fileDraft.trim();
    const problem = validateAgentFileName(next);
    if (problem) {
      fileError = problem;
      return;
    }
    if (!ws?.rootPath || next === agent.file) return;
    const [oldExists, targetExists] = await Promise.all([
      backend.readFileForViewer(`${ws.rootPath}/${agent.file}`).then((r) => r.exists).catch(() => false),
      backend.readFileForViewer(`${ws.rootPath}/${next}`).then((r) => r.exists).catch(() => false),
    ]);
    const decision = renameDecision(agent.file, next, oldExists, targetExists);
    if (decision === "error") {
      fileError = "That file name can't be used.";
      return;
    }
    if (decision === "prompt") {
      pendingMove = { from: agent.file, to: next };
      return;
    }
    await setAgentField(workspaceId, "file", next);
  }

  async function confirmMove(move: boolean): Promise<void> {
    const pending = pendingMove;
    pendingMove = null;
    if (!pending || !ws?.rootPath) return;
    if (move) {
      try {
        await backend.moveAgentFile(ws.rootPath, pending.from, pending.to);
      } catch (e) {
        fileError = String(e);
        return;
      }
    }
    await setAgentField(workspaceId, "file", pending.to);
  }

  async function changeProfile(id: string): Promise<void> {
    await setAgentField(workspaceId, "profile", id);
  }
</script>

{#if ws}
  <div class="settings">
    <section>
      <h3>Workspace</h3>
      <label class="row">
        <span>Name</span>
        <input
          bind:value={nameDraft}
          onfocus={() => (focused = "name")}
          onblur={() => { focused = null; commitName(); }}
          onkeydown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        />
      </label>
      <div class="row">
        <span>Colour</span>
        <ColourPicker value={ws.color ?? DEFAULT_ACCENT} onChange={(c) => void setWorkspaceColor(workspaceId, c)} />
      </div>
      <div class="row">
        <span>Root</span>
        <WorkspaceRootControl workspace={ws} variant="settings" />
      </div>
    </section>

    <section>
      <h3>Notifications</h3>
      <label class="check">
        <input
          type="checkbox"
          checked={ws.notifyNeedsInput ?? true}
          onchange={(e) => void setNotifyFlag(workspaceId, "notifyNeedsInput", e.currentTarget.checked)}
        />
        When a session needs my input
      </label>
      <label class="check">
        <input
          type="checkbox"
          checked={ws.notifyFinished ?? true}
          onchange={(e) => void setNotifyFlag(workspaceId, "notifyFinished", e.currentTarget.checked)}
        />
        When a session finishes working
      </label>
      <p class="hint">Never shown while the gavin window is focused.</p>
    </section>

    <section>
      <h3>Agent</h3>
      {#if !hasRoot}
        <p class="hint">Bind a root folder to configure the agent.</p>
      {:else if configWarning}
        <p class="hint warn">This root's config.toml can't be parsed — fix it to edit these settings.</p>
      {:else}
        <label class="row">
          <span>Profile</span>
          <select value={agent.profileId} onchange={(e) => void changeProfile(e.currentTarget.value)}>
            {#each $agentProfilesStore as profile (profile.id)}
              <option value={profile.id}>{profile.label}</option>
            {/each}
          </select>
        </label>
        <label class="row">
          <span>Command</span>
          <input
            bind:value={commandDraft}
            spellcheck="false"
            onfocus={() => (focused = "command")}
            onblur={() => { focused = null; commitCommand(); }}
            onkeydown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          />
        </label>
        <label class="row">
          <span>Agent file</span>
          <input
            bind:value={fileDraft}
            spellcheck="false"
            onfocus={() => (focused = "file")}
            onblur={() => { focused = null; void commitFile(); }}
            onkeydown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          />
        </label>
        {#if fileError}
          <p class="hint warn">{fileError}</p>
        {/if}
        {#if agent.mcpSupported}
          <p class="hint">MCP integration is available for this profile — set it up from any hub tab's banner.</p>
        {:else}
          <p class="hint">
            MCP integration isn't available for
            {$agentProfilesStore.find((p) => p.id === agent.profileId)?.label ?? agent.profileId} yet.
          </p>
        {/if}
      {/if}
    </section>
  </div>

  {#if pendingMove}
    <Modal title="Move {pendingMove.from}?">
      <p>
        Move <code>{pendingMove.from}</code> to <code>{pendingMove.to}</code>, or point gavin at
        <code>{pendingMove.to}</code> and leave the old file where it is?
      </p>
      <div class="actions">
        <button type="button" onclick={() => void confirmMove(false)}>Leave it</button>
        <button type="button" onclick={() => void confirmMove(true)}>Move file</button>
      </div>
    </Modal>
  {/if}
{/if}

<style>
  .settings {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 22px;
    overflow-y: auto;
    height: 100%;
    box-sizing: border-box;
    color: #ccc;
    font-family: monospace;
    font-size: 0.85em;
  }
  h3 {
    margin: 0 0 10px;
    color: #999;
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: normal;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }
  .row > span:first-child {
    width: 90px;
    flex: 0 0 auto;
    color: #999;
  }
  .row input,
  .row select {
    background: #1e1e1e;
    border: 1px solid #444;
    border-radius: 4px;
    color: #eee;
    font-family: monospace;
    font-size: 1em;
    padding: 3px 8px;
    min-width: 240px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .hint {
    color: #777;
    margin: 6px 0 0;
  }
  .hint.warn {
    color: #e0b08a;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 12px;
  }
  .actions button {
    background: #3a3a3a;
    border: none;
    color: #eee;
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
</style>
```

> Check `Modal.svelte`'s actual props before using it — if it takes something other than `title`, or expects a `{#snippet}`, follow the file. `PlanDetailModal.svelte` is a working example.

- [ ] **Step 4: Register the view.** In `workspaceViews.ts`, import `Settings` from `@lucide/svelte` (verify `settings.svelte` exists in `app/node_modules/@lucide/svelte/dist/icons/` first — a wrong icon name fails the build) and `SettingsHubView`, then append **last**:

```typescript
  {
    id: "settings",
    label: "Settings",
    icon: Settings,
    component: SettingsHubView,
  },
```

No `requiresRoot` — it must work unrooted.

- [ ] **Step 5: De-hardcode the five sites.**

`+page.svelte` — resolve once and use it for both the label and the banner gating:

```svelte
  const settingsTree = $derived($gavinTrees[activeWorkspace?.id ?? ""]);
  const settingsAgent = $derived(
    resolveAgentConfig(settingsTree?.contexts.find((c) => c.kind === "root")?.agent ?? null, $agentProfilesStore)
  );
```

Replace `{view.label}` with `{hubLabel(view, settingsAgent.file)}`, and wrap the root control so it does not double up on its own tab:

```svelte
          {#if activeView !== "settings"}
            <WorkspaceRootControl workspace={activeWorkspace} />
          {/if}
```

`AgentFileHubView.svelte` — delete the "hardcoded rather than read from config" comment and derive the path:

```svelte
  const tree = $derived($gavinTrees[workspaceId]);
  const agent = $derived(
    resolveAgentConfig(tree?.contexts.find((c) => c.kind === "root")?.agent ?? null, $agentProfilesStore)
  );
  const path = $derived(root ? `${root}/${agent.file}` : null);
```

`HomeHubView.svelte` — same derivation; use `${r}/${agent.file}` for the probe and `{agent.file}` for the tile's `<b>`.

`WorkspaceRootControl.svelte` — **the fifth site.** Line ~120 reads
"Agent integration — write .mcp.json, the gavin skill, and a CLAUDE.md
pointer into this root", and the row renders whenever a root is bound,
regardless of profile. Offering it for a profile whose
`setup_agent_integration` now returns an error is a broken button. Derive
the same `agent` value and gate the whole row:

```svelte
  {#if workspace.rootPath && !rootMissing && agent.mcpSupported}
    <div class="banner">
      <span>Agent integration — write {mcpFiles}, the gavin skill, and a {agent.file} pointer into this root.</span>
      ...
```

with

```svelte
  const agent = $derived(
    resolveAgentConfig(tree?.contexts.find((c) => c.kind === "root")?.agent ?? null, $agentProfilesStore)
  );
  // Only claude-code has an McpLayout in this sub-project, so naming its
  // file directly is honest rather than speculative; sub-project B makes
  // this follow the profile.
  const mcpFiles = ".mcp.json";
```

> `tree` is already derived in this component as `$gavinTrees[workspace.id]` — reuse it rather than adding a second.

- [ ] **Step 6: Verify** — `npx svelte-check` 0 errors, `npx vitest run` green, `npm run build` succeeds.

- [ ] **Step 7: Commit**

```bash
git add app/src && git commit -m "feat(settings): Settings hub tab and configurable agent file name"
```

---

### Task 7: Colour plumbing, checklist, full gates

**Files:**
- Modify: `app/src/lib/Pane.svelte`, `app/src/lib/Sidebar.svelte`, `app/src/routes/+page.svelte`, `app/src/lib/smokeChecklist.ts`

- [ ] **Step 1: Make the indicators read the variable.** In `Pane.svelte`, change the three hardcoded `#4a9eff` occurrences:

```css
  .tab.focused {
    border-top-color: var(--ws-accent, #4a9eff);
  }
  .tab.drop-before {
    box-shadow: inset 2px 0 0 0 var(--ws-accent, #4a9eff);
  }
  .tab.drop-after {
    box-shadow: inset -2px 0 0 0 var(--ws-accent, #4a9eff);
  }
```

- [ ] **Step 2: Set it for the active workspace.** In `+page.svelte`, on the element wrapping the workspace's content (the same one holding the hub nav and `.view`):

```svelte
  style:--ws-accent={normalizeColor(activeWorkspace.color)}
```

importing `normalizeColor` from `$lib/settings`.

- [ ] **Step 3: Add the sidebar stripe.** In `Sidebar.svelte`, add to **both** `.workspace-row` sites (the pinned Unfiled row and the regular list row):

```svelte
          style:--ws-accent={normalizeColor(ws.color)}
```

and the style:

```css
  .workspace-row {
    border-left: 3px solid var(--ws-accent, transparent);
  }
```

> Read the existing `.workspace-row` rule first: if it already has a `border-left` or a left padding that this would shift, adjust that rule rather than stacking a second border.

- [ ] **Step 4: Add the checklist section** in `smokeChecklist.ts`, after "Orchestration home":

```typescript
  {
    title: "Workspace settings",
    items: [
      { id: "set-tab", text: "A Settings tab appears for every workspace, including one with no root bound" },
      { id: "set-name", text: "Renaming here updates the sidebar immediately and survives a restart" },
      {
        id: "set-colour",
        text: "Picking a palette colour tints the focused tab's top border and the sidebar stripe; a custom colour works too",
      },
      { id: "set-colour-preview", text: "The preview swatch shows the chosen colour before you look at the tabs" },
      { id: "set-root", text: "The embedded root control binds a folder, and no duplicate banner shows on the Settings tab" },
      {
        id: "set-notify",
        text: "Unticking “finished” silences that notification while “needs input” still fires",
        hint: "Unfocus the window; run a long command, then something needing input.",
      },
      { id: "set-profile", text: "Switching profile updates the CLAUDE.md tab's label and the home tile to the new file name" },
      {
        id: "set-rename-move",
        text: "Changing the agent file with the old one present prompts; Move renames it on disk with content intact",
      },
      {
        id: "set-rename-point",
        text: "When the target already exists, no move is offered and the old file is left alone",
      },
      { id: "set-rename-invalid", text: "A name with a slash, or an empty one, shows an inline error and changes nothing" },
      { id: "set-command", text: "Editing the command writes .gavin-root/config.toml and the next Start uses it" },
      {
        id: "set-external",
        text: "Editing config.toml in a terminal updates the panel (~3s); a field you're typing in is NOT clobbered",
        hint: "Focus the Command field, type, then edit config.toml externally.",
      },
      { id: "set-mcp-gated", text: "A non-Claude profile says MCP integration isn't available yet, with no button" },
      { id: "set-unparseable", text: "Corrupting config.toml makes the agent fields read-only rather than overwriting it" },
    ],
  },
```

- [ ] **Step 5: Full gates.**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cargo test
cd app && npx vitest run && npx svelte-check && npm run build
```

All must be clean: `svelte-check` 0 errors, build succeeding.

- [ ] **Step 6: Stale-daemon check.** This bumps `PROTOCOL_VERSION`, so a running daemon from before this work will now be rejected by the handshake. Before any manual pass: `pkill gavin-daemon`, then relaunch. Confirm the app starts without the version overlay.

- [ ] **Step 7: Manual smoke** — run the new section in the dev Smoke Test workspace. `set-rename-move` and `set-external` are the two that matter most: the first is the only path that mutates a user's file, and the second is the draft-preservation rule that has no automated coverage.

- [ ] **Step 8: Commit**

```bash
git add app/src && git commit -m "feat(settings): workspace colour on tab indicators and sidebar, plus smoke checklist"
```

---

## Testing summary

- **Rust:** 2 protocol shape/round-trip tests plus the renamed version pin; 6 daemon tests (agent block on root only, absent block, allow-list, comment preservation, table creation, unparseable refusal); 4 `agent_setup` tests (table integrity, MCP gating, move + refusal, traversal); 2 config tests; 2 migration tests.
- **TypeScript:** ~20 `settings.ts` cases (colour, file name, rename table, resolution); 5 `workspace.ts` cases (`hubLabel`, `workspaceIdForSession`); 5 `layoutState` cases; 1 notifications case.
- **Components — manual only.** `SettingsHubView`, `ColourPicker`, the rename modal, the colour reaching the tab indicator and sidebar, and the draft-preservation rule are covered by the 14-item "Workspace settings" checklist section. vitest here cannot preprocess `.svelte`, so there is no automated alternative.

## Out of scope

MCP writers for Codex/Gemini/Cursor/opencode (sub-project B, which also decides what replaces `.claude/skills/gavin/SKILL.md` for agents with no native skill mechanism, and adds a custom MCP config path). Global cross-workspace settings. Theming beyond the accent colour.
