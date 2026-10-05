# The Companion: Gavin on a phone

Synthesised on 2026-09-27 from a grilling session. Read this beside `CONTEXT.md` (the glossary: Workstation, Companion, Device, Unlock, Remote role, Relay, Push gateway, Workstations hub, Demo Workstation), ADRs 0001–0005 in `docs/adr/`, the store-policy research in `docs/research/2026-09-27-app-store-downloaded-code.md`, and `docs/security/05-remote-access.md`. The ADRs supersede 05 wherever they disagree with it; §"Further Notes" lists where.

## Problem Statement

The human runs coding agents on their Workstations, and most of that work waits on them: an agent asks which migration to keep, a rail pauses on a failed step, a human test is filed, an agent crashes. Away from the desk they learn none of this. They cannot answer the agent, run the next card, start the rail again, or stop an agent that is running away. The work sits idle until they are back at the keyboard.

The earlier remote-access design stopped at phase 2. Pairing and the trust store exist, but no transport does, so no phone has ever connected. That design also assumed a read-only phone talking only to the daemon. But most of Gavin lives in the desktop app: git, files, settings, agent profiles, card-run composition, the rail scheduler and the workspace list. A phone that talks only to the daemon would be a terminal viewer and nothing more.

## Solution

**The Companion** is an iOS and Android app that gives the human their Workstations in their pocket.

- **Pairing.** The human pairs each Device once, at the Workstation: they scan a QR code in the desktop's new **Devices** panel and confirm that the six-digit codes on both screens match.
- **Unlocking.** Opening the Companion takes one Face ID, fingerprint or phone passcode (the **Unlock**). It gives full control until the app goes to the background or the phone locks, like a laptop.
- **The Workstations hub.** It lists every paired Workstation with its state (ready, desktop app not running, Mac asleep), and gathers **one attention inbox across all of them**.
- **Notifications.** They arrive end-to-end encrypted: the text is readable on the phone, and nowhere in between.
- **Working on a Workstation.** Picking a Workstation opens the same surfaces the desktop has, laid out for a phone: sessions and terminals (a compose field with quick replies, plus a raw terminal mode), the board and cards (including Run card), rails, Git, files, settings, orchestration editing and adding a workspace. The one thing a Device cannot do is manage Devices.
- **Where it works.** Anywhere: the Workstation and the Device both dial a **Relay** (a public one, or one the human hosts), which carries traffic it cannot read.
- **What the desk sees.** The desktop app keeps running in the menu bar while remote access is on. It shows which Devices are connected and what they are doing. A session started from a phone opens as a tab in its workspace, labelled with the Device.
- **Before any pairing.** A built-in **Demo Workstation** lets anyone, App Review included, explore a working Companion.

## User Stories

### Pairing and trust

1. As the human, I want to pair my phone by scanning a QR code on my Workstation and confirming a matching six-digit code on both screens, so that only the phone in my hand becomes a Device.
2. As the human, I want pairing to happen only at the Workstation, so that nobody can add a Device without being at my desk.
3. As the human, I want my phone's key to be bound to its hardware, so that copying the Companion's data off the phone gets an attacker nothing.
4. As the human, I want pairing refused on a phone without a hardware keystore or without a passcode, so that every Device has the same guarantees.
5. As the human, I want one Companion install to pair with several Workstations using the same identity, so that "my iPhone" means the same Device on each of them.
6. As the human, I want up to five Devices per Workstation, so that my phone, my tablet and a spare all fit.
7. As the human, I want a reinstalled Companion to count as a new Device that must pair again, so that an old install can never be revived silently.
8. As the human, I want to revoke a Device from my Workstation's Devices panel and have its live connection dropped at once, so that a lost phone loses access immediately.
9. As the human, I want "Revoke all" to rotate my Workstation's key, so that no previously paired Device can ever connect again.
10. As the human, I want revoking a Device on one Workstation to leave my other Workstations untouched, so that I manage each machine on its own.
11. As the human, I want a Device to be able to remove itself from a Workstation, so that I can tidy up from the phone.
12. As the human, I want a Device unseen for ninety days to have to pair again, so that forgotten phones age out.
13. As the human, I want the pairing QR code to carry the Relay's address and admission token, so that pairing sets up everything the phone needs to reach this Workstation.

