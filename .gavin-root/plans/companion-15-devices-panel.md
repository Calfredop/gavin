---
order: 17408
kind: task
title: Companion 15: Devices panel at the desk
status: To Do
labels: ready-for-agent
parent: companion.md
complexity: moderate
---
Blocked by: companion-05-hello-connection-kind.md, companion-11-connect-ik-unlock.md

Part of `companion.md`. Read the spec (section "The desktop app") and `CONTEXT.md` first.

## What to build

- **The footer row.** A "Devices" row in the sidebar footer, beside the app-level rows, opens a Devices app panel.
- **The panel** holds pairing (QR and code), the Device list with connected or last-seen state, Revoke, and Revoke all.
- **Settings is trimmed.** Pairing and the Device list move out of Settings' remote-access section, which keeps only the switch plus the Relay and push configuration.
- **The badge.** The footer row's badge counts connected Devices.

Logic goes in a pure module, and the `.svelte` file stays thin. Surfaces that need a newer daemon get a `FEATURE_MIN_VERSION` entry and a `featureBlockedReason` consumer.

## Acceptance criteria

- [ ] Unit tests: the pure module computes the panel and the badge from Device state
- [ ] Settings no longer shows pairing or the Device list
- [ ] A static check: grep the committed source for the new footer row and panel strings

When done, file a human test: pair the test Device from the panel, see the badge count it as connected, then Revoke it and see it drop.
