---
kind: task
title: [orch-nested] skills: develop proposes children:, agents tick their line
parent: feat-plan-orchestrates-nested-tasks.md
complexity: simple
---
Read the parent card `feat-plan-orchestrates-nested-tasks.md` and `docs/adr/0012-a-nested-task-finishes-by-its-tick.md`.

Edit the EMBEDDED skill sources in `app/src-tauri/src/` (e.g. `gavin_develop_skill.md`, and the gavin skill's source beside it), not the installed copies:
- gavin-develop: when developing gives a card nested tasks, propose `children: sequence` (or `parallel` when the tasks are independent of each other) in the same proposal, and after approval write it with `gavin_set_plan_field`. Say that `gavin_promote_task` never sets it.
- gavin: in its nesting paragraph, an orchestrated plan's nested tasks finish by `gavin_tick_item`, never by a status.

Then refresh this checkout's installed copies (`.claude/`, `.agents/`, `.cursor/`, `.gemini/`, `.kimi-code/`, `.opencode/` skills) the way the app's install step does, and check every installed copy matches its embedded source. `cargo test -p` for the src-tauri crate if it asserts on the embedded text.

## Done (2026-10-29)

`gavin_develop_skill.md`: a "How the children run: `children:`" section (sequence by default, parallel only for independent tasks, none for one agent; `gavin_promote_task` never sets it), the mode in the proposal, a write step (`gavin_set_plan_field(path, "children", …)`) and the read-back. `gavin_skill.md` §3: an Orchestrated plan's nested tasks finish by `gavin_tick_item`, never by a status. All six installed copies (`.claude`, `.agents`, `.cursor`, `.gemini`, `.kimi-code`, `.opencode`) of both skills rewritten from the embedded sources with `{prd}` → `.gavin-root/PRD.md`, and each verified byte-equal. `cargo test --lib agent_setup` green.
