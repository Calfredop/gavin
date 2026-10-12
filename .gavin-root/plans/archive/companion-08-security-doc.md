---
kind: task
title: Companion 08: security design pass 06-companion
status: Done
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

- [x] 06 is written, and every ADR is cited where it applies
- [x] 05 carries the pointer header, and its pairing ceremony and trust-store sections are marked as still standing
- [x] Open questions are listed at the end

## Outcome

`docs/security/06-companion.md` (branch `companion/desk-prep`, uncommitted), with the pointer header and one-line markers in `05-remote-access.md`, and a row for 06 in `docs/security/README.md`.

- **The four supersessions** are mapped in 06 §1 against every section of 05, including the ones the card did not name but the spec and ADRs also change (§1's "cannot spawn", §4's `remote` row, §8's stolen-phone and grant paragraphs, §9's "three columns", §11).
- **The §1 correction was checked in the code:** card prompts are composed by `composeTaskPrompt` and `composePlanPrompt` in `app/src/lib/cards/cardRun.ts` and launched by `cardRunActions.ts`; the host's `compose_agent_prompt` serves only the wizard flows (`prd`, `agent-file`). 05's "Run lands behind a desktop confirmation" argument is retired in 06 §2.
- **Nine threats:** the six the card names (CT-1..CT-6) plus CT-7 (a script in the desk's page pairing a Device, which is companion-31's threat, so its last criterion is met by 06), CT-8 (the forwarding seat) and CT-9 (a dev build meeting a real Device). Each cites its 00 adversary, surfaces and AD, DP, AS, SC entries; S12 is cut into S12.a–f for the citations.
- **06 §5.8 lists thirteen additions beyond the spec and ADRs** for the owner to accept or strike. The ones most worth a look: an **event table** beside the command table (the spec gates commands only, and every desk event is offered to subscribed Devices); the dispatcher must **not route through Tauri's IPC**, or `plugin:*` commands (updater, opener) become reachable; the hardware key signs a **domain-separated** handshake hash; a release daemon must refuse **`software-debug` rows on every connection**, because `devices.sqlite` is shared between dev and release daemons; a stolen phone's response is **Revoke all**, not Revoke, because the Remote role can read the daemon's key.
- **Open questions:** sixteen, at the end of 06, each with a default. Q1 (revoking a stolen phone away from the desk) and Q14 (whether the review gate and `[agent] command` should stay writable by a Device) are the two that change the security posture if the owner answers differently.
- **Not verified:** the doc is design, so no suite applies. The iOS notification fallback behaviour and the Secure Enclave's held-context behaviour are stated as device tests, not facts. 06 was written against the spike's amendments to ADRs 0001, 0004 and 0005, which are on `main` and not yet on this branch, so `docs/research/2026-09-28-companion-device-keys.md` resolves only after the merge.
