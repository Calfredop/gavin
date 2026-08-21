# Workspace Init Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a creation modal for folder and fundamentals, then a four-step wizard (Agent → Integration → PRD → Launch) whose progress is derived from disk, with the document steps able to hand the writing to the agent.

**Architecture:** nothing about setup is stored — `setupProgress()` reads four signals off disk and recomputes where you are, so a step done by hand already counts. `setup_agent_integration` splits so it writes the agent-file block for every profile instead of erroring for the four without an MCP layout. Agent-driven authoring is backed by authored skill documents, delivered as real skill files where the profile has a skill mechanism and inlined into the spawn prompt where it does not.

**Tech Stack:** Rust (Tauri app crate), Svelte 5 runes, vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-08-21-workspace-init-wizard-design.md` (W1–W6).

## ⚠ Conflict to resolve before Task 5

**D56 was added to the workspace-settings spec on 2026-08-21, after this
wizard's spec was approved.** It reads: *"Settings owns every
folder-picking and integration action; the hub folder bar is read-only."*
The ⚙ picker, "Set root…"/"Re-pick…" and the "Agent integration" row now
render **only** in `WorkspaceRootControl`'s `settings` variant.

This wizard needs both a folder picker (§4) and the integration action
(§5.2), which makes it a second owner of actions D56 assigns solely to
Settings. Embedding the `settings` variant satisfies D56's letter but not
its intent.

**Do not resolve this by guessing.** Ask the human partner which governs
before starting Task 5. The recommended amendment: D56 becomes *"Settings
and the init wizard own every folder-picking and integration action"* —
the wizard is a setup flow, which is the same job D37 gave Settings when
it made the panel work unrooted. Tasks 1–4 are unaffected and can proceed
either way.

## Global Constraints

- Work directly on `main`. No worktree — standing user preference.
- Inline Execution is the standing choice. Push only when the user asks.
- **The daemon crate's cargo package name is `gavin-daemon`, not `daemon`.** `cargo test -p daemon` fails with "package ID specification did not match any packages".
- **NO Svelte component tests.** vitest here cannot preprocess `.svelte`; a test that merely *imports* a component fails at collection. All testable logic goes in pure `.ts` modules; components are covered by the manual checklist only.
- In vitest, any backend mock whose result gets `.catch()`ed must be `vi.fn().mockResolvedValue(undefined)`. A bare `vi.fn()` returns `undefined` and throws on `.catch()` — this has bitten three times here.
- **Rewrite, never delete,** a pre-existing test that encodes a contract this work changes. Task 1 has one: `setup_refuses_a_profile_with_no_mcp_layout` asserts exactly the behaviour W4 reverses.
- `#[tauri::command]` must sit **immediately** above its `fn`; a stranded attribute fails with "expected `fn`" and cascades into confusing E0433s. Register every new command in `app/src-tauri/src/lib.rs`'s `invoke_handler`.
- Use the compiler as the backstop for struct-literal changes, never a regex.

## Verified groundwork

Checked against the code before writing this plan — do not re-derive:

- `setup_agent_integration(root_path: String) -> Result<Vec<String>, String>` has exactly **one** frontend caller: `WorkspaceRootControl.svelte:98`, which does `files.map((f) => f.replace(...)).join(", ")`. Changing the return type breaks it; Task 1 fixes it in the same commit.
- Its current body takes `let Some(layout) = profile.mcp.as_ref() else { return Err(...) }` — the early return that writes *nothing* for four of six profiles.
- `write_instructions_block(root: &Path, instructions_file: &str)` already takes the filename as a `&str` (not a profile), so only the **block content** needs to become a parameter.
- `write_mcp_config(root, layout: &McpLayout, binary)` and `write_skill(root, layout: &McpLayout)` already take a layout — their signatures do **not** change.
- Existing tests calling the writers use a `claude_layout()` helper that reaches through `profile_by_id("claude-code").mcp`. Only the ones touching `write_instructions_block` and `setup_agent_integration` need updating.
- `Modal.svelte`'s props are `{ onClose, children }` — **there is no `title` prop**. Put the heading in the children.
- The spawn precedent is `backend.createSession(cwd, command)` then `handleAgentSessionSpawned(...)`, with `command = buildRunCommand(agentCommand, prompt)` = `` `${agentCommand} ${shellQuote(prompt)}` ``. But the wizard's agent must be the **main** agent (spec §7.3 says the conversation continues in the Home tab's panel), so Task 4 adds a `startMainAgent`-shaped action rather than reusing `runCard`'s Agents-page landing.
- `PRD_TEMPLATE`'s three placeholder lines, verbatim: `_What are we building, for whom, and why?_`, `_The active goals, roughly ordered._`, `_Explicit non-goals._`.
- `HomeHubView.svelte` already has a variable named `agent` (the `MainAgentPanel` `bind:this` handle); its agent-config value is called `agentCfg`. Follow that.
- `Sidebar.svelte` creates workspaces via `commitNewWorkspace()` → `createWorkspace(trimmed)`, gated on `creatingWorkspace` / `newWorkspaceName`.

---

## File Structure

**Create**
- `app/src-tauri/src/gavin_prd_skill.md` — teaches an agent to interview the owner and write `PRD.md`.
- `app/src-tauri/src/gavin_agent_file_skill.md` — teaches an agent to write the instructions file without touching the marker block.
- `app/src/lib/setupWizard.ts` — pure: progress derivation, PRD section application, the agent-flow gate.
- `app/src/lib/setupWizard.test.ts`
- `app/src/lib/WorkspaceCreateModal.svelte` — folder + name + colour.
- `app/src/lib/SetupWizard.svelte` — the four-step shell.
- `app/src/lib/wizardSteps/AgentStep.svelte`, `IntegrationStep.svelte`, `PrdStep.svelte`, `LaunchStep.svelte`

**Modify**
- `app/src-tauri/src/agent_setup.rs` — `prompt_arg`, `IntegrationResult`, block variants, step-skill delivery, `compose_agent_prompt`.
- `app/src-tauri/src/lib.rs` — register new commands.
- `app/src/lib/backend.ts`, `layoutState.ts`, `Sidebar.svelte`, `WorkspaceRootControl.svelte`, `HomeHubView.svelte`, `smokeChecklist.ts`

---

### Task 1: Split `setup_agent_integration`

**Files:**
- Modify: `app/src-tauri/src/agent_setup.rs`, `app/src/lib/backend.ts`, `app/src/lib/WorkspaceRootControl.svelte`

**Interfaces:**
- Produces: `AgentProfile.prompt_arg: bool`; `IntegrationResult { written: Vec<String>, skipped: Vec<(String, String)> }`; `setup_agent_integration(root_path) -> Result<IntegrationResult, String>`.

- [ ] **Step 1: Write the failing tests** in `agent_setup.rs`'s test module:

