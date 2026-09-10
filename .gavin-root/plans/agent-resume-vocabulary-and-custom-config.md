---
kind: task
title: Resume vocabulary per agent profile, plus a configurable custom resume flag
parent: feat-agent-session-name-mcp.md
complexity: complex
---
Read `.gavin-root/plans/feat-agent-session-name-mcp.md` (the parent plan) and
`app/src-tauri/src/agent_setup.rs`'s `AgentProfile` struct and the
`AGENT_PROFILES` table (claude-code / codex / gemini / cursor / opencode /
custom) before touching anything — especially the doc comments on
`session_id_args` and `resume_args`, and the
`conversation_resume_argv_is_all_or_nothing_per_profile` test.

**The gap.** That invariant assumes the only way to get a resumable
conversation id is gavin minting one at launch. It is not: codex, gemini and
opencode each generate their own session id that the caller cannot fix, but
each can be resumed by that id once it is known (the sibling card
"Agent self-reports its own session id over MCP" adds the mechanism to learn
it). Doc research — **not yet verified against the real binaries** — found:

- codex: `codex resume <id>`; the id is the file name of the newest
  `~/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl`.
- gemini: `gemini --resume <uuid>`; the id is embedded in the newest file
  under `~/.gemini/tmp/<project_hash>/chats/`.
- opencode: `opencode run --session <id>`-family flags; the id is the newest
  file under `~/.local/share/opencode/storage/session/<projectHash>/`.
- cursor: excluded — gavin's `cursor` profile takes no prompt and never goes
  through the headless resume path.

Verify each discovery command and resume flag against the actually installed
CLI before committing to it, the same way `session_id_args` / `models` /
`failure_patterns` rows elsewhere in this file were verified by running the
binary rather than trusting documentation. A wrong discovery command reports
the wrong id (or nothing); a wrong resume flag puts garbage in the agent's
argv. Leave a row's `resume_args` empty rather than guess if a CLI does not
check out — empty is the honest, existing default for an unverified
convention in this file.

Steps:

- Add a new `AgentProfile` field, e.g. `pub session_id_discovery: &'static
  str` — a shell one-liner the naming skill will run to find the agent's own
  newest session id. Empty where unverified or not applicable, matching every
  other field's empty-by-default posture in this struct.
- Fill in `resume_args` for whichever of codex/gemini/opencode check out.
- Rewrite `conversation_resume_argv_is_all_or_nothing_per_profile` (and its
  doc comment) to the real invariant: `resume_args` must be empty unless
  EITHER `session_id_args` (mint) OR `session_id_discovery` (self-report) is
  set — a profile may resume via a minted id, a self-reported id, or not at
  all, but never claims resume with no way to ever get an id.
- Extend `AgentProfileDto` and `agent_profiles()` with the new field,
  camelCase, matching the existing serialization pattern; add its guard test
  alongside `prompt_args_is_set_only_where_the_convention_is_verified`.
- Custom profile's resume flag: add `custom_resume_args: Option<String>` to
  **both** `AppConfig` (app-wide default) and `WorkspaceConfig` (per-workspace
  override, threaded through `persist_workspaces`) in `config.rs` — copy
  `terminal_font_size`'s exact shape (`None` = absent/inherit, workspace value
  wins when set). This is deliberately the config.json app-default +
  workspace-override pattern, not the `.gavin-root/config.toml` `[agent]`
  table that `file` / `mcp_file` / `mcp_format` use — those have no app-wide
  layer at all, and the human asked specifically for one here.
- Wire the resolved value (workspace override, else app default, else empty)
  into wherever `custom`'s `resume_args` gets read at runtime alongside its
  other resolved fields.

Tests: the rewritten invariant test; a guard test for the new discovery
field; roundtrip + override-wins + absent-falls-through tests for
`custom_resume_args` mirroring `terminal_font_sizes_roundtrip_and_default_to_absent`.

Out of scope — leave for the sibling cards under the same parent: do not
touch `gavin-mcp`, the protocol, or any skill/prompt wording. State in your
final message (or commit body) the exact field names you landed on
(`session_id_discovery`, `custom_resume_args`, etc.) — the third sibling card
consumes them by name and cannot guess.

Verify: `cargo test --workspace`, `cd app && npm run check` (DTO field
naming).

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
