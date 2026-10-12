---
order: 26624
kind: task
title: Companion 27: board and cards on the phone
status: Done
labels: ready-for-agent
parent: companion.md
complexity: complex
---
Blocked by: companion-23-served-signed-ui.md, companion-16-presence-and-phone-sessions.md

Part of `companion.md`. Read the spec (section "The Workstation UI bundle") first. Mind the traps in `CLAUDE.md` on nested-task status (always go through `effectiveStatus`) and on Svelte 5 proxies.

## What to build

The board, made responsive in the bundle, with every card action:

- move cards, tick checklist items, file and rename cards;
- **Run card**: the session opens as a labelled tab at the desk (ticket 16);
- answer decisions, and pass or fail human tests;
- archive, and read the PRD.

Extend the Demo Workstation to match.

## Acceptance criteria

- [x] Seam 2 tests for each action's channel traffic
- [x] The desktop board's suites still pass

When done, file a human test: from the phone, run a card and see a labelled tab at the desk; then pass a human test from the phone.

## Plan

- [x] Desk seams: card launches take a host (desk places and queues, a Device records and refuses), archiving takes its own ender
- [x] Demo Workstation: card files on its disk, the tree read off them, and the card commands a board and a card send
- [x] Phone state: open a card or the PRD over the board, card actions through the desk's own modules
- [x] Phone surfaces: tap a card, the card page (bar, move, rename, checklist, decisions and tests, archive), new card, the PRD
- [x] Seam 2 suites for each action's traffic; desktop and companion suites, check and build green
- [x] README, then the human test
- [ ] Human test: From the phone, run a card and see a labelled tab for it at the desk (needs companion/wire's companion-16 in the build); then pass a human test from the phone

## Comments

**2026-09-30, done (uncommitted on `companion/phone`).** A card opens as a page over the phone's board, with every action the desk's own module: move (the drag's nested-task question), rename, tick, answer/pass/fail (the Decisions tab's `answerHumanItem` and its row), archive/restore, new card (the composer's args, pre-reviewed, placed at the column end), the PRD, and Run/Resume/Re-launch through `cardRunActions` with a `CardLaunchHost` the Device hands in (`DEVICE_LAUNCH_HOST`): it jumps in the phone's own terminal, refuses rather than queues, and leaves placing the tab to the desk (companion-16). `executeArchive` takes an ender, so archiving from away kills the card's agents but leaves the desk's tabs to the desk. The Demo Workstation's cards are now files it parses and writes the daemon's way (`demo/cardFiles.ts`, `demo/cardCommands.ts`). `seam/cards.test.ts` reads each action's traffic.

- Desktop suites: 2 failures, both pre-existing and in files this card does not touch (`mainThreadCommands` on forwarding.rs's mock builder; `remoteAccessSurfaces` grepping `emit("device-…"`). See the memories on companion/wire.
- Not done from the phone: several agents, Develop, ending an orphan, labels/priority/complexity edits, delete, promote. They stay at the desk.
- The labelled tab itself is companion-16's, on `companion/wire` and not on this branch: until both branches meet, a phone-run card's session is on the Agents page unlabelled.