### The Unlock

14. As the human, I want to unlock the Companion once with Face ID or fingerprint, falling back to my phone passcode, so that I authenticate the way I do everywhere else on my phone.
15. As the human, I want one Unlock to cover every paired Workstation, so that I don't authenticate once per machine.
16. As the human, I want the Unlock to end when the Companion goes to the background or my phone locks, so that a phone left on a table is not an open door.
17. As the human, I want pulling down Control Center or an incoming-call banner not to end the Unlock, so that I don't re-authenticate all day.
18. As the human, I want a network drop while the Companion is in front to reconnect without asking me to authenticate again, so that a train tunnel doesn't cost me a Face ID.
19. As the human, I want the Workstation's daemon, not just the app, to verify that each connection comes from an unlocked Device, so that a tampered app cannot skip the Unlock.

### The Workstations hub

20. As the human, I want a Workstations hub listing each paired Workstation with its state, so that I can see at a glance which machines are reachable.
21. As the human, I want a Workstation whose desktop app is not running, or which is asleep, to say so in the hub, so that I know why I cannot reach it.
22. As the human, I want one attention inbox across all my Workstations, each item labelled with its Workstation, so that I can answer "what needs me, anywhere" in one glance.
23. As the human, I want tapping an inbox item to take me straight to that session or card on its Workstation, so that acting on it is one tap away.
24. As the human, I want the inbox to be correct when I open the app, even if a notification was lost, so that I can trust it.
25. As the human, I want an item I dealt with at the desk to disappear from my phone, so that the inbox doesn't nag me about solved things.

### Notifications

26. As the human, I want a notification when an agent waits on me, a human test is filed, or an agent fails or is interrupted, so that I learn about it without opening the app.
27. As the human, I want a notification when a rail stops (paused, failed or finished), so that I know when a batch of work needs me.
28. As the human, I want notifications to show what is needed ("feat-x: the agent asks which migration to keep"), so that I can decide from the lock screen whether to act.
29. As the human, I want notification contents to be unreadable to Apple, Google, the Relay and the Push gateway, so that my code, branch names and agent questions stay mine.
30. As the human, I want notifications from every paired Workstation, so that no machine goes unwatched.
31. As the human, I want to be able to cancel one Workstation's permission to notify me, so that I can quiet a machine without unpairing it.

### Working on a Workstation

32. As the human, I want to pick a Workstation from the hub and see its workspaces, so that I can work on one machine at a time.
33. As the human, I want the Workstation's UI on my phone to be exactly as new as that Workstation, so that nothing breaks when my Companion and my desktop are on different versions.
34. As the human, I want the Companion to remember where I was on each Workstation (workspace, board, session), so that coming back is seamless.
35. As the human, I want what I do on the phone never to rearrange my desktop's pages and tabs, so that my desk is as I left it.
36. As the human, I want the phone to add a workspace through a folder browser on the Workstation, starting at my home folder, so that I can start on a new project while away.
37. As the human, I want to change a workspace's settings (auto commit, review gate, git tracking and the like) from the phone, so that configuration isn't desk-only.

### Terminals and typing

38. As the human, I want to watch any session's terminal live, so that I can see what an agent is doing.
39. As the human, I want to answer an agent by typing a line into a compose field and sending it, so that answering on a phone keyboard is comfortable.
40. As the human, I want quick-reply buttons that match what the agent is asking (such as 1, 2, 3, yes, no, Esc), so that most answers are one tap.
41. As the human, I want a raw terminal mode one tap away, with a row of special keys (Esc, Ctrl, Tab, arrows), so that I can drive a real shell when I must.
42. As the human, I want touch scrolling through a terminal's history to work, so that I can read what scrolled past.
43. As the human, I want to kill a runaway session from the phone, so that I can stop damage without being at the desk.
44. As the human, I want to open a new session on a Workstation from the phone, so that I can start work while away.
45. As the human, I want a marker on a terminal when a Device is typing into it, so that I know when someone else is driving it.

### Board, cards and rails

