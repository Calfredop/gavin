---
kind: task
title: Companion 09: web bundle, bundle channel and Demo Workstation
status: To Do
labels: ready-for-agent
parent: companion.md
complexity: intricate
---
Blocked by: none (can start immediately)

Part of `companion.md`. Read the spec (sections "The Workstation UI bundle" and "The Companion shell"), `CONTEXT.md`, and ADRs 0003 and 0005 first.

## What to build

- **The bundle.** Create the Companion web bundle as a SvelteKit static build, in the repo's Companion web folder. It imports the desktop's components and logic modules directly. Its build aliases replace the Tauri core and event modules with a remote shim, so the desktop's backend module is used unchanged.
- **The channel.** Define the bundle channel: a closed, versioned message set covering invoke and result, listen, event and unlisten, a capabilities query, opening an external link, and returning to the hub.
- **The Demo Workstation.** Build the Workstation side of the channel, answering with sample data.
- **Rules.** The Companion keeps its own view state, never calls a layout-saving command, and **never starts the rail scheduler**.
- **First surface.** The workspace list and one workspace's board, read-only, laid out for a phone.

Traps:
- `layoutState`'s bootstrap calls many commands, so the demo must answer them.
- A module-level derived over a `layoutState` export breaks every suite that partially mocks it; build such things lazily.

## Acceptance criteria (seam 2: vitest against the Demo Workstation)

- [ ] invoke and listen round-trip through the channel
- [ ] A test proves no layout-saving command is ever sent
- [ ] A test proves the rail scheduler never starts
- [ ] The capabilities query lets a bundle degrade on an unknown message type
- [ ] The bundle builds and runs in a desktop browser against the Demo Workstation
- [ ] The desktop's own suites still pass (`npm test`, `npm run check`)
