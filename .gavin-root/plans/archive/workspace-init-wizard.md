---
order: 4096
title: Workspace init wizard
kind: plan
status: Done
priority: medium
labels: ui
---
# Workspace init wizard

Two-stage onboarding for a new workspace: a creation modal for the folder
and fundamental settings, then a guided wizard for agent setup.

Ships before the multi-agent MCP writers: the Integration step degrades
honestly for profiles that have no MCP support yet (W4).

## Decisions taken in brainstorming (2026-08-21)

- **W1 — Skippable and resumable.** Closing the wizard at any step leaves
  the workspace usable; the Home tab offers to finish setup. Progress is
  **derived from disk** (root bound? agent file present? .mcp.json
  written?), never stored, so a step done by hand already counts.
- **W2 — Four steps:** Agent (profile + command) → Integration
  ({agent}.md + skill + MCP config, one action) → PRD → Launch. Launch is
  optional and last: it is the only step that costs money, so it stays a
  deliberate press (upholds D12, nothing starts on its own).
- **W3 — The PRD step prompts for the template's three sections**
  (Vision / Current focus / Out of scope) and writes them into the
  existing `PRD.md` structure. Blank fields keep the placeholders.
- **W4 — Integration degrades honestly.** `setup_agent_integration`
  splits so the agent-file block is written for ANY profile; the skill
  file and MCP config are skipped with a named reason when the profile
  has no `McpLayout`. Agents without a skill mechanism get the guidance
  inline in the block.
- **W5 — Agent-driven authoring for both documents.** The PRD and
  agent-file steps each offer "I'll write it" or "ask the agent";
  choosing the agent starts the session on that step, one deliberate
  press, so D12 holds. The Launch step then reports it already running.

Resolved since: step 1's modal embeds the Settings components rather than
restating them, and the wizard is offered for any unconfigured workspace
(derived progress makes that free).

- Spec: docs/superpowers/specs/2026-08-21-workspace-init-wizard-design.md
- Plan: docs/superpowers/plans/2026-08-21-workspace-init-wizard.md (7 tasks)

## Resolved

D56 was widened to name the wizard, recorded as D57 in the
workspace-settings spec. All 7 tasks are implemented and committed on
branch `worktree-init-wizard`; automated verification green (cargo 391,
vitest 627, svelte-check 0 errors, build clean). Remaining before Done:
the owner's interactive pass over the Checklist tab's 11-item "Init
wizard" section.

## Original blocking question (resolved)

D56 ("Settings owns every folder-picking and integration action") was
added to the workspace-settings spec after this design was approved. The
wizard needs both a folder picker and the integration action, making it a
second owner. Recommended amendment: D56 becomes "Settings and the init
wizard own..." — the wizard is a setup flow, the same job D37 gave
Settings when it made the panel work unrooted. Tasks 1-4 are unaffected.

## Remaining to close

Everything in code is built and merged to `main`. The only work left is the
owner's interactive pass — no component has been clicked by a human yet.

- [ ] Run the 11-item smoke script below in the Smoke Test workspace
      — **owner-only**; the wizard is a WKWebView surface with no automation
      harness, so no agent can tick this one. Pre-flighted statically instead
      (table below): every string the script names is confirmed present, so
      any failure the pass turns up is a real one.
- [ ] Move this card to Done once the pass is clean — gated on the item above
- [x] Push `main` — pushed 2026-08-24, `b3a6ae3..ae44a78`; nothing left unpushed
      (re-confirmed: `git ls-remote origin main` == local `main` == `ae44a78`)

### Verification standing (2026-08-24, clean worktree at `main` ae44a78)

Re-run against a detached checkout of `main` HEAD, not the shared working
tree — eight agent sessions have WIP in it, so the dirty tree proves nothing
about what is committed.

| Gate | Result |
| --- | --- |
| `cargo test --workspace` | 510 passed, 0 failed |
| `vitest run` | 1128 passed, 66 files |
| `svelte-check --threshold error` | 0 errors (28 warnings) |

The card previously recorded vitest 689; the number moved because later
merges (`b262f65`, `ae44a78`) landed after that reading, not because
anything here changed. The daemon fs-watcher tests that flake under
full-suite parallelism passed here — an isolated target dir avoids the
contention.

Wizard-specific coverage inside those totals: 13 `setupWizard.test.ts`
cases and 20 `agent_setup` cases, including
`integration_writes_the_block_for_a_profile_with_no_mcp_layout` and
`a_profile_without_a_skill_mechanism_gets_the_guidance_inline` — the two
that pin W4.

### Script pre-flight (2026-08-24, static, at `main` ae44a78)

The smoke script only saves time if every string it names still exists, so
each of the 11 items was checked against the committed source before the
owner spends a session on it. All 11 anchor correctly:

