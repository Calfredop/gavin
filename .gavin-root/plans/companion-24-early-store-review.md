---
kind: task
title: Companion 24: early store review
status: To Do
labels: ready-for-human
parent: companion.md
complexity: moderate
---
Blocked by: companion-23-served-signed-ui.md

Part of `companion.md`. Read ADR 0005's "Store compliance" section and the store research (`docs/research/2026-09-27-app-store-downloaded-code.md`) first.

## What to build

**Mostly the owner's work:** developer accounts, signing and App Store Connect. An agent prepares everything else, and can use `/wizard` for the steps only a human can do.

- **Submit** the first end-to-end build (ticket 23) for **full App Store review with manual release**. Approval publishes nothing. Also submit it to Play internal testing.
- **Write the review notes:**
  - the UI is served by the user's own desktop and signed by the publisher;
  - the built-in Demo Workstation is for reviewers, with no account and no pairing;
  - the store description covers terminals, board, git, files and settings.
- **Record Apple's response on this card.** If it is a rejection, file the fallback against ADR 0005.

## Acceptance criteria

- [ ] Both submissions are made, with the review notes
- [ ] The outcome is recorded here
- [ ] ADR 0005 is updated if Apple's answer changes it