46. As the human, I want to see the board, move cards between columns, tick checklist items, and file or rename cards from the phone, so that I can triage from anywhere.
47. As the human, I want to run a card from the phone, so that the next piece of work starts the moment I decide it should.
48. As the human, I want to answer a decision or pass or fail a human test from the phone, so that work blocked on me is unblocked.
49. As the human, I want to see each rail's state, and start, resume or pause it from the phone, so that I can manage batches of work away from the desk.
50. As the human, I want to edit orchestration (rails, stages and steps) from the phone, so that re-planning isn't desk-only.
51. As the human, I want to archive cards and discard a run's changes from the phone, so that clean-up isn't desk-only.
52. As the human, I want to read the PRD from the phone, so that I can check what a card traces back to.

### Git, files and settings

53. As the human, I want the Git tab on the phone (status, diffs, commit, branches, merge, push), so that I can land finished work while away.
54. As the human, I want to browse, read and edit files on the phone, so that I can make a quick fix without a laptop.
55. As the human, I want the app's settings and agent configuration reachable from the phone, so that I can change how agents run while away.

### Several clients at once

56. As the human, I want my desktop, my phone and my tablet all connected to one Workstation at once, so that I can move between them freely.
57. As the human, I want no locks between clients (the last write wins, and keystrokes interleave), so that no client is ever stuck waiting for another.
58. As the human, I want every client to show which Devices are connected, so that I always know who else is on the Workstation.

### At the desk

59. As the human, I want a Devices row in the sidebar footer that opens a Devices panel, so that everything about Devices lives in one place at the Workstation level.
60. As the human, I want the Devices panel to show each Device's presence (connected now or last seen, which workspace it is in, whether it is typing into a session, which sessions it started), so that I can see what my phone did while I was away.
61. As the human, I want pairing, Revoke and Revoke all in the Devices panel, so that trust is managed where I can see it.
62. As the human, I want the Devices footer row to carry a badge counting connected Devices, so that I notice when a Device is on.
63. As the human, I want Settings to keep only the remote-access switch and the Relay and push configuration, so that settings and Devices don't duplicate each other.
64. As the human, I want a session I started from my phone to be open as a tab in its workspace's page, labelled with the Device, when I get back to the desk, so that I find it where the card lives.
65. As the human, I want the desktop app to stay running in the menu bar when I close its window while remote access is on, so that my phone keeps working.
66. As the human, I want my Mac not to idle-sleep while remote access is on and an agent is running, so that the work and my access to it continue.
67. As the human, I want the desktop app to quit on window close, as it does today, while remote access is off, so that nothing changes for me until I opt in.

### The Relay and the Push gateway

68. As the human, I want a public Relay to use by default, so that the Companion works without my running any infrastructure.
69. As a self-hoster, I want to run the Relay myself from a signed Docker image pinned by digest, so that I know exactly what carries my traffic.
70. As a self-hoster, I want my Relay to accept only daemons and Devices that hold its admission token, so that it isn't free infrastructure for strangers.
71. As the human, I want a Relay that drops, replays or alters traffic to cause a failed connection, never a wrong answer, so that the Relay never has to be trusted.
72. As a self-hoster, I want notifications to work even when I use my own Relay, so that self-hosting costs me nothing.
73. As the publisher, I want the Push gateway to be the only holder of Apple's and Google's push credentials, so that those credentials live in one place I control.
74. As the publisher, I want the Push gateway to deliver only pushes that carry a valid per-Device send permission, rate-limited per Device, so that nobody can spam my users through it.
75. As the publisher, I want both services to be Docker images, with free public instances that have per-Workstation limits, so that personal use stays free.

### The Demo Workstation and the stores

76. As a new user, I want to explore a Demo Workstation with sample sessions, cards and rails before pairing anything, so that I understand the Companion before I set it up.
77. As an App Store reviewer, I want to exercise the app through the Demo Workstation with no account and no pairing, so that I can review it.
78. As the human, I want the Companion to run only UI bundles that the publisher signed, so that a compromised Workstation cannot run code next to my keys for my other Workstations.
79. As the human, I want a Workstation's UI to open inside the Companion, seamlessly, never in a browser, so that it feels like one app.

### Developing Gavin

