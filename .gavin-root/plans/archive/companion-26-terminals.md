---
order: 25600
kind: task
title: Companion 26: terminals on the phone
status: Done
labels: ready-for-agent
parent: companion.md
complexity: complex
---
Blocked by: companion-23-served-signed-ui.md, companion-01-typing-prototype.md

Part of `companion.md`. Read the spec (section "The Workstation UI bundle", the typing point), ticket 01's findings, and ADR 0005 first.

## What to build

In the Companion bundle, sharing responsive components with the desktop:

- the sessions list and a live terminal view, on xterm.js 6.1 for touch scrolling;
- typing per ticket 01's outcome: a compose field with quick replies derived from the turn verdict, plus a raw mode with a special-key row, unless ticket 01 changed that;
- killing a session and opening a new one.

Extend the Demo Workstation with sessions.

## Acceptance criteria

- [x] Seam 2 tests: compose sends the line plus Enter, quick replies come from a verdict, and raw-mode keys map to the right bytes
- [x] The desktop's terminal surfaces still pass their suites (upgrading xterm touches the desktop too)

When done, file a human test: on a phone, answer a waiting agent with a quick reply, then type in raw mode, and scroll back through the history.

## Progress (branch companion/phone)

- [x] xterm 6.1.0-beta.304 with addon-fit 0.12.0-beta.301 and addon-web-links 0.13.0-beta.301, pinned exact; desk suite, check and build unchanged (the same 2 pre-existing failures before and after)
- [x] Pure modules: typing bytes (compose, raw keys, sticky Ctrl), quick replies gated by the verdict, session rows
- [x] View state: a Sessions surface beside the Board, a terminal open in it; an inbox item naming a session lands on its terminal
- [x] Demo Workstation: sessions with screens and history that answer typing, open and kill
- [x] Surfaces: sessions list, terminal (the desktop's TerminalPane) with the compose/raw dock, kill and new session
- [x] Seam 2 suites at the wire; companion test, check and build; desk suites
- [ ] Human test: On an iPhone, open the Demo Workstation (the Companion shell built from companion/phone, or `cd app && npm run companion:dev -- --host` opened in Safari): atlas-api → Sessions → "session store", answer its menu with a quick reply; then tap the keyboard button, type `ls` and Return in the Scratchpad's shell, run `seq 1 300`, and touch-scroll back through the history (the Latest pill brings you back); the compose field and keys stay above the soft keyboard throughout.
- [ ] Human test: On an Android phone (ticket 01 only ran on an iPhone), repeat the same run: answer "session store" with a quick reply, type in raw mode with the latched Ctrl (Ctrl then c clears the line), and touch-scroll the Scratchpad shell's history after `seq 1 300`.

## Notes (2026-09-30)

Uncommitted in the companion-phone worktree; the rail's commit step after this card takes it. `app/companion/README.md` ("Terminals") has the whole of it.

- Checks: companion 394/394, check 0 errors, build ok. Desk `npm test` 7361 passed with the same 2 failures as before any change (`remoteAccessSurfaces` "forwards the three device pushes", `mainThreadCommands` forwarding.rs:376); desk check 0 errors, build ok. Shell suites 241/241; `companion-shell:check` has 1 error in `bundle.e2e.ts:182` (a cast in companion-23's test, untouched here).
- The seam suite (`seam/typing.test.ts`) drives the dock's own send functions against the Demo Workstation, with a real xterm fed from the wire as the phone's screen, and reads `write_input` at the wire.
- Desk change: `terminalRegistry.setInputTransform` (the latched Ctrl reaches the soft keyboard's typing in the one place a terminal's typing is sent). The desk never sets one. Tested in `terminalRegistry.test.ts`.
- The verdict: the desk keeps its verdicts in its own webview, so the phone asks for its own through the desk's driver (all its gates stand), for the session on screen only. A list row shows a prose question as waiting once its terminal has been opened on the phone.
- Traffic: `pty-output` carries every session's output, per Workstation. The phone lets a terminal go when it leaves it, so one listener at most; narrowing the event per session is a protocol change of its own.
- A session started from the phone is placed as a desk tab by companion-16 (presence), which is on companion/wire and not in this branch; until then the phone lists it under "Started from this phone".
- Wheel scrolling could not be exercised by the browser harness (its scroll does not reach xterm 6.0 or 6.1 alike); touch scrolling is the human test's.
