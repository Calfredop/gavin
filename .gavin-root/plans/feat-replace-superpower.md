---
order: 14336
kind: plan
title: [feat] Replace Superpowers with Matt Pocock's skills
status: In Progress
---
Replace the Superpowers agent tooling with Matt Pocock's skills set
(https://github.com/mattpocock/skills — "Skills for Real Engineers", the
set whose router is `/ask-matt`). Everywhere gavin today recommends,
installs and detects Superpowers, it recommends, installs and detects
Matt Pocock's skills instead — and the Superpowers code is removed, not
re-pointed.

The previous integration (`feat-superpowers-integration.md`, archived) is
the shape to follow; the install-matrix spec its spike produced
(`docs/superpowers/specs/2026-09-01-superpowers-install-matrix.md`)
documents the machine behavior gavin's detectors rely on today.

## Decided (2026-10-05)

- **R1 — Full removal, generic internals.** `app/src-tauri/src/superpowers.rs`,
  `app/src/lib/agents/superpowers.ts`, `SuperpowersControls.svelte` and
  `SuperpowersStep.svelte` are deleted and reborn as `agent_skills.rs` /
  `agentSkills.ts` / `AgentSkillsControls.svelte` / `AgentSkillsStep.svelte`
  (generic names, so the next swap doesn't rename the world again). Every
  referencing surface follows: init wizard step, Settings → Agent row,
  Home setup banner, agent-change and agent-arm wizards, smoke checklist.
  The UI names the product: "Matt Pocock's skills". CONTEXT.md's *Agent
  tooling* entry swaps its Superpowers example; the definition itself is
  already product-agnostic.
- **R2 — Farewell note, targeted, dismiss-once.** On machines whose
  machine-local marker (`config.json`, keyed by workspace root) records a
  previous Superpowers install/assertion/skip, the Settings → Agent
  section shows a one-time note: gavin now recommends Matt Pocock's
  skills; Superpowers is the user's to keep or remove. Dismissal is
  recorded in the same `config.json`. No uninstall path — the plugin is
  the user's own. Machines with no marker never see the note.
- **R3 — Spike first.** The nested task
  `spike-mattpocock-skills-install-matrix.md` verifies the matrix on real
  machines; its spec finalizes the matrix below before implementation
  steps run. Its brief is the 2026-10-05 research (verified on this
  machine): the Claude plugin is in the official pre-configured
  marketplace; `npx skills@latest add` is fully non-interactive
  (`--skill`, `--agent`, `-y`, `--copy`, `--json`) and writes
  `skills-lock.json` at the project root; at project scope all non-Claude
  agents share `.agents/skills/`.
- **R4 — Install matrix (finalized by the spike, 2026-10-06 —
  `docs/superpowers/specs/2026-10-05-mattpocock-skills-install-matrix.md`).**
  Real Install buttons for all five known profiles (gavin has no Kimi
  profile; a Kimi user is `custom`):
  - Claude Code → plugin route: `claude plugin install
    mattpocock-skills --scope project -y` (managed, auto-updating; same
    marketplace trust story as Superpowers' S3). On a Claude Code that has
    never run interactively the official marketplace is not configured and
    the install fails "not found in any configured marketplace"; the row
    names `claude plugin marketplace add anthropics/claude-plugins-official`
    rather than running it.
  - Codex, Cursor, Gemini CLI, opencode → CLI route: `npx -y
    skills@latest add mattpocock/skills --skill '*' -a <agent id> -y` at
    project scope (agent ids: `codex`, `cursor`, `gemini-cli`,
    `opencode`). All four land in the same `.agents/skills/`. No `--copy`:
    with one agent the CLI copies anyway, and on Windows it uses junctions.
  - Custom profiles → manual instructions (skills.sh) + "I've installed
    it". Gavin does not guess an agent id for a profile it doesn't know.
  - Full skill set (`--skill '*'`, includes `setup-matt-pocock-skills`).
    Correction: this is 38 skills, a superset of the plugin's 27
    (`'*'` adds upstream's `in-progress/` and `misc/`), not parity with
    it. Project scope only; no global installs.
- **R5 — Detection keeps its meaning.** Green = "active for this workspace
  on this machine"; verified and asserted stay visually distinct.
  - Plugin route: `claude plugin list --json` run in the workspace root,
    entry id `mattpocock-skills@*`, any scope, `enabled: true` — the
    exact mechanism Superpowers detection uses today (verified).
  - CLI route: `skills-lock.json` contains an entry with
    `source: "mattpocock/skills"` whose `.agents/skills/<name>/SKILL.md`
    exists (a lock without the directories — gitignored, fresh clone —
    reads absent). Files live in the repo, so they travel
    with it — the old S9 "repo travels to a machine without it" concern
    does not apply to this route.
  - Custom profiles: machine-local marker, shown as assertion. The
    marker mechanism survives only for this and the R2 note.
- **R6 — Copy steers, gavin does not run setup.** The wizard step explains
  the set (grilling-first flows: grill-with-docs, tdd, diagnosing-bugs),
  notes that gavin's own cards and rails cover the ticket side of Matt's
  flow, and that `/setup-matt-pocock-skills` (issue tracker, triage
  labels, docs layout) is optional and the human's to run in their agent.
  Both surfaces keep the note that freshly installed skills only reach
  sessions started after.
- **R7 — Same UX shape.** The wizard keeps its step in the same position
  (renamed), Settings keeps its row with the green LED, the Home banner's
  done-rule keeps its shape (detection says installed OR marker set).
- **R8 — Non-goals.** No update mechanism for the CLI route (`npx skills
  update` is the user's; the plugin route auto-updates). No global-scope
  installs. No detection of whether `/setup-matt-pocock-skills` has been
  run.

## Steps

- [x] Spike lands first: `spike-mattpocock-skills-install-matrix.md` delivers `docs/superpowers/specs/2026-10-05-mattpocock-skills-install-matrix.md`; R4's matrix is corrected from it before anything below runs.
- [x] `app/src-tauri/src/agent_skills.rs` (renamed from `superpowers.rs`): `agent_skills_status(root)` and `agent_skills_install(root)` Tauri commands driven by the finalized matrix, subprocesses in `git/run.rs`'s shape (argv array, timeout, pipes drained on threads). Status returns `{ state, detail, command, output }`; unit tests parse recorded fixture output per detector.
- [x] Claude Code detection/install: `claude plugin list --json` in the workspace root, id `mattpocock-skills@*`, any scope, `enabled: true`; install `claude plugin install mattpocock-skills --scope project -y`, stderr surfaced verbatim in the drawer.
- [x] CLI-route detection/install: `skills-lock.json` `source: "mattpocock/skills"` entries + profile skill dir present; install `npx skills@latest add mattpocock/skills --skill '*' -a <agent id> -y` (plus `--copy` if the spike says Windows needs it), output drawer interleaving stdout and stderr.
- [x] Machine-local marker: dropped for known profiles (files travel with the repo; the plugin detector is machine-true), kept for custom profiles' "I've installed it" and for the R2 farewell note's targeting and dismissal.
- [x] `app/src/lib/agents/agentSkills.ts` + tests (renamed from `superpowers.ts`): the pure model — `verified` / `asserted` / `absent` / `unavailable(reason)`, the per-profile copy command (custom profiles), and `agentSkillsDone()`.
- [x] Rename every Superpowers surface: `AgentSkillsStep.svelte` (wizard, same position, new explainer copy per R6), `AgentSkillsControls.svelte` shared behind wizard and Settings, Settings → Agent row with green LED (asserted visually distinct), Home banner's "N of 5" logic, agent-change and agent-arm wizards. Grep for `superpower` case-insensitively across `app/` when done: zero hits outside this plan's docs and the farewell note's copy.
- [x] R2 farewell note in Settings → Agent: shown only where the marker records a Superpowers install/assertion/skip, dismiss-once recorded in `config.json`.
- [x] CONTEXT.md: *Agent tooling* entry's example becomes Matt Pocock's skills.
- [x] `cargo test --workspace` and `cd app && npm test && npm run check && npm run build` green; smoke checklist items updated: wizard step, settings row, farewell note appears and dismisses.
- [x] Decision: The CLI route's `--skill '*'` installs 38 skills (adds upstream's in-progress/ and misc/, e.g. migrate-to-shoehorn, scaffold-exercises), not the plugin's 27. I shipped '*' as R4 decided; keep it, or pin the plugin's 27 names (exact parity, but the list rots when upstream changes it)?
  Options: A) Keep '*' (38) B) Pin the plugin's 27
  Answer (2026-10-06): Keep '*' (38)
- [ ] Human test: Init wizard on a fresh repo with Claude Code: the third step reads "Matt Pocock's skills" (stepper label fits), Install turns the LED filled green, and Not now finishes the step without nagging on Home
- [ ] Human test: Settings → Agent on a workspace switched to Codex (or Gemini/opencode/Cursor): the Matt Pocock's skills row offers Install, it runs npx skills, the drawer output is readable (no escape codes), and the LED turns green; a custom profile shows the command to run plus "I've installed it" and a hollow LED after
- [ ] Human test: Settings → Agent on a workspace this machine once answered the old Superpowers step for: the farewell note shows once, Dismiss hides it and it stays gone after reopening Settings; a workspace that never had a Superpowers answer shows no note

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
