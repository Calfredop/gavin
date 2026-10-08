---
order: 23552
title: Sessions worked by a Device lock for everyone else, with a take-over CTA and Device-to-Device hand-off
status: To Do
priority: high
attachments: docs/superpowers/specs/2026-09-27-companion-design.md,docs/adr/0003-companion-drives-the-desktop-app.md,docs/adr/0004-one-unlock-gives-full-control.md,CONTEXT.md,.gavin-root/plans/archive/companion-16-presence-and-phone-sessions.md,crates/daemon/src/presence.rs
complexity: intricate
---
Part of `companion.md`. Requested by the owner during `companion-iphone-smoke-tests.md`: a session that a paired Device is working on should show **locked** for everyone else, as a dropback overlay naming the Device and offering a call to action to take ownership back, and ownership must also move **between Devices** (a session an iPhone owns can be passed to an iPad).

## What exists today (read before designing)

- **Presence is an observation, not a claim.** `crates/daemon/src/presence.rs` reads each Device's forwarded commands and keeps `DevicePresence { workspace_id, typing: { session_id, at }, started[] }` in memory. `INPUT_COMMANDS` is `write_input`, `queue_input`, `send_queued_input`. The desk reads `typing.at` against `TYPING_FRESH_MS` (`app/src/lib/core/devicePresence.ts`) and shows a marker on the session's tab and the Devices panel row.
- **Nothing stops two writers.** `devicePresence.test.ts` has `typingBySession` returning `{ "desk-1": ["Pixel", "iPad"] }`: two Devices (and the desk) can type into the same session at once, and their keystrokes interleave in one PTY. The Companion's quick replies, the compose field, the Decisions answer and a card's Run all end in one of those three commands.
- **A Device started a session** → it opens at the desk as a tab labelled `<session> · <Device name>` (companion-16). That label says who started it, not who holds it now.
- **Trust model.** ADR 0004: one Unlock gives a Device full control except managing Devices. So this lock must be a **courtesy lock, not a security boundary**: any unlocked Device, and the desk, can always take over in one tap.

## The behaviour to build

1. **Ownership.** A session has at most one owner: a paired Device (by its device id) or nobody (the desk's default). Owning means "this is the writer".
2. **Locked state for non-owners.** Anywhere a non-owner shows that session's terminal (the desk's terminal tab, a Companion terminal on another Device), draw a dropback overlay: the live screen dimmed behind it, the owner's Device name ("iPhone di Cosimo is working on this"), how long since it last typed, and a primary CTA: **Take over** on a Device, **Take back** at the desk. Input from the non-owner is refused while locked, not just hidden.
3. **Device to Device.** iPad opens a session the iPhone owns: it sees the overlay and **Take over** moves ownership to the iPad. The iPhone gets a push and its terminal flips to the same locked overlay, now naming the iPad, with its own **Take back**. Also an explicit push: on the owner, **Hand over to…** listing the other paired Devices (and the desk), so a person can pass it deliberately.
4. **Take-over while the owner is typing.** If the owner typed within the last few seconds, the taker confirms first ("iPhone is typing right now. Take over anyway?"). Use the desk's `askConfirm` and a phone-sized equivalent; a `danger` choice keeps focus on the dismissing button.
5. **Release.** Ownership is released by: an explicit Release, the owning Device being revoked or refused (immediately), the session ending, and the owning Device going away (see decision 3).
6. **Every input path is covered.** Terminal typing, compose, quick replies, raw keys, the Decisions tab's answer, the attention inbox's quick replies, a card's Run/Resume and queued follow-ups either respect the lock or take over explicitly, and the UI says which. No path may write around it.

## Open decisions (settle with the owner first; recommendations in brackets)

