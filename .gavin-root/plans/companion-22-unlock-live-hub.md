---
kind: task
title: Companion 22: the Unlock and a live Workstations hub
status: To Do
labels: ready-for-agent
parent: companion.md
complexity: complex
---
Blocked by: companion-21-shell-pairs.md, companion-14-attention-request.md

Part of `companion.md`. Read the spec (sections "The Device's keys and the Unlock" and "The Companion shell"), ADR 0004 and ticket 02's findings first.

## What to build

**The Unlock (ADR 0004):**
- One biometric or passcode authentication, when the Companion comes to the foreground, unlocks the connections to every paired Workstation.
- The Unlock ends when the app goes to the background or the phone locks. Control Center and call banners do not end it.
- Reconnects while the app is in front do not prompt, using ticket 02's parameters.

**The live hub:**
- Each Workstation shows its state: ready, desktop app not running, or asleep (inferred from the Relay).
- The combined attention inbox gathers every Workstation's attention request, each item labelled with its Workstation.
- Tapping an item opens its Workstation. Landing on the exact target arrives with ticket 23.

## Acceptance criteria

- [ ] Pure-module tests for the Unlock lifecycle and for merging the inbox
- [ ] A Workstation that is unreachable, or whose desktop app is not running, shows that state and adds nothing to the inbox

When done, file a human test: unlock once and see two Workstations connect; background the app and see it locked; open Control Center and see it still unlocked; drop the network and see it reconnect without a prompt; the inbox shows items from both Workstations, labelled.