```rust
    #[test]
    fn integration_writes_the_block_for_a_profile_with_no_mcp_layout() {
        let dir = tempfile::tempdir().unwrap();
        let g = dir.path().join(".gavin-root");
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(g.join("config.toml"), "[agent]\nprofile = \"codex\"\n").unwrap();

        let result = setup_agent_integration(dir.path().to_string_lossy().to_string()).unwrap();

        // The agent file IS written, which is the whole point of W4.
        assert!(dir.path().join("AGENTS.md").is_file());
        assert!(result.written.iter().any(|w| w.ends_with("AGENTS.md")));
        // ...and the two it cannot do are named, with reasons.
        let skipped: Vec<&str> = result.skipped.iter().map(|(what, _)| what.as_str()).collect();
        assert_eq!(skipped, ["skill file", "MCP config"]);
        for (_, why) in &result.skipped {
            assert!(why.contains("Codex CLI"), "the reason names the profile: {why}");
        }
    }

    #[test]
    fn a_profile_without_a_skill_mechanism_gets_the_guidance_inline() {
        let dir = tempfile::tempdir().unwrap();
        let g = dir.path().join(".gavin-root");
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(g.join("config.toml"), "[agent]\nprofile = \"codex\"\n").unwrap();

        setup_agent_integration(dir.path().to_string_lossy().to_string()).unwrap();

        let body = std::fs::read_to_string(dir.path().join("AGENTS.md")).unwrap();
        assert!(body.contains(MARKER_START) && body.contains(MARKER_END));
        assert!(!body.contains("SKILL.md"), "no skill file exists to point at");
        assert!(body.contains("`.gavin-root/plans/`"), "the guidance is inline instead");
    }

    #[test]
    fn claude_code_still_gets_all_three_and_points_at_its_skill() {
        let dir = tempfile::tempdir().unwrap();
        let g = dir.path().join(".gavin-root");
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(g.join("config.toml"), "[agent]\nprofile = \"claude-code\"\n").unwrap();

        // resolve_mcp_binary_path needs the binary beside current_exe, which
        // is not true under cargo test -- so assert on what does not need it.
        let block = instructions_block_for(profile_by_id("claude-code"));
        assert!(block.contains(".claude/skills/gavin/SKILL.md"));
        assert!(profile_by_id("claude-code").mcp.is_some());
    }

    #[test]
    fn prompt_arg_is_set_only_where_the_convention_is_verified() {
        let with_prompt: Vec<&str> =
            AGENT_PROFILES.iter().filter(|p| p.prompt_arg).map(|p| p.id).collect();
        assert_eq!(with_prompt, ["claude-code"]);
    }
```

- [ ] **Step 2: Rewrite the test that encodes the old contract.**

`setup_refuses_a_profile_with_no_mcp_layout` asserts `setup_agent_integration(...)` returns `Err` naming "Codex CLI". That is exactly what W4 reverses. **Rewrite it, do not delete it** — the surviving rule is that a *missing root* still errors:

```rust
    // Was setup_refuses_a_profile_with_no_mcp_layout: a profile without an
    // MCP layout now degrades (see the tests above) rather than refusing.
    // The surviving refusal is a root that is not there at all.
    #[test]
    fn setup_refuses_a_root_that_does_not_exist() {
        let err = setup_agent_integration("/no/such/root".to_string()).unwrap_err();
        assert!(err.contains("root does not exist"), "got: {err}");
    }
```

- [ ] **Step 3: Run — expect failure.**

Run: `cargo test -p app agent_setup`
Expected: FAIL — `IntegrationResult` not found, `prompt_arg` no field, `instructions_block_for` not found.

- [ ] **Step 4: Add `prompt_arg` to the profile table.**

Add the field to `AgentProfile`:

```rust
    /// Whether this agent accepts a positional prompt argument, i.e.
    /// `<command> "<prompt>"`. Only true where the convention is
    /// verified: getting it wrong puts garbage in the agent's argv, so
    /// agent-driven flows are hidden rather than risked (spec §7.2).
    pub prompt_arg: bool,
```

Then run `cargo build -p app` and add `prompt_arg: <value>` to each of the **six** rows the compiler names — `true` for `claude-code`, `false` for `codex`, `gemini`, `cursor`, `opencode`, `custom`. Let E0063 find them; do not regex.

Add `pub prompt_arg: bool` to `AgentProfileDto` and `prompt_arg: p.prompt_arg` to the mapping in `agent_profiles()`.

- [ ] **Step 5: Two block variants from one source.**

Replace the single `CLAUDE_MD_BLOCK` const with a selector. Keep the existing constant's text as the pointer variant so claude-code's output is byte-identical to today:

```rust
/// Pointer variant: for profiles with a skill mechanism, the block stays
/// short and defers to the skill file.
const BLOCK_WITH_SKILL: &str = "## Gavin workspace\n\n\
This repo is a gavin workspace. Read `.gavin-root/PRD.md` first — it leads all\n\
development. Follow the gavin workflow skill in `.claude/skills/gavin/SKILL.md`\n\
(plan before coding, keep plan statuses current, use the gavin_* MCP tools).\n";

/// Inline variant: for agents with no skill mechanism, the same guidance
/// has to live in the block itself -- there is no file to point at.
const BLOCK_INLINE: &str = "## Gavin workspace\n\n\
This repo is a gavin workspace. Read `.gavin-root/PRD.md` first — it leads all\n\
development.\n\n\
- Plans are markdown files in `.gavin-root/plans/` (and any `.gavin/plans/`).\n\
  Their frontmatter drives a kanban board the human watches: `status:` is the\n\
  column, `priority:` the dot, `kind:` one of note/task/plan.\n\
- Plan before coding. Create a plan file, keep its `status:` current as you\n\
  work, and never mark work done that you have not verified.\n\
- The files are the truth. Edit them directly; the board follows.\n";

fn instructions_block_for(profile: &AgentProfile) -> &'static str {
    if profile.mcp.is_some() { BLOCK_WITH_SKILL } else { BLOCK_INLINE }
}
```

Change `write_instructions_block` to take the block:

```rust
fn write_instructions_block(
    root: &Path,
    instructions_file: &str,
    block_body: &str,
) -> anyhow::Result<PathBuf> {
    let path = root.join(instructions_file);
    let block = format!("{MARKER_START}\n{block_body}{MARKER_END}\n");
```

…leaving the rest of that function exactly as it is. Update its existing test `instructions_block_appends_replaces_and_never_touches_the_rest` to pass `BLOCK_WITH_SKILL` as the third argument — its assertions stay valid.

- [ ] **Step 6: Split the command.**

```rust
/// What a setup run wrote, and what it could not. Rendered verbatim by
/// the wizard's Integration step: a profile with no McpLayout still gets
/// its instructions block, and the two omissions are named with reasons
/// rather than failing the whole run (W4).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationResult {
    pub written: Vec<String>,
    pub skipped: Vec<(String, String)>,
}

#[tauri::command]
pub fn setup_agent_integration(root_path: String) -> Result<IntegrationResult, String> {
    let root = Path::new(&root_path);
    if !root.is_dir() {
        return Err(format!("root does not exist: {root_path}"));
    }
    let profile = profile_by_id(&read_profile_id(root));
    let instructions_file = resolved_instructions_file(root, profile);
    let mut written = Vec::new();
    let mut skipped = Vec::new();

    // Written for EVERY profile -- the change W4 makes.
    written.push(
        write_instructions_block(root, &instructions_file, instructions_block_for(profile))
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string(),
    );

    match profile.mcp.as_ref() {
        Some(layout) => {
            let binary = resolve_mcp_binary_path().map_err(|e| e.to_string())?;
            written.push(
                write_skill(root, layout).map_err(|e| e.to_string())?.to_string_lossy().to_string(),
            );
            written.push(
                write_mcp_config(root, layout, &binary)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .to_string(),
            );
        }
        None => {
            skipped.push((
                "skill file".to_string(),
                format!(
                    "{} has no skill mechanism — the guidance is inline in {instructions_file}",
                    profile.label
                ),
            ));
            skipped.push((
                "MCP config".to_string(),
                format!("not available for {} yet", profile.label),
            ));
        }
    }
    Ok(IntegrationResult { written, skipped })
}
```

- [ ] **Step 7: Fix the one frontend caller.**

`backend.ts`:

```typescript
export interface IntegrationResult {
  written: string[];
  skipped: Array<[string, string]>;
}

export function setupAgentIntegration(rootPath: string): Promise<IntegrationResult> {
  return invoke("setup_agent_integration", { rootPath });
}
```

`WorkspaceRootControl.svelte`'s `setupIntegration` currently does
`files.map((f) => f.replace(...)).join(", ")`. Change to:

```typescript
      const result = await backend.setupAgentIntegration(workspace.rootPath);
      const wrote = result.written.map((f) => f.replace(workspace.rootPath + "/", "")).join(", ");
      const missed = result.skipped.map(([what]) => what).join(", ");
      setupNote = missed
        ? `Wrote: ${wrote}. Skipped: ${missed} — re-run any time to update.`
        : `Wrote: ${wrote} — re-run any time to update.`;
```

- [ ] **Step 8: Run** — `cargo test -p app` green, `npx svelte-check` 0 errors.

- [ ] **Step 9: Commit**

```bash
git add app && git commit -m "feat(wizard): integration degrades honestly instead of refusing"
```

---

### Task 2: Step skills and prompt composition

**Files:**
- Create: `app/src-tauri/src/gavin_prd_skill.md`, `app/src-tauri/src/gavin_agent_file_skill.md`
- Modify: `app/src-tauri/src/agent_setup.rs`, `app/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `AgentProfile`, `profile_by_id`, `read_profile_id`, `resolved_instructions_file` (Task 1).
- Produces: `compose_agent_prompt(root_path: String, flow: String) -> Result<String, String>` where `flow` is `"prd"` or `"agent-file"`.

- [ ] **Step 1: Write `gavin_prd_skill.md`**, matching `gavin_skill.md`'s frontmatter format:

```markdown
---
name: gavin-write-prd
description: Use when the owner asks you to write or revise this workspace's PRD — interview them, then write .gavin-root/PRD.md.
---

# Writing this workspace's PRD

`.gavin-root/PRD.md` is the lead document for this repo. Every plan should
trace back to a line in it, so it has to say what is actually being built —
not what sounds good.

## How to do it

1. **Read the repo first.** README, package manifests, the largest source
   directories. Form your own view of what this project is before asking.
2. **Interview the owner.** Ask one question at a time. Start with what the
   project is for and who uses it; then what the current push is; then what
   they have deliberately decided *not* to do.
3. **Write the file**, keeping its existing headings exactly:
   `## Vision`, `## Current focus`, `## Out of scope`. Replace the italic
   placeholder under each heading with real prose.
4. **Show them the diff** and let them correct it.

## Rules

- Never invent scope. If they have not decided something, ask — or leave the
  placeholder in place.
- Keep it short. A PRD nobody rereads is worthless; aim for one screen.
- Do not restructure the file. The three headings are what gavin's home
  screen reads.
```

- [ ] **Step 2: Write `gavin_agent_file_skill.md`:**

```markdown
---
name: gavin-write-agent-file
description: Use when the owner asks you to write this repo's agent instructions file (CLAUDE.md, AGENTS.md, or whatever it is configured as).
---

# Writing this repo's agent instructions file

This file is what every agent reads before working here. It should carry
what is not obvious from the code: how to build and test, the conventions
that are load-bearing, and the traps.

## How to do it

1. **Read the repo.** Build files, test config, CI, the existing README.
   Run the test command once to confirm it actually works.
2. **Write the file** with: the build/test/lint commands; the architecture
   in a few sentences; conventions a newcomer would otherwise violate.
3. **Show the owner the diff.**

## Rules

- **Never touch anything between `<!-- gavin:start -->` and
  `<!-- gavin:end -->`.** That block is gavin's, rewritten on every setup
  run, and your edits there will be lost.
- Do not restate what the code already makes obvious.
- Do not include secrets, tokens, or anything machine-specific.
```

- [ ] **Step 3: Write the failing tests:**

```rust
    #[test]
    fn compose_prompt_invokes_the_skill_by_name_for_a_skill_capable_profile() {
        let dir = tempfile::tempdir().unwrap();
        let g = dir.path().join(".gavin-root");
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(g.join("config.toml"), "[agent]\nprofile = \"claude-code\"\n").unwrap();

        let prompt =
            compose_agent_prompt(dir.path().to_string_lossy().to_string(), "prd".to_string())
                .unwrap();

        assert!(prompt.contains("gavin-write-prd"), "invokes the skill by name");
        assert!(prompt.len() < 400, "a skill-capable profile gets a short prompt, not the doc");
        // The skill file is installed so the agent can find it.
        assert!(dir.path().join(".claude/skills/gavin-write-prd/SKILL.md").is_file());
    }

    #[test]
    fn compose_prompt_inlines_the_document_when_there_is_no_skill_mechanism() {
        let dir = tempfile::tempdir().unwrap();
        let g = dir.path().join(".gavin-root");
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(g.join("config.toml"), "[agent]\nprofile = \"codex\"\n").unwrap();

        let prompt =
            compose_agent_prompt(dir.path().to_string_lossy().to_string(), "prd".to_string())
                .unwrap();

        assert!(prompt.contains("## Vision"), "the guidance itself is in the prompt");
        assert!(!dir.path().join(".claude").exists(), "no skill dir for a profile without one");
    }

    #[test]
    fn compose_prompt_names_the_configured_agent_file_for_the_agent_file_flow() {
        let dir = tempfile::tempdir().unwrap();
        let g = dir.path().join(".gavin-root");
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(
            g.join("config.toml"),
            "[agent]\nprofile = \"claude-code\"\nfile = \"NOTES.md\"\n",
        )
        .unwrap();

        let prompt =
            compose_agent_prompt(dir.path().to_string_lossy().to_string(), "agent-file".to_string())
                .unwrap();

        assert!(prompt.contains("NOTES.md"), "the prompt names the configured file");
    }

    #[test]
    fn compose_prompt_rejects_an_unknown_flow() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".gavin-root")).unwrap();
        assert!(compose_agent_prompt(
            dir.path().to_string_lossy().to_string(),
            "not-a-flow".to_string()
        )
        .is_err());
    }
```

- [ ] **Step 4: Run — expect failure.** `cargo test -p app agent_setup` → `compose_agent_prompt` not found.

- [ ] **Step 5: Implement.**

```rust
const PRD_SKILL_MD: &str = include_str!("gavin_prd_skill.md");
const AGENT_FILE_SKILL_MD: &str = include_str!("gavin_agent_file_skill.md");

/// One authored document per agent-driven flow (W6), delivered two ways:
/// installed as a real skill where the profile has a skill mechanism, and
/// inlined into the prompt where it does not. One source either way.
struct StepSkill {
    /// Directory name under the profile's skill root, and the name the
    /// prompt invokes.
    name: &'static str,
    document: &'static str,
}

fn step_skill(flow: &str) -> Option<StepSkill> {
    match flow {
        "prd" => Some(StepSkill { name: "gavin-write-prd", document: PRD_SKILL_MD }),
        "agent-file" => {
            Some(StepSkill { name: "gavin-write-agent-file", document: AGENT_FILE_SKILL_MD })
        }
        _ => None,
    }
}

/// Installs the flow's skill (when the profile supports skills) and
/// returns the prompt that starts the agent on it. Called by the wizard's
/// "ask the agent" choice; the caller wraps it with buildRunCommand.
#[tauri::command]
pub fn compose_agent_prompt(root_path: String, flow: String) -> Result<String, String> {
    let root = Path::new(&root_path);
    if !root.is_dir() {
        return Err(format!("root does not exist: {root_path}"));
    }
    let skill = step_skill(&flow).ok_or_else(|| format!("unknown flow: {flow}"))?;
    let profile = profile_by_id(&read_profile_id(root));
    let instructions_file = resolved_instructions_file(root, profile);
    let target = match flow.as_str() {
        "prd" => ".gavin-root/PRD.md".to_string(),
        _ => instructions_file,
    };

    match profile.mcp.as_ref() {
        Some(layout) => {
            // The skill dir sits beside the main gavin skill: same parent,
            // one directory per skill, matching the profile's layout.
            let parent = Path::new(layout.skill_dir)
                .parent()
                .ok_or_else(|| "profile skill_dir has no parent".to_string())?;
            let dir = root.join(parent).join(skill.name);
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            std::fs::write(dir.join(layout.skill_file), skill.document)
                .map_err(|e| e.to_string())?;
            Ok(format!(
                "Use the {} skill to write {target} for this repo. Interview me first.",
                skill.name
            ))
        }
        None => Ok(format!(
            "Write {target} for this repo, following these instructions exactly.\n\n{}",
            skill.document
        )),
    }
}
```

- [ ] **Step 6: Register** in `lib.rs`, after `agent_setup::move_agent_file`:

```rust
            agent_setup::move_agent_file,
            agent_setup::compose_agent_prompt