1. **How does a session become owned?** [Implicitly: a Device that starts a session, or sends input to an unowned one, becomes its owner; the desk's own typing does NOT claim, so a desk-run agent is never locked just because a phone peeked at it. An explicit **Take control** also exists.]
2. **Do system writers respect the lock?** Rails, auto-resume, the follow-up queue, Best-of-N and `gavin_*` MCP calls write input too. [Exempt, because a rail that stalls on a phone's lock is worse than a stray line; but show a one-line notice on the overlay when the desk injected input.]
3. **What happens to ownership when the owner's Unlock ends (phone locks or backgrounds)?** [Keep for a short grace (about 30 s), then release to the desk, so a pocketed phone never strands a session. The CTA works at any time regardless.]
4. **Can a non-owner still read and scroll the terminal while locked?** [Yes. The overlay should not swallow scrolling or selection; dim the screen, replace the input dock with the lock bar, keep history scrollable. The owner asked for the overlay, so confirm this reading.]
5. **Does the desk have an owner role, and can a Device take a session from the desk?** [Yes: "owner = desk" is the default and Take over works from it, with the confirm in item 4 when the desk is typing.]
6. **Persist across a daemon restart?** [No. In memory like presence, reset to unowned on restart; sessions recover (orphan recovery) and the lock does not. Note the second daemon sharing the trust store cannot see it and has no need to.]
7. **Handing to a Device that is offline or locked.** [Offer only Devices with a live connection; a hand-over the target never sees would strand the session.]

## Protocol and compat (CLAUDE.md traps apply)

- New request/push variants on the wire: a claim/release/transfer request, and an owner-changed push to every connected client (desk windows and Devices). Take the next free `PROTOCOL_VERSION` and decide the `MIN_COMPATIBLE_VERSION` effect.
- The compat gate is per request TYPE. Do not widen `write_input` and friends with an `ownerDeviceId`; add new types, and give each a `FEATURE_MIN_VERSION` entry in `app/src/lib/daemonCompat.ts` AND a `featureBlockedReason` consumer on every UI surface that can produce it (desk terminal overlay, Companion terminal, Hand over). An entry alone is a dead gate.
- Enforcement lives in the daemon (authoritative; two Devices racing a Take over must have one winner), as a new module beside `presence.rs`, and refuses non-owner input with a typed error naming the owner. An older daemon simply does not lock (fail open); the UI must say ownership is unavailable rather than pretend.
- The three input commands are forwarded through `InvokeDesktop`; the desk answers them. Decide whether the check sits in the daemon's forwarding layer (preferred, it sees the Device identity) or in the host.
- If anything is persisted after all, remember a column added only to `CREATE TABLE IF NOT EXISTS` never reaches an existing database; write the `ALTER TABLE` and a `pre_v*` test.
- Add the words to `CONTEXT.md` (Owner, Take over, Hand over) before the code, and an ADR if decision 2 or 3 goes against the recommendation.

## Surfaces to touch

- Desk: `TerminalPane` overlay, tab and sidebar markers (extend the existing typing marker with an owner marker), Devices panel row ("owns 2 sessions"), the Agents page.
- Companion bundle (`app/companion/`): terminal overlay, Sessions list rows (lock + owner name), the board card's "jump to agent", the inbox landing. Reuse the desktop's components; the bundle is a remote shim over them. Overlay buttons must be 44 px targets (see `companion-touch-targets-and-small-text-sweep.md`) and the page must not zoom (see `companion-compose-field-zooms-the-page-on-ios.md`).
- Demo Workstation: it needs a second scripted Device so the overlay and the hand-off can be shown to App Review and driven in suites.
- Notifications: a hand-over aimed at a Device that is in the background is a candidate for a push (decide in the spec; out of the first slice if it complicates companion-25).

## Plan

- [ ] Spec: `docs/superpowers/specs/<date>-session-ownership.md` with the seven decisions answered, the state machine (unowned, owned, grace, taken) and the error shapes
- [ ] Glossary and, if needed, an ADR
- [ ] Protocol: variants, push, `PROTOCOL_VERSION`, `min_version_for`, and the wasm/companion-core types
- [ ] Daemon: ownership module with unit tests for every transition (claim, take over, transfer, release on revoke, grace, session end, two racing claimants)
- [ ] Daemon: enforcement on the three input commands for forwarded Devices and for local clients; typed refusal
- [ ] Seam 1 test in `crates/daemon/tests/device_wire.rs`: two test Devices, one session, take over and hand-off, the loser's input refused
- [ ] Desk: pure module `sessionOwnership.ts` plus tests, the overlay component, tab/sidebar markers, Devices panel, `featureBlockedReason` consumers
- [ ] Companion: terminal overlay, Sessions list, Hand over sheet, refusal handling in compose and quick replies, Demo second Device, seam tests
- [ ] Every input path audited against the lock (list them in the PR description)
- [ ] Human test: iPhone owns a session, the desk shows the overlay naming the iPhone; Take back at the desk locks the iPhone
- [ ] Human test: iPhone owns a session, the iPad (or a second Simulator) opens it, sees the overlay, takes over; the iPhone flips to locked; the iPhone takes it back
- [ ] Human test: lock the owning phone; after the grace the desk can type without tapping anything, and Take over still works before it

## Acceptance

- [ ] Two Devices cannot type into one session at the same time; the daemon refuses the non-owner
- [ ] A locked terminal shows the owner's Device name and a Take over / Take back CTA on the desk and on a Device
- [ ] Ownership moves iPhone to iPad by pulling and by handing over, and both Devices' screens agree within a second
- [ ] A pocketed or revoked owner never strands a session
- [ ] Rails, auto-resume and the follow-up queue behave as decided
- [ ] An older daemon degrades with a stated reason, not silently