| # | Item | Anchor confirmed at |
| --- | --- | --- |
| 1 | wiz-create | `WorkspaceCreateModal.svelte:41,44` — `Skip setup`, `disabled={!ws.rootPath}` `Continue →` |
| 2 | wiz-skip-create | `HomeHubView.svelte:114` |
| 3 | wiz-steps | `setupWizard.ts:32` step order; `SetupWizard.svelte:130,133` — current `#eee`, done `#8bc98b` |
| 4 | wiz-resume | `HomeHubView.svelte:119,120` |
| 5 | wiz-derived | `HomeHubView.svelte:57-63` — the `$effect` keys on `root` only, exactly as the caveat says |
| 6 | wiz-prd-fields | `setupWizard.ts:15,16` match `gavin.rs:21,22` `PRD_TEMPLATE` verbatim |
| 7 | wiz-prd-agent | `wizardSteps/PrdStep.svelte:89`; `wizardSteps/LaunchStep.svelte:25` |
| 8 | wiz-agent-gate | `wizardSteps/PrdStep.svelte:94` |
| 9 | wiz-integration-degrades | `agent_setup.rs:344-351` reasons; `agent_setup.rs:86-87` Codex label/`AGENTS.md`; `wizardSteps/IntegrationStep.svelte:43,46` `✓` / `—` rows |
| 10 | wiz-complete | `HomeHubView.svelte:117` |
| 11 | wiz-unfiled | `Sidebar.svelte:896` — the modal is gated on `pendingSetupId`, set only on create; Unfiled is bootstrapped in Rust and never passes through it |

Two drifts corrected so far. Item 8: the card quoted the gate message with
straight quotes, the component renders curly ones. Item 7/8/9: the three step
components live in `app/src/lib/wizardSteps/`, not `app/src/lib/` — the table
had dropped the directory, so opening the named path would have failed to find
the file. Both would have read as failures that aren't there.

Re-verified 2026-08-24 (second pass, same HEAD): every one of the 11 anchors
re-opened at its exact line, plus the `origin/main` check. All still land.
Nothing else moved.

Not re-run here: the three gates above were already measured at this exact
HEAD and the wizard files are clean, so there is no new commit to re-measure.

### Smoke script

Dev build only: the Checklist tab lives in the **Smoke Test** workspace.
Each item names the exact string to look for, so the pass is confirmation
rather than rediscovery.

1. **wiz-create** — New workspace → the setup modal opens. `Continue →` is
   disabled until a folder is bound (`disabled={!ws.rootPath}`); `Skip
   setup` is always live.
2. **wiz-skip-create** — Press `Skip setup`. The workspace exists, unrooted,
   and Home reads `No root folder set for this workspace.`
3. **wiz-steps** — Bind a root, then walk Agent → Integration → PRD →
   Launch. The rail shows the current step in white, done steps in green.
4. **wiz-resume** — Close the wizard on step 2. Home shows
   `Finish setting up this workspace` / `n of 4 done — continue`.
5. **wiz-derived** — In Settings, bind a root or press *Set up integration*,
   **then leave the Home tab and come back**. Home reads those files on
   mount and on root change only — D31 makes these summaries, not live
   views, so no watcher fires. Judging this without remounting reports a
   failure that isn't there.
6. **wiz-prd-fields** — Fill only Vision → Continue. `.gavin-root/PRD.md`
   keeps `_The active goals, roughly ordered._` and `_Explicit non-goals._`
   verbatim; only the Vision placeholder is gone.
7. **wiz-prd-agent** — `Ask the agent →` starts the main agent on the PRD.
   The Launch step then heads `Your agent is already running`.
8. **wiz-agent-gate** — Switch the profile to a non-Claude one. `Ask the
   agent →` is gone and the step reads `“Ask the agent” isn’t available for
   {label} yet.` (curly quotes — the code renders “ ” ’, so a straight-quote
   search misses it)
9. **wiz-integration-degrades** — With Codex selected, press *Set up
   integration*. Expect one `✓ AGENTS.md` plus two `—` rows: `skill file:
   Codex CLI has no skill mechanism — the guidance is inline in AGENTS.md`
   and `MCP config: not available for Codex CLI yet`. This is the W4
   behaviour change; that profile previously got nothing at all.
10. **wiz-complete** — With all four done, the Home setup card is absent
    (`{#if root && !setup.complete}`).
11. **wiz-unfiled** — Unfiled has no root, so Home shows the empty state and
    the wizard is never offered. The only other entry point is the creation
    modal, which Unfiled never goes through.

**Known limitation, by design:** "Ask the agent" appears only for Claude
Code, because `prompt_arg` is verified only there. See the
`multi-agent-mcp` card to unlock the rest.
