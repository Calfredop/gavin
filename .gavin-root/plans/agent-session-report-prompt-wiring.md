---
kind: task
title: Wire session self-report into the naming skill and card prompts
parent: feat-agent-session-name-mcp.md
complexity: moderate
---
Do this only after both sibling task cards under
`.gavin-root/plans/feat-agent-session-name-mcp.md` are done — it consumes the
exact MCP parameter name from "Agent self-reports its own session id over
MCP" and the exact `AgentProfile` field name(s) from "Resume vocabulary per
agent profile, plus a configurable custom resume flag". Read both finished
cards (and their diffs/commits) before writing anything here; do not guess
the names.

**The gap.** `NAME_TAB_FIRST` in `app/src/lib/cards/cardRun.ts` is one
constant, reused verbatim by every prompt composer and echoed in
`gavin_skill.md` and `.claude/skills/gavin/SKILL.md`. It needs to become
profile-aware: a profile whose new discovery field is non-empty gets an extra
instruction appended, telling the agent to run that discovery command and
pass the result as `gavin_name_session`'s new second argument; a profile
without one (including Claude Code, which already has a real id via minting)
keeps today's wording completely unchanged.

Steps:

- Change `NAME_TAB_FIRST` (or add a sibling function it delegates to) to take
  the resolved agent profile and build the instruction conditionally. Grep
  for every current call site of `NAME_TAB_FIRST` in `cardRun.ts` — confirm
  the exact count and composer names yourself rather than assuming it is
  four (`composeTaskPrompt`, `composeResumeTaskPrompt`, `composePlanPrompt`,
  `composeResumePlanPrompt`, and check whether `composeDevelopPrompt` also
  opens with it) and thread the profile through each one.
- Update the existing "name your tab" step in both `gavin_skill.md` and
  `.claude/skills/gavin/SKILL.md` to describe the optional second argument in
  the same prose style and level of detail already given to the first
  argument — these are read by a human and an agent, not just the MCP tool
  schema, so the wording has to stand on its own.
- Update whatever test currently pins `NAME_TAB_FIRST`'s literal text (search
  `cardRun.test.ts`) and the skill-file content assertions in
  `agent_setup.rs` (the ones checking specific phrases like "Finished work
  stays finished") so they cover the new conditional wording without
  regressing the existing one.

Out of scope: do not add or change any `AgentProfile` field, any protocol
field, or the MCP tool's own parameter list — this card only consumes what
the other two already shipped.

Verify: `cd app && npm test && npm run check && npm run build`.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
