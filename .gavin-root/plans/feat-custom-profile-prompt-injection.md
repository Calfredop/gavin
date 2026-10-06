---
order: 15360
title: [feat] MCP-ready prompt injection for custom profiles
status: To Do
---
The kimi integration (feat-kimi-integration.md, K3) introduces a "MCP initialize = agent ready" callback: gavin-mcp signals the daemon when a session's agent has connected, and the daemon writes the queued card prompt into the PTY. That mechanism is profile-agnostic.

Custom profiles (`config::CustomProfile`) today have `prompt_args: None` — they cannot run cards visibly at all (`buildRunCommand` returns null). The same injection gives every custom profile visible card runs, as long as the agent loads gavin's MCP server (which the integration writer already arranges where the custom profile declares an MCP layout).

Depends on: feat-kimi-integration.md landing the mechanism. This card is the generalization, not the spike.

## Steps

- [ ] Confirm the K3 mechanism landed and is keyed on profile-agnostic data (session id + MCP handshake), not on anything kimi-specific.
- [ ] Custom profiles whose agent connects gavin MCP: compose visible card runs as launch-without-prompt + queued injection (same path as kimi).
- [ ] UI copy: the `noPromptReason` blocker for custom profiles distinguishes "agent doesn't take prompts and never connects gavin MCP" (still blocked) from "prompt arrives on MCP handshake".
- [ ] Smoke: a custom profile running a card visibly with the prompt arriving via injection.
