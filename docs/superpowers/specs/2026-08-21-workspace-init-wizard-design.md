# Workspace Init Wizard — Design

**Status:** approved 2026-08-21.

**Goal:** turn workspace creation from "a name in the sidebar, then find the
settings yourself" into a guided path: a modal for the folder and
fundamentals, then a four-step wizard that configures the agent, writes the
integration files, authors the PRD, and optionally launches the agent —
with the document steps able to hand the writing to the agent itself.

---

## 1. Scope

**In:** the creation modal; the four-step wizard (Agent, Integration, PRD,
Launch); derived setup progress and the Home tab's resume card;
agent-driven authoring for the PRD and the agent file, backed by skill
documents; splitting `setup_agent_integration` so it degrades honestly for
profiles with no MCP layout.

**Out:** the MCP writers for Codex/Gemini/Cursor/opencode (still their own
sub-project — this design only makes their absence legible); supervising or
verifying what an agent writes; a first-run product tour; authoring a first
plan card.

## 2. Decisions

Recorded on the card as W1–W6.

- **W1 — Skippable and resumable.** Closing the wizard leaves the workspace
  usable. Progress is **derived from disk**, never stored, so a step done by
  hand already counts and no record can disagree with reality.
- **W2 — Four steps:** Agent → Integration → PRD → Launch. Launch is
  optional and last: it is the only step that spends money, so it stays a
  deliberate press (D12).
- **W3 — The PRD step prompts for the template's three sections**
  (Vision / Current focus / Out of scope), writing into `PRD.md`'s existing
  headings. Blank fields keep the placeholders.
- **W4 — Integration degrades honestly.** `setup_agent_integration` splits
  so the agent-file block is written for **any** profile; skill file and MCP
  config are skipped with a named reason when the profile has no
  `McpLayout`.
- **W5 — Agent-driven authoring for both documents.** The PRD and
  agent-file steps each offer "I'll write it" or "ask the agent". Choosing
  the agent starts the session on that step — one deliberate press, so D12
  holds — and the Launch step then reports it already running.
- **W6 — Every agent-driven flow is backed by a skill document**, not an
  ad-hoc prompt string. One authored file per flow, delivered as a real
  skill where the profile has a skill mechanism and inlined into the spawn
  prompt where it does not.

## 3. Architecture

### 3.1 Two surfaces

Creation stays where it is — the sidebar's `+` with an inline name field.
What follows is new:

1. **The creation modal** (small): folder picker with today's init flow,
   name, colour.
2. **The wizard** (large modal overlay, `Modal.svelte`): four steps, opened
   straight after the creation modal and reopenable later.

Both are modals rather than a hub tab: a workspace mid-setup should not
gain a tab that vanishes once configured, and the wizard is a flow, not a
place.

### 3.2 Progress is derived

A pure function, not persisted state:

```typescript
export type SetupStep = "agent" | "integration" | "prd" | "launch";

export interface SetupProgress {
  done: SetupStep[];
  next: SetupStep | null;   // null once everything is done
  complete: boolean;
}

export function setupProgress(input: {
  hasRoot: boolean;
  configCommand: string | null;   // config.toml's [agent].command
  agentFileBody: string | null;   // the resolved agent file's content, null if absent
  prdBody: string | null;
  mainSessionId: string | null;
}): SetupProgress;
```

| Step | Done when | Why that signal |
| --- | --- | --- |
| Agent | `[agent].command` is present in `config.toml` | The scaffold writes only `profile`, so a `command` key can only come from a person. The wizard's Agent step always writes it, even unchanged |
| Integration | the agent file exists **and** contains `<!-- gavin:start -->` | The marker is what `write_instructions_block` owns; its presence is exactly "gavin has set this file up" |
| PRD | `PRD.md` exists and **at least one** of the three placeholder lines is gone | Distinguishes a written PRD from an untouched scaffold. "At least one", not "none": filling only Vision is a real PRD, and requiring all three would leave the step permanently undone |
| Launch | `mainSessionId` is set | Already tracked, already reconciled at bootstrap |