80. As a developer of Gavin, I want debug builds of the Companion to trust a dev signing key generated on my machine, so that I can run bundles built by the dev tree.
81. As a developer of Gavin, I want a local stack (a Relay plus a sandboxed Push gateway) that starts with one command, so that I can develop end to end without touching public services.
82. As a developer of Gavin, I want a dev desktop build to turn on remote access only against a Relay on localhost or my LAN, so that a paired phone never meets a live dev server in the wild.
83. As a developer of Gavin, I want the build to fail when I add a desktop command without deciding whether the Remote role may call it, so that nothing reaches the phone by accident.

## Implementation Decisions

### The Device's keys and the Unlock (ADR 0001, ADR 0004)

- **Two keys per Device:**
  - a software X25519 Noise static key, kept in the platform keystore as this-device-only;
  - a hardware-bound P-256 key: the Secure Enclave on iOS, StrongBox or else the TEE-backed Keystore on Android.

  The hardware key requires user presence (a biometric or the phone passcode) to sign. One key pair per install, shared across every Workstation.
- **After every Noise `IK` handshake, the Device sends one message: its hardware signature over the handshake hash.** The daemon accepts no request on that connection until the signature verifies against the Device's row in the trust store. This per-connection signature *is* the Unlock's enforcement.
- **The shell holds an authenticated context while it is in the foreground**, so that reconnects and the connections to several Workstations sign without prompting again. It drops that context, and every connection, on background or lock. How the iOS and Android APIs support this reuse is an open spike.
- **Pairing is refused** without a hardware keystore and a set phone passcode.

### The shared protocol crate

- **Its operating-system-specific parts move behind a Cargo feature**, so the crate compiles to `wasm32-unknown-unknown`. Those parts are the local transport, randomness taken from the OS, and the platform data paths.
- **The pairing SAS stays where it is**, so the Device computes the code with the daemon's own implementation. What goes into it changed with `companion-33`: it is derived from the pairing handshake's hash rather than the two static keys (`gavin-pairing-sas-v2`; ADR 0001), and the Device shows it only after the Workstation's `PairingAck`.
- **It hosts the Remote role command table**, so that both the daemon (which enforces it) and the desktop host (which tests it for completeness) read the same table. The table maps every desktop command name to allowed or refused for the Remote role:
  - **Refused:** Trust (pairing, revoking, remote-access settings), the layout-saving commands, window management, the updater, opening things externally on the desk, and anything meaningless away from the desk.
  - **Allowed:** everything else.

### The Companion core (new Rust crate)

- It owns:
  - the Noise client, both the `XXpsk3` pairing handshake and the `IK` connection handshake;
  - framing and padding;
  - the post-handshake hardware-signature message;
  - the pairing SAS, reused from the protocol crate;
  - the message types the shell exchanges with a Workstation.
- It is built two ways: to WASM for the shell, and natively as the **test Device** that seam 1 drives. One implementation of everything that must match the daemon byte for byte.

### Pairing and the trust store (changes to phase 2)

- **The pairing payload gains the Device's hardware public key.**
- **The trust store gains a column for that key.** The migration is an `ALTER TABLE … ADD COLUMN` beside the `CREATE TABLE`, and a duplicate-column error is swallowed. No Device has ever paired over a real transport, so the pairing format changes freely.
- **The device cap rises from three to five.** The ninety-day unseen expiry stays.
- **The pairing QR code carries** the Relay URL and the Relay admission token, in addition to what it carries today.
- **Each pairing agrees a per-Workstation notification key.**

### The daemon's remote transport (phase 3, "relay first")

- When the trust store says remote access is on, **the daemon dials its Relay** and holds a connection, reconnecting on wake. For each Device connection it accepts, it runs `IK`, verifies the hardware signature, and assigns the Remote role.
- **A connection from a Device may send only:**
  - forwarded desktop commands and event subscriptions, gated by the command table;
  - the attention request;
  - removing its own Device.

  Everything else is refused before any handler runs.
- **Revoking a Device drops its live connections.** "Revoke all" rotates the Workstation key and drops every Device connection.
- **The daemon tracks which Devices are connected, and where**, and pushes presence to the desktop app.
- **Device pushes reach only the desktop connection that reads pushes.** Today `Hello` cannot tell the app's push connection from its command connection, so it gains a field saying which one it is. This folds in the existing card about device pushes reaching the command connection.
- The direct LAN or Tailscale listener is **not** part of this spec (see Out of Scope).
- **Protocol bumps.** Every new request type gets a `min_version_for` arm and a `PROTOCOL_VERSION` bump. Every UI surface that sends a widened or new payload gets a `FEATURE_MIN_VERSION` entry, with a `featureBlockedReason` consumer.

