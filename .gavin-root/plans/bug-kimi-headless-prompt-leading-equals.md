---
title: [bug] kimi headless runs receive their prompt with a leading "="
status: To Do
priority: low
attachments: app/src-tauri/src/agent_setup.rs, app/src/lib/cards/cardRun.ts
complexity: simple
---
## Symptom

kimi-code's `headless_args` is `-p=`, and `buildHeadlessCommand` attaches the quoted prompt to it: `kimi -p='Commit uncommitted work…'`. kimi parses `-p=…` as the short option `-p` with the value `=Commit…`. The model therefore receives a prompt that starts with a stray `=`.

Evidence: ~/.kimi-code/sessions/wd_dpphm_2a4a81596ad5/session_860128f9-…/agents/main/wire.jsonl (2026-10-08 18:38, the headless commit run). Its `turn.prompt` text begins `"=Commit uncommitted work in this checkout."`.

Harmless so far (the model ignores it), but every headless kimi prompt is one character wrong.

## Steps

- [ ] Verify against kimi 2.1.1 which spelling delivers the prompt verbatim. Candidates: `-p'<prompt>'` (short option, value attached with no `=`), `--print=…` / `--prompt=…` if a long form exists, or `-p '<prompt>'` with a prompt that cannot start with `-`. Note on the profile: the separated `-p -- '<prompt>'` form was verified NOT to work (2026-10-05).
- [ ] Update `headless_args` for kimi-code in agent_setup.rs, and `buildHeadlessCommand`'s shape rule in cardRun.ts if the new spelling is neither ` --` nor `=`.
- [ ] Keep `headless_rows_are_the_verified_set_and_well_formed` honest about the new shape.

Found while fixing bug-rail-card-steps-kimi-headless.md.