```

- [ ] **Step 7: Run** — `cargo test -p app` green.

- [ ] **Step 8: Commit**

```bash
git add app/src-tauri && git commit -m "feat(wizard): step skills for the agent-driven PRD and agent-file flows"
```

---

### Task 3: `setupWizard.ts` — the pure logic

**Files:**
- Create: `app/src/lib/setupWizard.ts`, `app/src/lib/setupWizard.test.ts`

**Interfaces:**
- Produces: `SetupStep`, `SetupProgress`, `setupProgress()`, `applyPrdSections()`, `agentFlowAvailable()`, `PRD_PLACEHOLDERS`.

- [ ] **Step 1: Write the failing tests** (`setupWizard.test.ts`):

```typescript
import { describe, it, expect } from "vitest";
import {
  setupProgress,
  applyPrdSections,
  agentFlowAvailable,
  PRD_PLACEHOLDERS,
} from "./setupWizard";

const TEMPLATE = [
  "# ws — Product Requirements",
  "",
  "## Vision",
  "",
  "_What are we building, for whom, and why?_",
  "",
  "## Current focus",
  "",
  "_The active goals, roughly ordered._",
  "",
  "## Out of scope",
  "",
  "_Explicit non-goals._",
  "",
].join("\n");

const NOTHING_DONE = {
  hasRoot: true,
  configCommand: null,
  agentFileBody: null,
  prdBody: TEMPLATE,
  mainSessionId: null,
};

describe("setupProgress", () => {
  it("reports nothing done for a freshly initialized root", () => {
    const p = setupProgress(NOTHING_DONE);
    expect(p.done).toEqual([]);
    expect(p.next).toBe("agent");
    expect(p.complete).toBe(false);
  });

  it("counts the agent step once config.toml has a command", () => {
    const p = setupProgress({ ...NOTHING_DONE, configCommand: "claude" });
    expect(p.done).toEqual(["agent"]);
    expect(p.next).toBe("integration");
  });

  it("counts integration only when the marker block is present", () => {
    expect(setupProgress({ ...NOTHING_DONE, agentFileBody: "# hand written\n" }).done).toEqual([]);
    expect(
      setupProgress({ ...NOTHING_DONE, agentFileBody: "x\n<!-- gavin:start -->\ny\n" }).done
    ).toEqual(["integration"]);
  });

  it("counts the PRD when at least one placeholder is gone", () => {
    expect(setupProgress(NOTHING_DONE).done).toEqual([]);
    const oneFilled = TEMPLATE.replace(PRD_PLACEHOLDERS.vision, "A terminal workspace.");
    expect(setupProgress({ ...NOTHING_DONE, prdBody: oneFilled }).done).toEqual(["prd"]);
  });

  it("treats an absent PRD as not done", () => {
    expect(setupProgress({ ...NOTHING_DONE, prdBody: null }).done).toEqual([]);
  });

  it("counts launch from the session id, and completes at four", () => {
    const p = setupProgress({
      hasRoot: true,
      configCommand: "claude",
      agentFileBody: "<!-- gavin:start -->",
      prdBody: TEMPLATE.replace(PRD_PLACEHOLDERS.vision, "Real."),
      mainSessionId: "agent-1",
    });
    expect(p.done).toEqual(["agent", "integration", "prd", "launch"]);
    expect(p.next).toBeNull();
    expect(p.complete).toBe(true);
  });

  it("next skips steps already done out of order", () => {
    const p = setupProgress({ ...NOTHING_DONE, mainSessionId: "agent-1" });
    expect(p.done).toEqual(["launch"]);
    expect(p.next).toBe("agent");
  });

  it("is never complete without a root", () => {
    const p = setupProgress({ ...NOTHING_DONE, hasRoot: false, configCommand: "claude" });
    expect(p.complete).toBe(false);
    expect(p.done).toEqual([]);
  });
});

describe("applyPrdSections", () => {
  it("replaces only the sections given", () => {
    const out = applyPrdSections(TEMPLATE, { vision: "A terminal workspace.", focus: "", outOfScope: "" });
    expect(out).toContain("A terminal workspace.");
    expect(out).not.toContain(PRD_PLACEHOLDERS.vision);
    expect(out).toContain(PRD_PLACEHOLDERS.focus);
    expect(out).toContain(PRD_PLACEHOLDERS.outOfScope);
  });

  it("ignores whitespace-only values", () => {
    expect(applyPrdSections(TEMPLATE, { vision: "   ", focus: "", outOfScope: "" })).toBe(TEMPLATE);
  });

  it("leaves an already-filled section alone rather than duplicating", () => {
    const once = applyPrdSections(TEMPLATE, { vision: "First.", focus: "", outOfScope: "" });
    const twice = applyPrdSections(once, { vision: "Second.", focus: "", outOfScope: "" });
    expect(twice).toBe(once);
  });

  it("preserves everything outside the placeholder lines", () => {
    const out = applyPrdSections(TEMPLATE, { vision: "V", focus: "F", outOfScope: "O" });
    expect(out).toContain("# ws — Product Requirements");
    expect(out).toContain("## Current focus");
  });
});