### Forwarding to the desktop app (ADR 0003)

- **The desktop app holds a forwarding connection to its daemon.** Over it, the daemon hands the app a gated command, and the app hands back the result.
- **The desktop host gains a dispatcher.** It maps a command name plus JSON arguments to the *same* handler functions that its webview's `invoke` reaches, and it offers every event it emits to its webview to the forwarding connection as well. The daemon relays those events to the Devices that subscribed.
- **When no desktop app is connected**, the daemon answers "desktop app not running". The hub shows that state.
- **The Companion never starts the rail scheduler.** The desktop window stays the only place rails tick.
- **A session a Device starts is placed as a tab** in its workspace's page on the desktop, labelled with the Device's name. The desktop learns it from a push that names the originating Device.

### Workspace state split (ADR 0006)

- **The desktop's saved workspace state is split into two:**
  - **Workstation data:** which workspaces exist, and their settings.
  - **Desktop layout:** pages and tabs.

  Workspace settings get commands of their own, which the Remote role may call. The layout-saving commands are refused to it.
- **Adding a workspace from a Device** uses a remote folder browser built on the file viewer's existing directory listing, starting at the home folder.

### The attention request (the one stable API, ADR 0005)

- **A small, deliberately versioned request, answered by the desktop app**, which is where the signals live. It returns two things:
  - **the Workstation's state:** ready, desktop app not running, or asleep (the last inferred by the shell from the Relay);
  - **the waiting items:** an agent waiting on the human, a human test filed, an agent failed or interrupted, a rail stopped. Each carries an id, a workspace, a kind, a short text and a target (a session or a card).
- **It carries an explicit version**, and it only ever grows by optional fields.

### Notifications

- **The desktop app decides what to notify**: the attention-inbox triggers plus a rail stopping.
- **The daemon encrypts each payload** with the Workstation's notification key for that Device, and sends it to the Push gateway over outbound HTTPS, along with the Device's send permission.
- **Pushes also carry "resolved"**, so an item handled at the desk leaves the phone.
- **The phone decrypts before displaying:**
  - iOS: a Notification Service Extension, a native target in the shell;
  - Android: the app decrypts a data message.

### The Push gateway (new service, Docker)

- **Device registration.** A Device registers its APNs or FCM token and receives a signed send permission per Workstation. It hands that permission to the Workstation over the encrypted channel, and can cancel it.
- **Delivery.** The gateway checks the permission, rate-limits per Device, and forwards the ciphertext to Apple or Google untouched.
- **What it holds.** It holds the publisher's push credentials and nothing else of value. It never sees plaintext.
- **Hosting is decided later.** It runs as a configured Docker image.

### The Relay (new crate, Docker)

- **What it does:** it matches up the two ends and copies bytes between them, over WebSocket and TLS.
- **Who may connect:** daemons and Devices must present its admission token.
- **Distribution:** signed images, pinned by digest.
- **Instances:** one public instance run by the publisher, self-hosting documented, and a dev instance in the local stack. Public instances are free, with per-Workstation bandwidth limits.
- **Padding stays at the 256-byte bucket from 05.**

### The Companion shell (Capacitor, the store app)

