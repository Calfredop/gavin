---
order: 9216
kind: plan
title: opencode integration
status: To Do
---
search the web and adapt Gavin to work with OpenCode

## Decided (2026-09-01)

- **O1 — Full parity.** Every flow a Claude Code workspace gets, an opencode
  workspace gets: a card run that actually carries its prompt, the four gavin
  skills, commit-via-agent, and the step skills that ride on `skill_slot`.
- **O2 — Visible runs go through `--prompt`.** `opencode --prompt '<text>'`
  starts the TUI already seeded. The bare positional is a *project directory*,
  which is why every card run misfires today: `buildRunCommand` builds
  `opencode '<prompt>'` and opencode reads the prompt as a path.
- **O3 — Hidden runs go through `run --agent gavin-commit --`.** `--auto` is in
  opencode's docs but **not in the installed 1.3.13**, so there is no CLI-level
  permission grant to lean on.
- **O4 — The grant lives in a gavin-owned agent file**,
  `.opencode/agent/gavin-commit.md`, carrying
  `permission: { edit: deny, webfetch: deny, bash: { "*": deny, "git *": allow } }`.
  Not in the human's `opencode.json`: that would silently re-scope their own
  interactive sessions, and gavin writes nothing into someone else's config
  beyond the MCP entry.
- **O5 — Skills install to `.opencode/skills/<name>/SKILL.md`.** opencode reads
  `.claude/skills/` too, but a workspace that never chose Claude Code should not
  grow a `.claude/` directory. Gavin's four skill files already carry the
  `name` + `description` frontmatter opencode's validator demands, so they
  install verbatim.
- **O6 — The prompt-arg fix is general, not an opencode special case.**
  `buildRunCommand` ignores `promptArg` on *every* surface
  (`layoutState.ts:921`, `cardRunActions.ts:120,191`,
  `orchestrationState.ts:444,514`); only the wizard's "Ask the agent" checks it.
  **Cursor misfires identically today** — `cursor '<prompt>'` opens the prompt
  as a file path. One mechanism fixes both.
- **O7 — No protocol bump and no `FEATURE_MIN_VERSION` entry.** Agent profiles
  ride Tauri commands, not the daemon socket. Recorded so nobody adds one later.
- **O8 — Verification includes a real opencode run**, not just `--help` output.
  The binary is installed on this machine and authenticated.

## Steps

- [ ] The spike lands first ([argv, skill and agent conventions](./opencode-argv-spike.md)) — no row goes into the profile table on a convention it did not verify.
- [ ] `agent_setup.rs`: `prompt_arg: bool` becomes `prompt_args: Option<&'static str>` — `Some("")` bare positional (claude-code, codex, gemini), `Some("--prompt")` flagged (opencode), `None` no prompt at all (cursor, custom); `prompt_arg_is_set_only_where_the_convention_is_verified` asserts the whole column with its verification date.
- [ ] opencode's row gains `headless_args` from the spike; `models` stays empty (`provider/model` names rot — the table's existing rule). `only_claude_code_runs_headless_and_headless_rows_are_well_formed` asserts the *set*, keeping the "must take a prompt" and trailing-`--` invariants.
- [ ] opencode's `McpLayout.skills` gains the four gavin skills under `.opencode/skills/`; the `with_skills == ["claude-code"]` guard becomes the two-profile set. `skill_slot`, `compose_agent_prompt`'s on-demand step skills and `workspace_delete`'s gavin-prefixed sweep then follow for free — pin the last one with a test rather than trusting it.
- [ ] New writer for `.opencode/agent/gavin-commit.md`, overwritten wholesale like a `SkillFile` and written only for a profile that declares one; it joins `GavinInstall` so the Integration step lists it and the delete wizard removes it.
- [ ] `AgentProfileDto` → `backend.ts` → `settings.ts`'s `ResolvedAgent` carry `promptArgs`; `agentFlowAvailable` reads it instead of `promptArg`.
- [ ] `cardRun.ts`: `buildRunCommand(agentCommand, promptArgs, prompt)` returns **null** where the profile takes no prompt, so a mangled argv can never be launched; every call site passes it. Tests cover the flagged case and the Cursor case that misfires today.
- [ ] Every surface that can start a card says *why* when the profile takes no prompt — card run actions, Develop, Resume, orchestration steps — in `agentCommitBlocker`'s shape. Hang the reason on a non-disabled ancestor: a disabled element never fires `mouseenter`.
- [ ] `smokeChecklist.ts`: `wiz-agent-gate` is now wrong (opencode offers "Ask the agent"; only Cursor is absent). Add items for the seeded TUI, the four skills on disk, commit-via-agent, and the delete wizard listing the agent file.
- [ ] Live pass in a scratch workspace: init it on the opencode profile, start a card, confirm the prompt arrives and the `gavin_*` tools are callable from inside the session, then run commit-via-agent against a dirty scratch repo.
- [ ] `cargo test --workspace` and `cd app && npm test && npm run check && npm run build` green.
