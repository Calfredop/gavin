---
order: 1088
title: [feat] MCP-ready prompt injection for custom profiles
status: Done
---
The kimi integration (feat-kimi-integration.md, K3) introduces a "MCP initialize = agent ready" callback: gavin-mcp signals the daemon when a session's agent has connected, and the daemon writes the queued card prompt into the PTY. That mechanism is profile-agnostic.

Custom profiles (`config::CustomProfile`) today have `prompt_args: None` — they cannot run cards visibly at all (`buildRunCommand` returns null). The same injection gives every custom profile visible card runs, as long as the agent loads gavin's MCP server (which the integration writer already arranges where the custom profile declares an MCP layout).

Depends on: feat-kimi-integration.md landing the mechanism. This card is the generalization, not the spike.

## Steps

- [x] Confirm the K3 mechanism landed and is keyed on profile-agnostic data (session id + MCP handshake), not on anything kimi-specific.
- [x] Custom profiles whose agent connects gavin MCP: compose visible card runs as launch-without-prompt + queued injection (same path as kimi).
- [x] UI copy: the `noPromptReason` blocker for custom profiles distinguishes "agent doesn't take prompts and never connects gavin MCP" (still blocked) from "prompt arrives on MCP handshake".
- [ ] Smoke: a custom profile running a card visibly with the prompt arriving via injection.
- [ ] Human test: In a scratch workspace, add a named custom profile with command `claude` and pick it as the workspace agent. With MCP config empty, the board's Run button is blocked and its tooltip names the MCP config file. Then set MCP config to `.mcp.json` (format: JSON — mcpServers), run the MCP integration, and approve the project server in Claude Code if it asks. Settings now says cards launch it bare and the prompt arrives once it connects gavin's MCP server. Run a card: the tab opens a bare `claude`, and within a few seconds the card's prompt is pasted in and submitted.

## Notes (2026-10-10)

- K3 is profile-agnostic: the daemon arms the hold for every spawned session (`server.rs` `awaiting_agent_since`) and any session-token Hello opens it (`note_agent_ready`); the 15 s grace falls back to ordinary idle delivery. No daemon or protocol change was needed.
- "Connects gavin MCP" is inferred from config, not a new setting: a named custom resolves `promptInjection: true` when the workspace names a usable `[agent] mcp_file` — the file gavin writes its own server into (`settings.ts` `resolveAgentConfig`, marked by `custom: true` on merged custom rows). An agent that never actually connects only costs the 15 s grace before idle delivery.
- The custom refusal (`noPromptReason(label, profileId)`) points at the MCP config file; Settings shows `promptRouteNote`. Only the injection-capable paths (board Run, develop, review, rail card steps, the setup wizard's main-agent start) use the custom sentence: best-of-N, clean-stale, code review and rail agent-tool steps take no injection (kimi included), so they keep the plain sentence. The wizard's start gained injection in feat-wizard-main-agent-prompt-injection.md.