- **It owns:**
  - the Workstations hub and the combined attention inbox (it asks each Workstation's attention request);
  - pairing: QR scan and SAS comparison;
  - the Unlock;
  - the keys;
  - push registration and decryption;
  - fetching, verifying and caching bundles (by content hash);
  - the Demo Workstation.
- **The Companion core runs in the shell as WASM.**
- **Each Workstation's UI bundle runs in a separate webview with no Capacitor bridge.** It is rendered seamlessly, full-screen inside the app's own navigation, never in a browser. Its only outlet is a **shell-owned channel**:
  - it carries a closed, versioned set of typed messages;
  - it accepts messages only from the bundle's own origin;
  - it reaches only that bundle's own Workstation;
  - the message set covers invoke and result, listen, event and unlisten, a capabilities query, opening an external link in the system browser, and returning to the hub.

  Keys, biometrics and push never cross into the bundle.
- **Bundle trust:**
  - store builds run only bundles that verify against the pinned publisher key;
  - debug builds also trust a dev key generated on the developer's machine;
  - every navigation outside the app-local origin is blocked.
- **New phone-side capabilities, permissions or a change of purpose ship as store releases**, never in a bundle.

### The Workstation UI bundle (Companion web)

- **A SvelteKit static build from the same commit as the desktop app.** The desktop build produces it, signs it with a bundle-signing key separate from the updater's, ships it inside the desktop app, and serves it to Devices over the encrypted channel.
- **It imports the desktop's components and logic modules directly.** Its build aliases replace the Tauri core and event modules with the remote shim, so the desktop's backend module is used unchanged.
- **Components become responsive where they already live**, in the desktop's component library. Nothing moves into a new shared package.
- **The Companion keeps its own view state on the Device.**
- **Typing (provisional until the prototype):**
  - a compose field by default, with quick replies derived from the turn verdict;
  - a raw mode with a special-key row, one tap away.

  xterm.js touch scrolling needs the 6.1 line.

### The desktop app

- **Keep-running mode:** while remote access is on, closing the window leaves a menu-bar icon instead of quitting.
- **Idle-sleep prevention** while remote access is on and an agent is running.
- **A "Devices" row in the sidebar footer**, with a connected-Device count badge, opening a Devices app panel: pairing, presence, Revoke, Revoke all. Settings' remote-access section is trimmed to the switch plus the Relay and push configuration.
- **Presence markers** on terminals that a Device is typing into.
- **A dev desktop build may enable remote access only against a Relay on loopback or the LAN.** This relaxes 05's open question 12.

### Documentation and the PRD

- **A new security design pass, `06-companion`, supersedes 05's** §1 (the claim that composition happens in the host), §6 (the capability table), §8 (key custody) and §10 (the phases). 05 gets a header pointing to it. 05's pairing ceremony and trust store stand.
- **PRD priority #5 becomes "The Companion".** The phase-2 item it replaces has landed.

### Suggested build order (for ticketing)

1. The Relay, the daemon transport and the test Device (seam 1 green end to end).
2. Forwarding, the command table and the desktop dispatcher.
3. The shell: pairing, the Unlock, the hub and the Demo Workstation.
4. The served-bundle channel.
5. **The first end-to-end build submitted for full App Store review, with manual release.**
6. Notifications and the Push gateway.
7. The surfaces, made responsive.

The typing prototype and the spikes run first, in parallel.

## Testing Decisions

**A good test drives the system at a public boundary and asserts what a client would observe:** a refusal, a result, an event, a stored row seen through a later read. It never asserts internal calls. Four seams carry the suites, plus human tests for the native layer.

1. **The Device wire (the main seam).**
   - **The setup:** a test Device, built natively from the Companion core, drives a real daemon (isolated under a temporary `$HOME`) through a real local Relay. A scripted stand-in plays the desktop app on the forwarding connection.
   - **What it proves:**
     - pairing over the Relay registers the hardware key, and a store row appears only after the desk confirms;
     - `IK` plus a valid hardware signature gets the Remote role, and a missing or wrong signature gets nothing;
     - every Trust request is refused;
     - an allowed command reaches the stand-in and its result comes back;
     - a layout-saving command is refused;
     - events reach only subscribed Devices;
     - the attention request answers;
     - revocation drops a live connection;
     - "Revoke all" makes an old Device's `IK` fail (the proof 05 still owes);
     - a missing admission token is refused;
     - a Relay that replays or tampers causes a failed handshake or a dropped frame;
     - a daemon token presented over the remote path is ignored;
     - several Devices at once get correct presence;
     - "desktop app not running" is reported when the stand-in is absent.
   - **Prior art:** the in-process pairing ceremony helper and its tests in the daemon's pairing module; the every-request-variant authorize walk in the daemon's server tests; the integration tests under the daemon crate's `tests/`; the isolated-daemon-under-temp-`$HOME` pattern.
2. **The bundle channel.**
   - **The setup:** the Companion web logic is tested in vitest against the **Demo Workstation** as the channel's other end. The demo that ships is also the fixture.
   - **What it proves:**
     - the remote shim turns `invoke` and `listen` into channel messages and back;
     - the Companion's view state stays on the Device and never calls a layout-saving command;
     - the rail scheduler never starts;
     - quick replies are derived from a turn verdict;
     - the capabilities query lets an older or newer bundle degrade instead of breaking.
   - **Prior art:** the app's pure-module suites, and the existing suites that mock the Tauri core module.
3. **The desktop forwarding handler.**
   - **The key test:** the command table's keys equal the host's registered command set, so adding a command without a Remote-role entry fails.
   - **Also:** dispatch tests (a forwarded call reaches the same handler as the webview's), refusal of layout-saving and Trust commands, and a forwarded event reaching the forwarding connection.
   - **Beware:** saving anything under the Tauri host relaunches the owner's dev app, so batch these edits.
4. **The Push gateway's HTTP API.**
   - **The setup:** a fake Apple and Google sender.
   - **What it proves:** an invalid or cancelled send permission is refused; rate limits hold; the ciphertext passes through untouched; a registration replaced by a newer token keeps working.

**Also:**

- **A migration test** that opens a trust-store database built by hand with the phase-2 schema and gets the new column. This follows the existing `pre_v*` tests in the registry, kanban and orchestration stores.
- **A WASM build check** of the Companion core and the protocol crate, for `wasm32-unknown-unknown`, in CI.

**Human tests** (filed as `Human test:` items on the relevant cards, run on real phones):

- the hardware keys on an iPhone and an Android phone;
- Face ID and passcode Unlock;
- background and lock ending the Unlock, while Control Center does not;
- a reconnect without a prompt;
- the Notification Service Extension showing decrypted text;
- the Demo Workstation;
- a served bundle rendering seamlessly;
- the keep-running menu-bar icon;
- a phone-started session appearing as a labelled tab at the desk.

The daemon's `gavin::tests` are flaky under full-suite parallelism. Re-run that module alone before calling a failure a regression.

## Out of Scope

- **A Companion that works while the desktop app is quit.** The daemon does not become the brain (ADR 0003).
- **The direct LAN or Tailscale listener.** Relay first; direct connection is a later card on the same code path.
- **Per-Device notification muting**, beyond cancelling a Workstation's send permission.
- **Waking a sleeping Mac, or keeping a lid-closed Mac awake.** The hub shows "asleep".
- **Managing Devices from a Device**, other than a Device removing itself.
- **Multi-user: sharing a Workstation with another person.**
- **A browser-based client.**
- **Choosing hosting and pricing** for the public Relay and Push gateway.
- **Session survival across a daemon restart.**

## Further Notes

- **Where 05 is superseded:**
  - ADR 0003 replaces "the phone talks to the daemon".
  - ADR 0004 replaces "the Remote role cannot spawn", the desk-issued typing grants, and the phase 4/5 split.
  - ADR 0001 corrects §8's "the key never leaves the Secure Enclave" (Noise keys cannot live there).
  - §1's claim that card-run composition happens in the Tauri host is wrong: it happens in the desktop webview's TypeScript.
- **05's open questions, as now answered:**
  1. Unchanged.
  2. A public Relay plus self-hosting.
  3. Five Devices.
  4. Ninety days unseen, then re-pair.
  5. to 7. Superseded by ADR 0004.
  8. Hardware keys are mandatory on both platforms.
  9. Not applicable.
  10. Unchanged.
  11. 256-byte padding kept.
  12. Relaxed to a local-only dev Relay.
- **Open spikes, each a ticket:**
  - the typing prototype (blocks only the typing work);
  - reconnecting without a new prompt on iOS and Android;
  - whether the Secure Enclave is available in the iOS Simulator (if not, debug builds use a software key marked as such, accepted only by a dev daemon);
  - whether a hidden desktop window throttles the rail scheduler's timers.
- **Store risk:**
  - **2.5.2 and the 2020 notice.** Apple's Guideline 2.5.2 and its 2020 notice on HTML5 still give a reviewer grounds to reject. The early full review (build order step 5) exists to find out before the rest is built.
  - **4.2.7.** Its "LAN-only mirror" reading could conflict with the Relay. The Companion renders its own UI rather than mirroring a screen.
- **An existing card is folded into this work:** device pushes reaching the command connection. It is resolved by the `Hello` field above.
