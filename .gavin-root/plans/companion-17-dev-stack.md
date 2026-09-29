---
order: 19456
kind: task
title: Companion 17: local dev stack and dev-build guard
status: To Do
labels: ready-for-agent
parent: companion.md
complexity: moderate
---
Blocked by: companion-10-pair-through-relay.md, companion-07-push-gateway.md

Part of `companion.md`. Read the spec (section "The desktop app", the dev-build point) first.

## What to build

- **The dev stack.** One `docker compose` command starts a local Relay and a sandboxed Push gateway, for developing the Companion end to end. The sandboxed gateway never contacts Apple or Google.
- **The guard.** A dev (debug) desktop build may turn on remote access only against a Relay on loopback or the LAN. Any other Relay URL is refused. This relaxes 05's open question 12.
- **Documentation** in the dev setup docs.

## Acceptance criteria

- [ ] The compose stack starts both services, and is documented
- [ ] A dev build refuses a public Relay URL, while a release build accepts it (tested)
- [ ] The sandboxed gateway makes no outbound calls to Apple or Google
