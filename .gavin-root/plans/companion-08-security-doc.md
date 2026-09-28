---
kind: task
title: Companion 08: security design pass 06-companion
status: To Do
labels: ready-for-agent
parent: companion.md
complexity: moderate
---
Blocked by: none (can start immediately)

Part of `companion.md`. Read the spec, ADRs 0001–0005, the store research, and `docs/security/00-threat-model.md` and `05-remote-access.md` first.

## What to build

Write `docs/security/06-companion.md`: a security design pass for the Companion that supersedes these sections of 05:

- §1: its claim that card-run composition happens in the Tauri host. It happens in the desktop webview.
- §6: the capability table, replaced by the command table.
- §8: key custody, per ADR 0001.
- §10: the phases, replaced by the spec's build order.

It must cover:

- **The threats:**
  - a stolen phone while unlocked;
  - a stolen key without the device;
  - a malicious Relay;
  - a compromised Workstation attacking the Device's other Workstations;
  - a malicious or unsigned bundle;
  - a compromised Push gateway.
- **The mechanisms:**
  - the Unlock;
  - the Remote role and the command table's policy;
  - bundle signing and the bridge-less webview;
  - end-to-end encrypted notifications;
  - the dev key and the dev-Relay guard.

Cite the threat-model ids from 00, and add a header to 05 pointing to 06.

## Acceptance criteria

- [ ] 06 is written, and every ADR is cited where it applies
- [ ] 05 carries the pointer header, and its pairing ceremony and trust-store sections are marked as still standing
- [ ] Open questions are listed at the end
