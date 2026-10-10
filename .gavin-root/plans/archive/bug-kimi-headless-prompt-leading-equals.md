---
order: 31744
title: [bug] kimi headless runs receive their prompt with a leading "="
status: Done
priority: low
attachments: app/src-tauri/src/agent_setup.rs, app/src/lib/cards/cardRun.ts
complexity: simple
---
## Symptom

kimi-code's `headless_args` is `-p=`, and `buildHeadlessCommand` attaches the quoted prompt to it: `kimi -p='Commit uncommitted work…'`. kimi parses `-p=…` as the short option `-p` with the value `=Commit…`. The model therefore receives a prompt that starts with a stray `=`.

Evidence: ~/.kimi-code/sessions/wd_dpphm_2a4a81596ad5/session_860128f9-…/agents/main/wire.jsonl (2026-10-08 18:38, the headless commit run). Its `turn.prompt` text begins `"=Commit uncommitted work in this checkout."`.

Harmless so far (the model ignores it), but every headless kimi prompt is one character wrong.

## Steps

- [x] Verify against kimi 2.1.1 which spelling delivers the prompt verbatim. Candidates: `-p'<prompt>'` (short option, value attached with no `=`), `--print=…` / `--prompt=…` if a long form exists, or `-p '<prompt>'` with a prompt that cannot start with `-`. Note on the profile: the separated `-p -- '<prompt>'` form was verified NOT to work (2026-10-05).
  - 2026-10-10: `kimi --help` (2.1.1) lists `-p, --prompt <prompt>`. Two live runs of `kimi --prompt='…'`: `turn.prompt` in wire.jsonl carried the text verbatim both times, including a prompt starting with `-` (`"-x leading dash: …"`). The probe sessions were deleted afterwards.
- [x] Update `headless_args` for kimi-code in agent_setup.rs, and `buildHeadlessCommand`'s shape rule in cardRun.ts if the new spelling is neither ` --` nor `=`.
  - `headless_args: "--prompt="`. It still ends in `=`, so `buildHeadlessCommand` needs no change. The `-p=` mentions in the test doc and orchestrationState.ts's comment were updated to `--prompt=`.
- [x] Keep `headless_rows_are_the_verified_set_and_well_formed` honest about the new shape.
  - The test now asserts that an attached (`=`) flag is a LONG option. Mutation-checked: putting `-p=` back fails it with "kimi-code: attached flag `-p=` must be long -- a short one keeps the `=`". The agent_setup module (111 tests) and cardRun vitest (175) are green.

Found while fixing bug-rail-card-steps-kimi-headless.md.
