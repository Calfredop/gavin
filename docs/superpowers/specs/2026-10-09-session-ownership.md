# Session ownership: one writer per session, a lock for everyone else

Card: `.gavin-root/plans/companion-session-ownership-lock-and-handoff.md`, part of `companion.md`. Read it beside `CONTEXT.md` (Device, Presence, Unlock, and now Owner, Take over, Hand over), ADR 0004 (one Unlock gives full control) and ADR 0008 (this spec reverses the companion spec's story 57).

## Problem

Two Devices, and the desk, can type into one session at once. Their keystrokes interleave in one PTY: a quick reply from the iPhone lands in the middle of a line the iPad is composing. `presence.rs` sees it happen and the desk draws a marker, but nothing stops it. The companion spec chose this on purpose (story 57: "no locks between clients"). Then the owner used two Devices at once during the iPhone smoke tests and asked for the opposite: a session a Device is working on reads as **locked** for everyone else, says who has it, and offers one tap to take it.

## The seven decisions

All seven follow the card's recommendations, and the owner confirmed them on 2026-10-09. Each one is a small, local switch, named below, so a different answer is a contained change.

1. **How a session becomes owned.** A Device owns a session it **started** (its `create_session` answered), and an unowned session it **sends input to** (any of the three input commands). The desk's own input never claims. An explicit **Take over** also exists. *Switch:* `ownership.rs`, `claim_by_input` and `claim_started`.
2. **System writers.** Rails, auto-resume, the follow-up queue's delivery, Best-of-N and `gavin_*` MCP calls are **exempt**: the daemon never refuses an input request that arrives on a desk (`app`/`local`) connection. The one-line "the desk sent input" notice is **deferred** (see Gaps).
3. **The owner goes away.** When the owning Device's last connection closes (its Unlock ended, the phone locked or went to the background, or the network dropped), the session goes into **grace** for `OWNER_GRACE_SECS` (30 s). A reconnect inside grace keeps ownership. When grace runs out, ownership goes back to the desk. Take over works at any time, including during grace.
4. **Reading while locked.** Locked means you cannot type into the session. You can still read, scroll and select. On a Device the input dock is replaced by the lock bar, and the terminal stays live and scrollable under a dim. At the desk the terminal is dimmed, pointer events still pass through to it, and a lock bar sits over its foot.
5. **The desk's role.** "Owner = the desk" is the default: a session with no ownership record is the desk's. **Take over** works from the desk too. When the desk typed within the last `OWNER_BUSY_SECS`, the Device is asked to confirm first.
6. **Persistence.** None. Ownership lives in memory, like presence, and a daemon restart starts every session unowned. The second daemon that shares the trust store cannot see this daemon's ownership, and it has no need to: each daemon has its own sessions.
7. **Handing to an absent Device.** **Hand over** offers only Devices with a live connection, and the daemon refuses a hand-over to any other Device (`NotConnected`).

## State machine

One record per session, in the daemon (`crates/daemon/src/ownership.rs`). No record means **unowned**, which is the desk's.

```
             claim (input / start / Take over)
 unowned ─────────────────────────────────────▶ owned(D)
    ▲  ▲                                          │  ▲
    │  │ Release · Take back · session ends ·     │  │ D reconnects
    │  └──────── D revoked/refused ───────────────┤  │
    │                                             ▼  │
    └─────────── grace runs out ───────────── grace(D)
                                                 (D has no connection)

 owned(D) / grace(D) ──Take over by E · Hand over to E──▶ owned(E)
```

- **owned(D)**: Device D is the writer. Input from any other Device is refused with `Owned`. D's own input refreshes `typedAt`.
- **grace(D)**: D has no live connection. Everyone else is still refused, the record says `awaySince` and `releasesAt`, and when it lapses the daemon pushes the session back to the desk without anyone asking.
- **Taken** is a transition, not a state: the record names who changed it (`changedBy`) and why (`reason`), so the Device that lost a session can say "iPad took over".
- **Release** returns the session to the desk. It happens on an explicit Release or Take back, on the session's end (exit or kill), and **at once** when the owner is revoked, removes itself, or is refused for a reason that ends its trust (`NotPaired`, `Revoked`, `Stale`, `PairAgain`). A refusal for `Busy` or `Unlock` does not release: the Device is still trusted.

### Races

Every transition runs under one mutex. An explicit change carries `expect`, the owner the caller saw when it decided. If the owner has changed since, the request is refused with `Changed`, which names the current owner. So two Devices racing a Take over of the iPhone's session produce exactly one winner, and the loser is shown the winner. An implicit claim by input needs no `expect`: whoever reaches the mutex first becomes the owner, and the second Device is refused with `Owned`.

### Busy: the confirm in item 4

The confirm is the **daemon's** answer, not the UI's reading of a clock. When the caller is not the current holder, and the holder (the owning Device, or the desk for an unowned session) typed within `OWNER_BUSY_SECS` (5 s), an unforced change is refused with `Busy { typedAt }`. The UI asks ("iPhone is typing right now. Take over anyway?") and sends the change again with `force: true`. An implicit claim by input is held to the same rule, so a phone sending into a session the desk is typing in gets the same question. The "Take over" choice is `danger`, so focus stays on the dismissing button.

The desk's typing is recorded from input requests that arrive on a desk connection **while the session is unowned**. While a Device owns the session, the desk host's own `WriteInput` for that session is the Device's forwarded write. It is not desk typing, and it is not recorded as such.

## Enforcement: where the check sits

- **Devices: the daemon's forwarding layer.** A Device's input reaches the daemon as `InvokeDesktop { command: write_input | queue_input | send_queued_input }` on a connection whose identity names the Device. That is the only place the daemon knows who is typing: the desk host's later `WriteInput` arrives on the desk's connection and names nobody. So the check runs in the daemon before the call is forwarded. A refused call never reaches the desk. These three commands are the whole of a Device's input: no other Tauri command sends `WriteInput`, `QueueInput` or `SendQueuedInput`, and `gavin-mcp` sends none of them.
- **The desk: its own surfaces.** The desk's human, its rails and its follow-up queue all write over the same connection, and decision 2 exempts the last two. The daemon therefore cannot refuse the desk's human without refusing its rails. So the desk refuses its own human's input at the surfaces that produce it (see the audit below), from the same pushed record, and offers **Take back** there.
- **An older daemon fails open.** It has no ownership, so nothing is locked. Every surface that would show the lock or the hand-over controls instead says why they are missing (`FEATURE_MIN_VERSION.sessionOwnership`, below).

## Wire (v68)

| | carries | answered / sent |
|---|---|---|
| `Request::SetSessionOwner` | `id`, `to: Option<device id>` (None = the desk), `expect: Option<device id>` (None = the desk), `force` | `Response::SessionOwnership { ownership }`, or an owner refusal |
| `Request::ListSessionOwners` | — | `Response::SessionOwners { owners, devices, you }` |
| `Response::SessionOwnerChanged` | `ownership` | push to every app connection that speaks 68 |

- **`SessionOwnership`** has `sessionId`, `owner` (None = the desk), `changedBy` (None = the desk), `reason` and `at`. **`SessionOwner`** has `deviceId`, `name`, `since`, `typedAt`, `awaySince` and `releasesAt`. Pushed whole, never as a delta. `ListSessionOwners` is the read-back for a window that reloads or opens after the pushes.
- **`devices`** lists the Devices with a live connection, by id and name: the Hand over sheet's list. A Device cannot read `list_devices` (it is Trust), so this is its only way to see the other Devices.
- **`you`** is the asking Device's id (None at the desk), so the bundle can tell "mine" from "someone else's".
- **Devices reach both requests through `InvokeDesktop`**, as the Tauri commands `set_session_owner` and `list_session_owners`. These are the first entries in the command table marked `RemoteAllowance::Daemon`: **the daemon answers them itself, with the Device's identity**, and never forwards them. Forwarded, the desk host would apply them as the desk. The desk's webview calls the same two commands, and the host turns them into the two requests. So the bundle's `backend.ts` is the desk's unchanged, and the command-table completeness test still holds.
- **The push reaches Devices the established way.** The desk host emits `session-owner-changed` through `forwarding::emit`, which offers it to every Device that listened for it.
- **The owner refusal** is one error string in both directions, so the desk webview and the bundle parse it with the same function: `gavin-daemon: session owner refused: ` followed by the JSON of `OwnerRefusal`, which takes one of these forms:
  - `owned { sessionId, owner }`: input from a non-owner
  - `busy { sessionId, owner, typedAt }`: confirm, then force
  - `changed { sessionId, owner }`: you lost a race
  - `notConnected { sessionId, deviceId }`

  The daemon does not check that the session exists. Records are keyed by id, and a session on an ssh host is one the local daemon never hosts. A record for a session that ended is dropped when the daemon sees the exit, or once its owner goes away.

  A Device receives it as the `DesktopResult` error of the command it invoked. The desk receives it as the Tauri command's `Err`. Parsed by `protocol::session_owner::parse_refusal` and `sessionOwnership.ts`'s `ownerRefusalFrom`.
- **Compat.** Two new request TYPES, gated by `min_version_for` at 68, and one new `Response` variant pushed only to apps that speak 68 or more (`SESSION_OWNERS_MIN_VERSION`). No existing payload is widened, so `MIN_COMPATIBLE_VERSION` stays where it is. The UI owes `FEATURE_MIN_VERSION.sessionOwnership: 68`, consumed by the desk's lock bar and Take back, the Devices panel's "owns" line, and the Companion's lock bar, Take over and Hand over.

## Surfaces

- **Desk**
  - `sessionOwnership.ts` holds the pure rules: the lock and its words, the refusal parser, the confirm text, the hand-over candidates and the per-Device counts. `sessionOwnershipState.ts` holds the store, the listener and the read-back, plus the Take back and Hand over actions with their confirms.
  - `TerminalPane` gets a lock bar plus a dim, and the terminal's keystrokes are dropped while it is locked.
  - The tab's Device marker grows an owner form: a lock and the owner's name.
  - The Devices panel row says "owns 2 sessions".
- **Companion**
  - `PhoneTerminal` replaces the dock with the lock bar (Take over) while another Device owns the session. While this Device owns it, the header offers Hand over, and the desk is one of the targets, which is how a Device releases.
  - The Sessions list puts a lock and the owner's name on each row.
  - A Hand over sheet lists the live Devices and the desk.
  - Compose, quick replies and raw keys read the refusal: `Owned` keeps the text and shows the lock; `Busy` asks to confirm, then forces and re-sends.
  - All targets are 44 px. The page must not zoom.
  - The bundle now reads `daemon_compat` when it connects. Until v68 nothing in the bundle filled `daemonCompat`, so every `featureBlockedReason` the desk's modules asked on a Device read as unblocked, whatever the Workstation's daemon was.
- **Demo Workstation**: a second, scripted Device ("iPad (demo)") owns `s-notes-sync`, and the demo answers both commands (`demo/owners.ts`). So the overlay and the hand-off can be shown to App Review and driven by seam 2.

## The input-path audit

Every path that writes into a session, and what holds it to the lock. "Desk" rows are enforced in the desk's own modules, which the Companion bundle also runs: there the viewer is the Device, and the daemon refuses as well.

| Path | Where | Behaviour |
|---|---|---|
| Terminal keystrokes, desk and raw mode on a Device | `terminalRegistry.ts` `onData` → `write_input` | Dropped by the registry's input gate while locked (`setInputGate`, set by `watchSessionOwners`); a Device's are refused by the daemon besides |
| Compose, quick replies, keys, symbols (Device) | `state/typing.ts` through `sendAsOwner` | `owned`: the line is kept and the lock drawn. `busy`: confirm, then take over with `force` and send the same bytes again. Claims an unowned session |
| Follow-up queue: queue and Send now | `queuedInputActions.ts` (`queueFollowUp`, `sendFollowUpNow`) | Refused with `inputLockedReason` before the request, saying who owns it |
| Decisions tab answer, the agent's notice | `decisionsActions.ts` → `queueFollowUp` | Inherits the queue's refusal: the answer stays on the card and the notice is skipped with the reason |
| Send a card to the workspace agent | `cardRunActions.ts` `pasteToMainAgent` | Refused with `inputLockedReason` before the paste or the queue |
| Card Run / Resume / Develop / Best-of-N | `create_session`, then `queue_input` into the new session | A new session: the desk's, or the starting Device's (`Started`), so the prompt always passes |
| Rails (`orchestrationState.ts`), auto-resume, queue delivery | desk connection / daemon-internal | Exempt (decision 2) |
| `gavin_*` MCP | — | Sends none of the three input requests |
| `kill_session`, `resize_session` | — | Not input; never locked |

The daemon records the desk as typing only for a `WriteInput` that is not a focus or mouse report (`is_focus_report`, `is_mouse_report`). With a program tracking the mouse, every pointer move over the desk's tab is a write, and a phone would otherwise be asked about a desk nobody is typing at.

## Gaps, on purpose

- **The "desk sent input" notice.** Decision 2 asks for a line on the owner's overlay when a system writer injects input. The daemon cannot tell a rail's `QueueInput` from the owning Device's forwarded `queue_input`: both arrive on the desk's connection, and neither names a Device. Telling them apart needs the desk host to mark forwarded input, which widens an existing request. That is left for a follow-up card, not slipped in here.
- **Push notifications for a hand-over** to a Device in the background. Hand over offers only connected Devices (decision 7), so a target is always in the foreground, and nothing here needs the Push gateway.
- **`kill_session` and `resize_session`** are not input, and they stay open to every client. Killing a runaway session from the phone (story 43) must never wait on a lock.

## Tests

- **`ownership.rs` unit tests**, one transition each: claim by input, claim by start, own input refreshes, another Device refused, take over with `expect`, two racing claimants, busy and force, hand over (live target, absent target), release, revoke releases at once, grace then lapse, back inside grace, session end, desk typing recorded only while unowned.
- **Seam 1 (`device_wire.rs`)**: two test Devices and one session. A claims it by typing. B's input is refused with `Owned` naming A. B takes over with `expect = A`. A's input is now refused. A takes it back. A hands over to B. A's input is refused again.
- **Desk pure-module tests**: `sessionOwnership.test.ts`.
- **Seam 2**: the Companion against the Demo Workstation. The lock bar shows for the demo iPad's session, compose is refused and keeps its text, Take over moves it, and Hand over lists the live Devices.
- **Human tests**: the card's three, run on real Devices.