Nothing is stored, so there is no progress record to fall out of sync,
and configuring something by hand — or by agent — counts immediately.

### 3.3 The resume affordance

While `complete` is false and the workspace is rooted, the Home tab shows a
card: **"Setup: 2 of 4 — Continue"**, reopening the wizard at `next`. At 4
of 4 the card is absent. `UNFILED_WORKSPACE_ID` is exempt throughout — it is
the deliberate scratch space and has no root by design.

The wizard is offered for **any** unconfigured workspace, not only
brand-new ones. Derived progress makes that free: an existing workspace
simply starts further along.

## 4. The creation modal

Fields: **folder** (the existing picker plus the "Initialize gavin in this
folder?" confirm), **name**, **colour**.

It **embeds the same components as the Settings panel** —
`WorkspaceRootControl` in its `settings` variant, and `ColourPicker` —
rather than restating the fields, so the two surfaces cannot drift.

Notification toggles are deliberately absent: they are a preference, not a
setup decision, and belong in Settings where they already live.

Cancelling leaves a named, unrooted workspace — exactly what creation
produces today.

## 5. The four steps

### 5.1 Agent

Profile dropdown and launch command, written through the existing
`setAgentField` to `config.toml`. Continuing always writes `command`, even
when unchanged, because that write is what makes the step detectable (§3.2).

### 5.2 Integration

One action, calling the split `setup_agent_integration` (§6). The step
renders its result verbatim:

```
✓ AGENTS.md      gavin block written
— skill file     Codex CLI has no skill mechanism;
                 the guidance is inline in AGENTS.md
— .mcp.json      not available for Codex CLI yet
```

### 5.3 PRD

Two paths.

**Write it myself:** three textareas mapped to the template's headings.
Non-empty values replace the matching placeholder line in `PRD.md`; empty
ones leave the placeholder intact. The three lines, verbatim from
`PRD_TEMPLATE` in `crates/daemon/src/gavin.rs` — match these exactly, they
are the whole contract:

```
_What are we building, for whom, and why?_
_The active goals, roughly ordered._
_Explicit non-goals._
```

The write goes through the existing `write_file_for_editor` command, so it
is the same path the PRD tab uses.

**Ask the agent:** §7.

### 5.4 Launch

Optional and last. Starts the main agent via the existing
`startMainAgent`, or — when an agent-driven step already started it —
reports "already running" with a button that opens the Home tab. Skipping
finishes the wizard; the Home card disappears only when every *other* step
is done, so an unlaunched workspace does not nag.

## 6. Splitting `setup_agent_integration`

Today it returns `Err` for any profile without an `McpLayout`, writing
nothing at all — so choosing Codex leaves the agent with no gavin guidance
whatsoever. It becomes:

```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationResult {
    pub written: Vec<String>,
    /// (what was skipped, why) — rendered verbatim by the wizard.
    pub skipped: Vec<(String, String)>,
}
```

- The **instructions block is written for every profile**.
- The **skill file and MCP config** are written only when the profile has an
  `McpLayout`; otherwise each is recorded in `skipped` with its reason.

The block gains two variants from one source: today's short pointer to
`SKILL.md` where a skill mechanism exists, and a self-contained version
carrying the guidance inline where it does not.

This is the only place the wizard changes existing behaviour rather than
sequencing it, and it is a strict improvement.

## 7. Agent-driven flows

### 7.1 Skill documents, not prompt strings (W6)

Two new authored files beside today's `gavin_skill.md`, `include_str!`'d the
same way and using the same YAML frontmatter (`name`, `description`):

| File | Teaches |
| --- | --- |
| `gavin_prd_skill.md` | Interview the owner about the project; write `.gavin-root/PRD.md` keeping its existing headings; do not invent scope |
| `gavin_agent_file_skill.md` | Write the instructions file for this repo; never modify anything between `<!-- gavin:start -->` and `<!-- gavin:end -->` |

One source, two deliveries:

- Profile **has** a skill dir → the document is written to
  `<skill_dir>-write-prd/SKILL.md` and the spawn prompt invokes it by name.
- Profile **has none** → the same content is inlined into the spawn prompt.

Authoring the guidance as a reviewable file rather than a format string is
the point: it can be read, diffed and improved like any other document, and
it answers part of the multi-agent MCP sub-project's open question as a side
effect.

### 7.2 Starting the agent

Reuses the machinery `cardRunActions` already proved: `buildRunCommand`
produces `<command> <shell-quoted prompt>`, and the session is started as
the workspace's main agent.

**The known risk:** a positional prompt argument is verified for Claude
Code and is **not** a universal CLI convention. Getting it wrong puts
garbage in the agent's argv. So `AgentProfile` gains:

```rust
/// Whether this agent accepts a positional prompt argument. Only set
/// where the convention is verified; agent-driven flows are hidden for
/// profiles where it is not, rather than risking a broken launch.
pub prompt_arg: bool,
```

`true` for `claude-code` only, at this stage. Where it is false, the
agent-driven option is absent and the step says so — the same posture as
W4. The multi-agent MCP sub-project fills these in per profile as it
verifies each CLI.

### 7.3 After the spawn

The wizard advances to Launch showing "already running", and the
conversation continues in the Home tab's agent panel. The wizard does
**not** supervise the agent, wait for it, or verify what it wrote — derived
progress picks the result up on its own once `PRD.md` loses its
placeholders. An agent that writes nothing simply leaves the step undone.

## 8. Error handling

Because nothing is stored, every step is independently retryable and a
failure leaves progress exactly where it was.

| Failure | Behaviour |
| --- | --- |
| Init / folder binding fails | Existing modal error, unchanged |
| Integration partly fails | `written` shows what landed; the error names what did not. Re-running is safe — the writers are merge-aware and never overwrite |
| PRD write fails | Inline error on the step; the typed values stay in the fields |
| Agent spawn fails | Existing `setError` path; Launch stays undone |
| `config.toml` unparseable | Agent step is read-only with the existing `configWarning`, as in the Settings panel |

## 9. Testing

vitest here cannot preprocess `.svelte` — a test that merely imports a
component fails at collection — so everything decidable lives in pure
modules.

**TypeScript** (`setupWizard.ts`):

- `setupProgress` — each of the four derivations, in both directions:
  a `command`-less `config.toml` leaves Agent undone; a marker-less agent
  file leaves Integration undone; a placeholder-bearing `PRD.md` leaves PRD
  undone; `mainSessionId` drives Launch. Plus `next` skipping already-done
  steps and `complete` at 4 of 4.
- `applyPrdSections(template, {vision, focus, outOfScope})` — replaces only
  the matching placeholder lines, leaves blanks alone, and is idempotent.
- `agentFlowAvailable(profile)` — false without `promptArg`.

**Rust:**

- `IntegrationResult`: every profile gets an instructions block; only
  layout-bearing profiles get skill and MCP; `skipped` names a reason for
  each omission; re-running preserves hand-written content outside the
  markers.
- Block-variant selection: pointer form when a skill dir exists, inline form
  otherwise.
- The profile table: `prompt_arg` true for exactly `claude-code` at this
  stage.

**Manual:** a new "Init wizard" checklist section covering the creation
modal, each step, resuming from the Home card, the derived progress
recognising hand-made changes, both agent-driven flows, and the honest
degradation for a profile without MCP or without `prompt_arg`.

## 10. Out of scope, restated

The four MCP writers remain their own sub-project. This design makes their
absence *legible* — named in `skipped`, and gating the agent-driven option
via `prompt_arg` — but does not implement them.