describe("agentFlowAvailable", () => {
  it("is true only for a profile with a verified prompt argument", () => {
    expect(agentFlowAvailable({ id: "claude-code", promptArg: true })).toBe(true);
    expect(agentFlowAvailable({ id: "codex", promptArg: false })).toBe(false);
    expect(agentFlowAvailable(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect failure.** `npx vitest run src/lib/setupWizard.test.ts` → cannot resolve `./setupWizard`.

- [ ] **Step 3: Implement:**

```typescript
export type SetupStep = "agent" | "integration" | "prd" | "launch";

export interface SetupProgress {
  done: SetupStep[];
  /// The first step not yet done, or null when everything is.
  next: SetupStep | null;
  complete: boolean;
}

/// Verbatim from PRD_TEMPLATE in crates/daemon/src/gavin.rs. Matching
/// these strings IS the contract -- if the template changes, these change
/// with it or the PRD step silently stops being detectable.
export const PRD_PLACEHOLDERS = {
  vision: "_What are we building, for whom, and why?_",
  focus: "_The active goals, roughly ordered._",
  outOfScope: "_Explicit non-goals._",
} as const;

const MARKER_START = "<!-- gavin:start -->";

export interface SetupInput {
  hasRoot: boolean;
  /// config.toml's [agent].command. The scaffold writes only `profile`,
  /// so a command can only have come from a person.
  configCommand: string | null;
  /// The resolved agent file's content; null when it does not exist.
  agentFileBody: string | null;
  prdBody: string | null;
  mainSessionId: string | null;
}

const ORDER: SetupStep[] = ["agent", "integration", "prd", "launch"];

/// Derived, never stored (W1): a step configured by hand -- or by an
/// agent -- counts the moment its evidence lands on disk.
export function setupProgress(input: SetupInput): SetupProgress {
  const done: SetupStep[] = [];
  if (!input.hasRoot) {
    return { done, next: "agent", complete: false };
  }
  if (input.configCommand?.trim()) done.push("agent");
  if (input.agentFileBody?.includes(MARKER_START)) done.push("integration");
  // At least one placeholder replaced, not all three: filling only Vision
  // is a real PRD, and requiring all three would never complete.
  if (
    input.prdBody !== null &&
    Object.values(PRD_PLACEHOLDERS).some((p) => !input.prdBody!.includes(p))
  ) {
    done.push("prd");
  }
  if (input.mainSessionId) done.push("launch");

  const ordered = ORDER.filter((s) => done.includes(s));
  const next = ORDER.find((s) => !done.includes(s)) ?? null;
  return { done: ordered, next, complete: next === null };
}

export interface PrdSections {
  vision: string;
  focus: string;
  outOfScope: string;
}

/// Replaces each placeholder line with the given prose. Blank values are
/// left alone, so skipping a section keeps its placeholder -- and a
/// section already filled has no placeholder to replace, which makes this
/// idempotent rather than duplicating.
export function applyPrdSections(body: string, sections: PrdSections): string {
  let out = body;
  const pairs: Array<[string, string]> = [
    [PRD_PLACEHOLDERS.vision, sections.vision],
    [PRD_PLACEHOLDERS.focus, sections.focus],
    [PRD_PLACEHOLDERS.outOfScope, sections.outOfScope],
  ];
  for (const [placeholder, value] of pairs) {
    if (value.trim()) out = out.replace(placeholder, value.trim());
  }
  return out;
}

/// The agent-driven option is offered only where the positional-prompt
/// convention is verified (spec §7.2); elsewhere the step says so rather
/// than risking a broken launch.
export function agentFlowAvailable(profile: { promptArg: boolean } | undefined): boolean {
  return Boolean(profile?.promptArg);
}
```

- [ ] **Step 4: Run** — green.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/setupWizard.ts app/src/lib/setupWizard.test.ts && git commit -m "feat(wizard): derived setup progress and PRD section application"
```

---

### Task 4: Wrappers and the agent-driven start

**Files:**
- Modify: `app/src/lib/backend.ts`, `app/src/lib/layoutState.ts`, `app/src/lib/settings.ts`, `app/src/lib/layoutState.test.ts`

**Interfaces:**
- Consumes: `compose_agent_prompt` (Task 2), `agentFlowAvailable` (Task 3).
- Produces: `backend.composeAgentPrompt()`, `startMainAgentWithPrompt(workspaceId, prompt)`; `AgentProfileInfo.promptArg`.

- [ ] **Step 1: Add the wrapper** (`backend.ts`):

```typescript
export function composeAgentPrompt(rootPath: string, flow: "prd" | "agent-file"): Promise<string> {
  return invoke("compose_agent_prompt", { rootPath, flow });
}
```

- [ ] **Step 2: Widen the profile type** in `settings.ts`'s `AgentProfileInfo`:

```typescript
  /// Whether the agent takes a positional prompt argument; gates the
  /// wizard's agent-driven flows (spec §7.2).
  promptArg: boolean;
```

Add `promptArg: false` to the `PROFILES` fixtures in `settings.test.ts` so they still typecheck — the existing assertions are unaffected.

- [ ] **Step 3: Write the failing test** (`layoutState.test.ts`, in the existing `main agent session` describe):

```typescript
  it("startMainAgentWithPrompt spawns with the composed prompt and records the session", async () => {
    setState([{ ...ws("ws-1", []), rootPath: "/tmp/ws" }], "ws-1", null);
    seedAgentConfig("ws-1", { profile: "claude-code", file: null, command: "claude" });
    vi.mocked(backend.createSession).mockResolvedValue("agent-1");

    await startMainAgentWithPrompt("ws-1", "Use the gavin-write-prd skill.");

    expect(backend.createSession).toHaveBeenCalledWith(
      "/tmp/ws",
      `claude 'Use the gavin-write-prd skill.'`
    );
    expect(get(layoutState).workspaces[0].mainSessionId).toBe("agent-1");
  });

  it("startMainAgentWithPrompt refuses when an agent is already running", async () => {
    setState(
      [{ ...ws("ws-1", []), rootPath: "/tmp/ws", mainSessionId: "already" }],
      "ws-1",
      null
    );
    vi.mocked(backend.createSession).mockClear();
    await startMainAgentWithPrompt("ws-1", "anything");
    expect(backend.createSession).not.toHaveBeenCalled();
  });
```

> Check `shellQuote`'s actual output before pinning the expected string — if it quotes differently, match the implementation, not this plan.

- [ ] **Step 4: Run — expect failure.** `startMainAgentWithPrompt` is not exported.

- [ ] **Step 5: Implement** in `layoutState.ts`, directly below `startMainAgent`:

```typescript
/// Starts the main agent already working on something (the wizard's
/// agent-driven steps, W5). Same rules as startMainAgent -- needs a root,
/// refuses when one is already running -- so the session it records is
/// the same one the Home panel shows and bootstrap reattaches.
export async function startMainAgentWithPrompt(
  workspaceId: string,
  prompt: string
): Promise<void> {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws?.rootPath || ws.mainSessionId) return;
  const command = buildRunCommand(resolvedAgentFor(workspaceId).command, prompt);
  let sessionId: string;
  try {
    sessionId = await backend.createSession(ws.rootPath, command);
  } catch (e) {
    setError(String(e));
    return;
  }
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, mainSessionId: sessionId } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}
```

Import `buildRunCommand` from `./cardRun`.

- [ ] **Step 6: Run** — `npx vitest run` green.

- [ ] **Step 7: Commit**

```bash
git add app/src && git commit -m "feat(wizard): start the main agent already working on a prompt"
```

---

### Task 5: The creation modal

> **Resolve the D56 conflict at the top of this plan before starting.**

**Files:**
- Create: `app/src/lib/WorkspaceCreateModal.svelte`
- Modify: `app/src/lib/Sidebar.svelte`

- [ ] **Step 1: Build the modal.**

```svelte
<script lang="ts">
  import { layoutState, setWorkspaceColor } from "./layoutState";
  import { DEFAULT_ACCENT } from "./settings";
  import WorkspaceRootControl from "./WorkspaceRootControl.svelte";
  import ColourPicker from "./ColourPicker.svelte";
  import Modal from "./Modal.svelte";

  interface Props {
    workspaceId: string;
    /// Called when the user finishes; the caller opens the wizard.
    onDone: () => void;
    /// Called when the user backs out. The workspace stays -- unrooted,
    /// exactly what creation produced before this modal existed.
    onSkip: () => void;
  }
  let { workspaceId, onDone, onSkip }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
</script>

{#if ws}
  <Modal onClose={onSkip}>
    <h2>Set up “{ws.name}”</h2>
    <p class="detail">Pick the folder this workspace works in. You can change all of this later in Settings.</p>

    <div class="row">
      <span>Folder</span>
      <WorkspaceRootControl workspace={ws} variant="settings" />
    </div>
    <div class="row">
      <span>Colour</span>
      <ColourPicker
        value={ws.color ?? DEFAULT_ACCENT}
        onChange={(c) => void setWorkspaceColor(workspaceId, c)}
      />
    </div>

    <div class="actions">
      <button type="button" onclick={onSkip}>Skip setup</button>
      <button type="button" disabled={!ws.rootPath} onclick={onDone}>Continue →</button>
    </div>
  </Modal>
{/if}

<style>
  h2 {
    margin: 0 0 6px;
    font-size: 1em;
    font-family: monospace;
    color: #eee;
  }
  .detail {
    margin: 0 0 16px;
    color: #888;
    font-family: monospace;
    font-size: 0.8em;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
    font-family: monospace;
    font-size: 0.85em;
    color: #ccc;
  }
  .row > span:first-child {
    width: 70px;
    flex: 0 0 auto;
    color: #999;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 18px;
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
  .actions button:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
```

The name is not re-asked — the sidebar already took it. Continue is disabled until a folder is bound, because every later step needs one.

- [ ] **Step 2: Wire it into `Sidebar.svelte`.** `commitNewWorkspace` currently fires `createWorkspace(trimmed)` and forgets. Capture the new id so the modal can target it:

```typescript
  let pendingSetupId = $state<string | null>(null);

  function commitNewWorkspace(): void {
    if (!creatingWorkspace) return;
    const trimmed = newWorkspaceName.trim();
    creatingWorkspace = false;
    if (!trimmed) return;
    void createWorkspace(trimmed).then(() => {
      // createWorkspace makes the new workspace active, so this is it.
      pendingSetupId = get(layoutState).activeWorkspaceId;
    });
  }
```

Import `get` from `svelte/store` if it is not already imported, and render at the end of the markup:

```svelte
{#if pendingSetupId}
  <WorkspaceCreateModal
    workspaceId={pendingSetupId}
    onSkip={() => (pendingSetupId = null)}
    onDone={() => {
      const id = pendingSetupId;
      pendingSetupId = null;
      if (id) openWizard(id);
    }}
  />
{/if}
```

`openWizard` comes from Task 6 — until then, stub it as `(id: string) => { pendingSetupId = null; }` and replace it there.

- [ ] **Step 3: Verify** — `npx svelte-check` 0 errors, `npx vitest run` green, `npm run build` succeeds.

- [ ] **Step 4: Commit**

```bash
git add app/src && git commit -m "feat(wizard): workspace creation modal for folder and colour"
```

---

### Task 6: The wizard

**Files:**
- Create: `app/src/lib/SetupWizard.svelte`, `app/src/lib/wizardSteps/AgentStep.svelte`, `IntegrationStep.svelte`, `PrdStep.svelte`, `LaunchStep.svelte`
- Modify: `app/src/lib/layoutState.ts` (the open-wizard store)

- [ ] **Step 1: Add the store** in `layoutState.ts`, so any surface can open the wizard:

```typescript
/// The workspace whose wizard is open, or null. A store rather than a
/// prop because two surfaces open it: the creation modal and the Home
/// tab's resume card.
export const wizardWorkspaceId = writable<string | null>(null);

export function openWizard(workspaceId: string): void {
  wizardWorkspaceId.set(workspaceId);
}

export function closeWizard(): void {
  wizardWorkspaceId.set(null);
}
```

Replace Task 5's `openWizard` stub in `Sidebar.svelte` with this import.

- [ ] **Step 2: Build the shell** (`SetupWizard.svelte`). It owns the current step, reads derived progress, and renders one step component:

```svelte
<script lang="ts">
  import { layoutState, closeWizard, agentProfilesStore } from "./layoutState";
  import { gavinTrees } from "./gavinState";
  import { resolveAgentConfig } from "./settings";
  import { setupProgress, type SetupStep } from "./setupWizard";
  import * as backend from "./backend";
  import Modal from "./Modal.svelte";
  import AgentStep from "./wizardSteps/AgentStep.svelte";
  import IntegrationStep from "./wizardSteps/IntegrationStep.svelte";
  import PrdStep from "./wizardSteps/PrdStep.svelte";
  import LaunchStep from "./wizardSteps/LaunchStep.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const STEPS: Array<{ id: SetupStep; label: string }> = [
    { id: "agent", label: "Agent" },
    { id: "integration", label: "Integration" },
    { id: "prd", label: "PRD" },
    { id: "launch", label: "Launch" },
  ];

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const tree = $derived($gavinTrees[workspaceId]);
  const rootContext = $derived(tree?.contexts.find((c) => c.kind === "root"));
  const agentCfg = $derived(resolveAgentConfig(rootContext?.agent ?? null, $agentProfilesStore));

  // Bodies the derivation needs. Re-read whenever the root or the
  // resolved agent file changes; the wizard is short-lived, so a watcher
  // would be more machinery than the case deserves.
  let agentFileBody = $state<string | null>(null);
  let prdBody = $state<string | null>(null);

  async function reread(): Promise<void> {
    const root = ws?.rootPath;
    if (!root) return;
    const [agentFile, prd] = await Promise.all([
      backend.readFileForViewer(`${root}/${agentCfg.file}`).catch(() => null),
      backend.readFileForViewer(`${root}/.gavin-root/PRD.md`).catch(() => null),
    ]);
    agentFileBody = agentFile?.exists ? agentFile.content : null;
    prdBody = prd?.exists ? prd.content : null;
  }

  $effect(() => {
    void agentCfg.file;
    void ws?.rootPath;
    void reread();
  });

  const progress = $derived(
    setupProgress({
      hasRoot: Boolean(ws?.rootPath),
      configCommand: rootContext?.agent?.command ?? null,
      agentFileBody,
      prdBody,
      mainSessionId: ws?.mainSessionId ?? null,
    })
  );

  let current = $state<SetupStep>("agent");
  let started = $state(false);
  // Open at the first unfinished step, once.
  $effect(() => {
    if (!started && progress.next) {
      current = progress.next;
      started = true;
    }
  });

  function advance(): void {
    void reread();
    const i = STEPS.findIndex((s) => s.id === current);
    if (i < STEPS.length - 1) current = STEPS[i + 1].id;
    else closeWizard();
  }
</script>

{#if ws}
  <Modal onClose={closeWizard}>
    <div class="wizard">
      <ol class="steps">
        {#each STEPS as step, i (step.id)}
          <li
            class:current={step.id === current}
            class:done={progress.done.includes(step.id)}
          >
            <span class="n">{i + 1}</span>
            {step.label}
          </li>
        {/each}
      </ol>

      <div class="body">
        {#if current === "agent"}
          <AgentStep {workspaceId} onDone={advance} />
        {:else if current === "integration"}
          <IntegrationStep {workspaceId} onDone={advance} />
        {:else if current === "prd"}
          <PrdStep {workspaceId} {prdBody} onDone={advance} />
        {:else}
          <LaunchStep {workspaceId} onDone={closeWizard} />
        {/if}
      </div>
    </div>
  </Modal>
{/if}

<style>
  .wizard {
    min-width: 520px;
    max-width: 640px;
  }
  .steps {
    display: flex;
    gap: 14px;
    list-style: none;
    margin: 0 0 18px;
    padding: 0 0 12px;
    border-bottom: 1px solid #333;
    font-family: monospace;
    font-size: 0.8em;
    color: #777;
  }
  .steps li {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .steps li.current {
    color: #eee;
  }
  .steps li.done {
    color: #8bc98b;
  }
  .n {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 1px solid currentColor;
    font-size: 0.85em;
  }
  .body {
    min-height: 220px;
  }
</style>
```

- [ ] **Step 3: `AgentStep.svelte`** — profile + command, always writing `command` so the step becomes detectable:

```svelte
<script lang="ts">
  import { layoutState, agentProfilesStore, setAgentField } from "./../layoutState";
  import { gavinTrees } from "./../gavinState";
  import { resolveAgentConfig } from "./../settings";

  interface Props {
    workspaceId: string;
    onDone: () => void;
  }
  let { workspaceId, onDone }: Props = $props();

  const tree = $derived($gavinTrees[workspaceId]);
  const agentCfg = $derived(
    resolveAgentConfig(
      tree?.contexts.find((c) => c.kind === "root")?.agent ?? null,
      $agentProfilesStore
    )
  );

  let commandDraft = $state("");
  let seeded = $state(false);
  $effect(() => {
    if (!seeded && agentCfg.command) {
      commandDraft = agentCfg.command;
      seeded = true;
    }
  });

  async function continueStep(): Promise<void> {
    // Always written, even unchanged: the presence of [agent].command is
    // what makes this step detectable (spec §3.2).
    await setAgentField(workspaceId, "command", commandDraft.trim() || agentCfg.command);
    onDone();
  }
</script>

<h3>Which agent?</h3>
<p class="hint">gavin writes the integration files for the agent you pick, and starts it with this command.</p>

<label class="row">
  <span>Profile</span>
  <select
    value={agentCfg.profileId}
    onchange={(e) => void setAgentField(workspaceId, "profile", e.currentTarget.value)}
  >
    {#each $agentProfilesStore as profile (profile.id)}
      <option value={profile.id}>{profile.label}</option>
    {/each}
  </select>
</label>

<label class="row">
  <span>Command</span>
  <input bind:value={commandDraft} spellcheck="false" />
</label>

<div class="actions">
  <button type="button" onclick={() => void continueStep()}>Continue →</button>
</div>

<style>
  h3 { margin: 0 0 4px; font-size: 0.95em; font-family: monospace; color: #eee; }
  .hint { margin: 0 0 16px; color: #888; font-family: monospace; font-size: 0.8em; }
  .row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; font-family: monospace; font-size: 0.85em; color: #ccc; }
  .row > span:first-child { width: 80px; flex: 0 0 auto; color: #999; }
  .row input, .row select { background: #1e1e1e; border: 1px solid #444; border-radius: 4px; color: #eee; font-family: monospace; font-size: 1em; padding: 3px 8px; min-width: 260px; }
  .actions { display: flex; justify-content: flex-end; margin-top: 18px; }
  .actions button { background: #3a3a3a; border: none; color: #eee; padding: 5px 12px; border-radius: 4px; cursor: pointer; font-family: monospace; }
</style>
```

- [ ] **Step 4: `IntegrationStep.svelte`** — one action, rendering `written` and `skipped` verbatim:

```svelte
<script lang="ts">
  import { layoutState } from "./../layoutState";
  import * as backend from "./../backend";

  interface Props {
    workspaceId: string;
    onDone: () => void;
  }
  let { workspaceId, onDone }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);

  let result = $state<backend.IntegrationResult | null>(null);
  let error = $state<string | null>(null);
  let running = $state(false);

  async function run(): Promise<void> {
    if (!ws?.rootPath) return;
    running = true;
    error = null;
    try {
      result = await backend.setupAgentIntegration(ws.rootPath);
    } catch (e) {
      error = String(e);
    }
    running = false;
  }

  function short(path: string): string {
    return ws?.rootPath ? path.replace(ws.rootPath + "/", "") : path;
  }
</script>

<h3>Integration files</h3>
<p class="hint">Teaches your agent about this workspace. Safe to re-run — hand-written content outside gavin's markers is never touched.</p>

{#if result}
  <ul class="results">
    {#each result.written as path (path)}
      <li class="ok">✓ {short(path)}</li>
    {/each}
    {#each result.skipped as [what, why] (what)}
      <li class="skip">— {what}: {why}</li>
    {/each}
  </ul>
{:else if error}
  <p class="warn">{error}</p>
{/if}

<div class="actions">
  {#if result}
    <button type="button" onclick={onDone}>Continue →</button>
  {:else}
    <button type="button" disabled={running} onclick={() => void run()}>
      {running ? "Writing…" : "Set up integration"}
    </button>
  {/if}
</div>

<style>
  h3 { margin: 0 0 4px; font-size: 0.95em; font-family: monospace; color: #eee; }
  .hint { margin: 0 0 16px; color: #888; font-family: monospace; font-size: 0.8em; }
  .results { list-style: none; margin: 0; padding: 0; font-family: monospace; font-size: 0.8em; }
  .results li { margin-bottom: 6px; }
  .ok { color: #8bc98b; }
  .skip { color: #888; }
  .warn { color: #e0b08a; font-family: monospace; font-size: 0.8em; }
  .actions { display: flex; justify-content: flex-end; margin-top: 18px; }
  .actions button { background: #3a3a3a; border: none; color: #eee; padding: 5px 12px; border-radius: 4px; cursor: pointer; font-family: monospace; }
  .actions button:disabled { opacity: 0.4; cursor: default; }
</style>
```

- [ ] **Step 5: `PrdStep.svelte`** — three fields, or hand it to the agent:

```svelte
<script lang="ts">
  import { layoutState, agentProfilesStore, startMainAgentWithPrompt } from "./../layoutState";
  import { gavinTrees } from "./../gavinState";
  import { resolveAgentConfig } from "./../settings";
  import { applyPrdSections, agentFlowAvailable } from "./../setupWizard";
  import * as backend from "./../backend";

  interface Props {
    workspaceId: string;
    prdBody: string | null;
    onDone: () => void;
  }
  let { workspaceId, prdBody, onDone }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const tree = $derived($gavinTrees[workspaceId]);
  const agentCfg = $derived(
    resolveAgentConfig(
      tree?.contexts.find((c) => c.kind === "root")?.agent ?? null,
      $agentProfilesStore
    )
  );
  const profile = $derived($agentProfilesStore.find((p) => p.id === agentCfg.profileId));
  const canAsk = $derived(agentFlowAvailable(profile) && !ws?.mainSessionId);

  let vision = $state("");
  let focus = $state("");
  let outOfScope = $state("");
  let error = $state<string | null>(null);
  let busy = $state(false);

  async function saveMine(): Promise<void> {
    if (!ws?.rootPath || prdBody === null) return onDone();
    busy = true;
    error = null;
    try {
      const next = applyPrdSections(prdBody, { vision, focus, outOfScope });
      if (next !== prdBody) {
        await backend.writeFileForEditor(`${ws.rootPath}/.gavin-root/PRD.md`, next);
      }
      onDone();
    } catch (e) {
      error = String(e);
    }
    busy = false;
  }

  async function askAgent(): Promise<void> {
    if (!ws?.rootPath) return;
    busy = true;
    error = null;
    try {
      const prompt = await backend.composeAgentPrompt(ws.rootPath, "prd");
      await startMainAgentWithPrompt(workspaceId, prompt);
      onDone();
    } catch (e) {
      error = String(e);
    }
    busy = false;
  }
</script>

<h3>The PRD</h3>
<p class="hint">The lead document for this workspace. Your agent reads it first; plans trace back to it. Anything you leave blank keeps its placeholder.</p>

<label class="field">
  <span>Vision — what are we building, for whom, and why?</span>
  <textarea bind:value={vision} rows="3"></textarea>
</label>
<label class="field">
  <span>Current focus</span>
  <textarea bind:value={focus} rows="2"></textarea>
</label>
<label class="field">
  <span>Out of scope</span>
  <textarea bind:value={outOfScope} rows="2"></textarea>
</label>

{#if error}
  <p class="warn">{error}</p>
{/if}

<div class="actions">
  <button type="button" onclick={onDone}>Skip</button>
  {#if canAsk}
    <button type="button" disabled={busy} onclick={() => void askAgent()}>Ask the agent →</button>
  {/if}
  <button type="button" disabled={busy} onclick={() => void saveMine()}>Continue →</button>
</div>
{#if !canAsk && profile && !profile.promptArg}
  <p class="hint">“Ask the agent” isn’t available for {profile.label} yet.</p>
{/if}

<style>
  h3 { margin: 0 0 4px; font-size: 0.95em; font-family: monospace; color: #eee; }
  .hint { margin: 0 0 14px; color: #888; font-family: monospace; font-size: 0.8em; }
  .field { display: block; margin-bottom: 10px; font-family: monospace; font-size: 0.8em; color: #999; }
  .field span { display: block; margin-bottom: 4px; }
  .field textarea { width: 100%; box-sizing: border-box; background: #1e1e1e; border: 1px solid #444; border-radius: 4px; color: #eee; font-family: monospace; font-size: 1em; padding: 5px 8px; resize: vertical; }
  .warn { color: #e0b08a; font-family: monospace; font-size: 0.8em; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  .actions button { background: #3a3a3a; border: none; color: #eee; padding: 5px 12px; border-radius: 4px; cursor: pointer; font-family: monospace; }
  .actions button:disabled { opacity: 0.4; cursor: default; }
</style>
```

- [ ] **Step 6: `LaunchStep.svelte`:**

```svelte
<script lang="ts">
  import { layoutState, startMainAgent, switchWorkspaceView } from "./../layoutState";

  interface Props {
    workspaceId: string;
    onDone: () => void;
  }
  let { workspaceId, onDone }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const running = $derived(Boolean(ws?.mainSessionId));

  async function launch(): Promise<void> {
    await startMainAgent(workspaceId);
    await switchWorkspaceView(workspaceId, "home");
    onDone();
  }

  async function openHome(): Promise<void> {
    await switchWorkspaceView(workspaceId, "home");
    onDone();
  }
</script>

<h3>{running ? "Your agent is already running" : "Start your agent"}</h3>
<p class="hint">
  {running
    ? "An earlier step started it. It's on the Home tab."
    : "Runs at the workspace root. Nothing starts on its own — this is the only step that spends money."}
</p>

<div class="actions">
  <button type="button" onclick={onDone}>Not now</button>
  {#if running}
    <button type="button" onclick={() => void openHome()}>Open it →</button>
  {:else}
    <button type="button" onclick={() => void launch()}>Start agent →</button>
  {/if}
</div>

<style>
  h3 { margin: 0 0 4px; font-size: 0.95em; font-family: monospace; color: #eee; }
  .hint { margin: 0 0 16px; color: #888; font-family: monospace; font-size: 0.8em; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; }
  .actions button { background: #3a3a3a; border: none; color: #eee; padding: 5px 12px; border-radius: 4px; cursor: pointer; font-family: monospace; }
</style>
```

- [ ] **Step 7: Render the wizard once, app-wide,** in `app/src/routes/+page.svelte`, just inside the outermost element:

```svelte
{#if $wizardWorkspaceId}
  <SetupWizard workspaceId={$wizardWorkspaceId} />
{/if}
```

importing `wizardWorkspaceId` from `$lib/layoutState` and `SetupWizard` from `$lib/SetupWizard.svelte`.

- [ ] **Step 8: Verify** — `npx svelte-check` 0 errors, `npx vitest run` green, `npm run build` succeeds.

- [ ] **Step 9: Commit**

```bash
git add app/src && git commit -m "feat(wizard): four-step setup wizard with agent-driven PRD"
```

---

### Task 7: Resume card, checklist, gates

**Files:**
- Modify: `app/src/lib/HomeHubView.svelte`, `app/src/lib/smokeChecklist.ts`

- [ ] **Step 1: Add the resume card** to `HomeHubView.svelte`. It already derives `tree` and `agentCfg`; add the bodies and the progress:

```svelte
  import { setupProgress } from "./setupWizard";
  import { openWizard } from "./layoutState";

  let agentFileBody = $state<string | null>(null);
  let prdBody = $state<string | null>(null);

  // Read alongside the PRD excerpt this view already fetches -- summaries,
  // not live views (D31), so no watcher.
  $effect(() => {
    const r = root;
    if (!r) return;
    void backend
      .readFileForViewer(`${r}/${agentCfg.file}`)
      .then((res) => (agentFileBody = res.exists ? res.content : null))
      .catch(() => (agentFileBody = null));
    void backend
      .readFileForViewer(`${r}/.gavin-root/PRD.md`)
      .then((res) => (prdBody = res.exists ? res.content : null))
      .catch(() => (prdBody = null));
  });

  const setup = $derived(
    setupProgress({
      hasRoot: Boolean(root),
      configCommand: tree?.contexts.find((c) => c.kind === "root")?.agent?.command ?? null,
      agentFileBody,
      prdBody,
      mainSessionId: ws?.mainSessionId ?? null,
    })
  );
```

and, above the grid in the markup:

```svelte
    {#if root && !setup.complete}
      <button type="button" class="setup-card" onclick={() => openWizard(workspaceId)}>
        <b>Finish setting up this workspace</b>
        <span>{setup.done.length} of 4 done — continue</span>
      </button>
    {/if}
```

```css
  .setup-card {
    display: flex;
    flex-direction: column;
    gap: 3px;
    align-items: flex-start;
    text-align: left;
    background: #1a1a1a;
    border: 1px solid #3a4a3a;
    border-radius: 8px;
    padding: 8px 10px;
    color: #ccc;
    font-family: monospace;
    font-size: 0.8em;
    cursor: pointer;
    flex: 0 0 auto;
  }
  .setup-card span {
    color: #8bc98b;
  }
```

> Confirm `ws` is the variable name HomeHubView uses for the workspace; if it differs, follow the file.

**On the Unfiled exemption (spec §3.3):** no explicit check is needed, and
adding one would be dead code. Unfiled is never created through the
sidebar, so the creation modal cannot fire for it; and the Home view is
`requiresRoot: true` while Unfiled has no root, so the resume card cannot
render there either. Verify this during the smoke pass (`wiz-unfiled`)
rather than coding around it — but if either premise turns out false, add
the `UNFILED_WORKSPACE_ID` guard and say so.

- [ ] **Step 2: Add the checklist section** in `smokeChecklist.ts`, after "Workspace settings":

```typescript
  {
    title: "Init wizard",
    items: [
      { id: "wiz-create", text: "Creating a workspace opens the setup modal; Continue is disabled until a folder is bound" },
      { id: "wiz-skip-create", text: "Skip setup leaves a usable, unrooted workspace — exactly as before" },
      { id: "wiz-steps", text: "The wizard opens on Agent and walks Agent → Integration → PRD → Launch" },
      {
        id: "wiz-resume",
        text: "Closing the wizard mid-way leaves the workspace usable; the Home tab offers “n of 4 done — continue”",
      },
      {
        id: "wiz-derived",
        text: "Doing a step by hand (bind a root, run Set up integration in Settings) marks it done in the wizard without visiting it",
        hint: "Progress is derived from disk, never stored — that's the property this checks.",
      },
      { id: "wiz-prd-fields", text: "Filling only Vision writes it into PRD.md and leaves the other two placeholders" },
      { id: "wiz-prd-agent", text: "“Ask the agent” starts the main agent already working on the PRD; Launch then says “already running”" },
      {
        id: "wiz-agent-gate",
        text: "With a non-Claude profile, “Ask the agent” is absent and the step says why",
      },
      {
        id: "wiz-integration-degrades",
        text: "With Codex selected, Integration still writes AGENTS.md and lists the skill file and MCP config as skipped, with reasons",
      },
      { id: "wiz-complete", text: "Once all four are done the Home card disappears" },
      { id: "wiz-unfiled", text: "The Unfiled workspace never offers the wizard" },
    ],
  },
```

- [ ] **Step 3: Full gates.**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cargo test
cd app && npx vitest run && npx svelte-check && npm run build
```

All must be clean: `svelte-check` 0 errors, build succeeding.

- [ ] **Step 4: Manual smoke** — run the new section. `wiz-derived` and `wiz-integration-degrades` matter most: the first is the whole premise of W1, and the second is the behaviour change this work makes to existing code.

- [ ] **Step 5: Commit**

```bash
git add app/src && git commit -m "feat(wizard): home resume card and init wizard smoke checklist"
```

---

## Testing summary

- **Rust:** 4 `IntegrationResult` tests (block written for a layout-less profile; the two omissions named with reasons; inline vs pointer block; `prompt_arg` set only for claude-code), 1 rewritten refusal test, 4 `compose_agent_prompt` tests (skill invoked by name and installed; document inlined when no skill mechanism; the configured file name used; unknown flow rejected).
- **TypeScript:** ~12 `setupProgress` cases covering each derivation in both directions plus `next`/`complete`, 4 `applyPrdSections` cases including idempotence, 3 `agentFlowAvailable` cases, 2 `startMainAgentWithPrompt` cases.
- **Components — manual only.** `WorkspaceCreateModal`, `SetupWizard` and its four steps, and the Home resume card are covered by the 11-item "Init wizard" checklist section. vitest here cannot preprocess `.svelte`, so there is no automated alternative.

## Out of scope

The MCP writers for Codex/Gemini/Cursor/opencode (their own sub-project — this plan only makes their absence legible, via `skipped` and the `prompt_arg` gate). Supervising or verifying what an agent writes. A first-run tour. Authoring a first plan card.
