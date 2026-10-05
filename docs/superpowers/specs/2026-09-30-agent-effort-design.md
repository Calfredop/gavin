# Agent Effort — Design

**Status:** implemented 2026-09-30 (card `[feat] effort handling`).

**Goal:** every place gavin lets a human say which model an agent runs at
also lets them say how hard it thinks — the app-wide default per profile,
the workspace, the custom agent, the complexity tables, a card's own
override, and (through the per-profile default) the fallback chain. Each
picker offers the levels the agent's own CLI documents, plus Custom….

---

## 1. Scope

**In:** an `effort` beside every `model` the agent config already has; the
flag that carries it (`effort_flag`, per profile in the Rust table and
hand-written for `custom`); the preset levels; composing it onto
`launchCommand`; the compat gate for the daemon half.

**Out:** per-candidate effort in best-of-N and critical review (a candidate
on the workspace's profile keeps the workspace's effort, one on another
profile gets that profile's app-wide default — the same rule the model
follows when a candidate names none); an effort control in the init wizard;
reading a CLI's effort list at runtime.

## 2. Decisions

Continuing the log from `2026-08-25-agent-default-model-design.md`
(D58–D63).

- **D64 — Effort follows the model, field for field.** It is the same kind
  of fact — a flag on the agent's command that changes what a turn costs —
  so it sits wherever `model` sits and inherits the way `model` inherits:
  the card's own line, else its complexity level's, else the workspace's
  `[agent] effort`, else the app-wide default for the RESOLVED profile,
  else nothing (the CLI's own default). Per D60 the workspace value is a
  project fact in `config.toml`, and per D59 the app-wide one is a map keyed
  by profile id, because `max` is noise to Codex.
- **D65 — The app-wide half rides `AgentDefaults`.** `agentEfforts` and
  `customEffortFlag` live in `config.json`'s `agent_defaults`, saved
  wholesale by `setAgentDefaults` — not a new `persist_workspaces`
  positional and not two new Tauri commands. `actionPromptOverrides`
  already made that call for the same reason.
- **D66 — `effort_flag` is a flag, and a trailing `=` attaches.** The two
  verified shapes differ: `claude --effort high` takes the level as the next
  argument, `codex -c model_reasoning_effort=high` attaches it. One string
  describes both — the `headless_args` convention in the same table: a
  flag ending in `=` is concatenated with the level, anything else is
  separated by a space. A custom agent's hand-written flag follows the same
  rule, so the user can express either.
- **D67 — Presets are the levels each CLI documents, verified by running
  it.** 2026-09-30:

  | profile | `effort_flag` | `efforts` | source |
  |---|---|---|---|
  | `claude-code` | `--effort` | low, medium, high, xhigh, max | `claude --help`, 2.1.285 |
  | `codex` | `-c model_reasoning_effort=` | minimal, low, medium, high, xhigh | Codex config reference (no local binary) |
  | `gemini` | — | — | no flag; thinking budget lives in `settings.json` |
  | `cursor` | — | — | effort is a bracket parameter of the model id (`model[effort=high]`), so the model's Custom… box is the route |
  | `opencode` | — | — | `--variant` exists only on `opencode run`; the TUI gavin launches has none |
  | `custom` | configurable | — | the user's own binary |

  An empty flag hides every effort control for that profile, the posture
  `model_flag` takes (D62): a guessed flag lands in somebody's argv.
- **D68 — An effort-only attribution keeps the workspace's model.** A
  complexity row or a card naming ONLY an effort means "the workspace's
  agent, thinking harder" — it must not also drop the workspace's pinned
  model back to the app-wide default. So an attribution that names no
  profile keeps the workspace's model and effort for whichever half it
  leaves empty. One that names a profile keeps today's rule: an empty
  model or effort means that profile's own default, and a different
  profile is the clean switch.
- **D69 — A flag that is not inert is dropped, not composed.** The model
  flag is appended unquoted, which is fine for a verified table value and
  not for a string from a cloned repo's `config.toml`. The effort flag is
  refused outright when it carries a shell-special character; the level
  itself is quoted exactly as a model name is.

## 3. Storage

```toml
# .gavin-root/config.toml
[agent]
profile = "claude-code"
model   = "opus"
effort  = "high"          # new; absent = the app-wide default for the profile
effort_flag = "--think"   # new; for `custom` only
```

```jsonc
// config.json, agent_defaults
{
  "customEffortFlag": "--think",
  "agentEfforts": { "claude-code": "high", "codex": "medium" },
  "complexity": { "intricate": { "profile": "", "model": "opus", "effort": "max" } }
}
```

A card: `effort: max` in its frontmatter, beside `agent:` and `model:`.

## 4. Compatibility

`PROTOCOL_VERSION` 55 → 56. No new Request variant: `AgentConfig` gains
`effort` and `effort_flag`, `PlanFileInfo` gains `effort`, and
`SetRootConfigField` / `SetPlanFrontmatterField` accept the new keys — all
widenings `min_version_for` cannot see. `FEATURE_MIN_VERSION.agentEffort = 56`
is consumed by every surface that writes a daemon-side effort: the workspace
Effort and Effort-flag rows and the card's Effort picker. The app-wide
panel and both complexity tables write `config.json` and work against any
daemon. `gavin_set_plan_field` accepts `effort` too.

The branch `companion/wire` also sits past main's 55 (it claims 56–58); the
two renumber when they meet, as the Device wire already did once.

## 5. Surfaces

- **Settings ▸ Agent defaults** — an Effort block under the model rows, one
  picker per profile with a flag (inherit, the CLI's levels, Custom…).
- **Settings ▸ Custom agent** — an Effort flag box beside Model flag.
- **Settings ▸ Complexity** and a workspace's **Complexity** — an effort box
  per level, suggesting the named profile's levels (every profile's, when
  the row names none).
- **Workspace Settings ▸ Agent** — an Effort picker under Model, and an
  Effort flag box for a custom agent; "Launches as" shows the result.
- **A card** (detail modal and Plans strip) — an Effort picker beside Agent
  and Model, with the inherited level on its inherit row.
- **Fallback chain** — no control of its own: each agent in the chain
  launches at its app-wide model and effort.
