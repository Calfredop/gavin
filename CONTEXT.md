# Gavin

A desktop workspace where a human runs and steers coding agents in terminals, led by a PRD and a board of cards. This glossary names the concepts the code and the design documents share.

## Language

### Agents

**Integration**:
What Gavin writes into an agent's own configuration so the agent can use Gavin: its MCP server and its instructions file.
_Avoid_: setup (that is the whole wizard), install

**Agent tooling**:
A third-party tool Gavin sets up to run alongside the agents, such as Matt Pocock's skills or Headroom. Gavin can check whether it is there, and when it cannot, it takes the human's word.
_Avoid_: integration (that is Gavin wiring itself into an agent), plugin, add-on, extension

**Headroom**:
The agent tooling that compresses what an agent sends to its model, so the same work spends fewer tokens of a subscription's limits.
_Avoid_: proxy (on its own), the compressor, token saver

**Compressed session**:
A session whose agent sends its model traffic through Headroom. Whether a session is compressed is settled when its agent launches.
_Avoid_: routed session, proxied session, headroom session

### Remote access

**Workstation**:
A computer running the Gavin desktop app and its daemon. It is what a Device pairs with, and what the Companion works on.
_Avoid_: host (that is an ssh workspace's machine), instance, server, Mac

**Companion**:
The phone app a human uses to watch and steer their Workstations while away from the desk.
_Avoid_: mobile client, phone app, mobile app

**Device**:
One install of the Companion, identified by its own keys to every Workstation it has paired with. An iPhone and an iPad are two Devices, and a reinstall is a new Device.
_Avoid_: phone, client, paired phone

**Presence**:
Where a Device is on a Workstation and what it is doing there: the workspace it last worked in, the session it is typing into, and the sessions it started. The daemon reads it off the commands the Device has the desktop app run, so a Device never reports its own.
_Avoid_: activity, status (that is a session's), online (that is being connected)

**Owner**:
The one Device whose input a session takes, or the desk when no Device holds it. A Device becomes the owner of a session it starts, or of a session the desk holds that it sends input to. A courtesy, not a security boundary: anyone who can type can take the session in one tap.
_Avoid_: holder, controller, lock holder, driver

**Locked**:
How a session looks to everyone but its owner: they can read and scroll it, but their input is refused until they take it.
_Avoid_: read-only (the terminal still scrolls and selects), busy, disabled

**Take over**:
Making yourself a session's owner while someone else owns it. At the desk it is called **Take back**. If the owner typed a moment ago, you are asked to confirm.
_Avoid_: steal, grab, claim (that is what typing into a session nobody owns does)

**Hand over**:
The owner passing a session on purpose to another connected Device, or to the desk.
_Avoid_: transfer, share, give

**Release**:
The owner giving a session back to the desk. It also happens without being asked: when the session ends, when the owning Device is revoked, and after a short grace once the owning Device has no connection.
_Avoid_: unlock, drop

**Workstations hub**:
The Companion's home screen: every paired Workstation with its state, and one attention inbox across all of them.
_Avoid_: hub (on its own, that is the desktop app's view one level above any workspace), home, dashboard

**Demo Workstation**:
A simulated Workstation built into the Companion, with sample sessions, cards and rails, for exploring the app before any real Workstation is paired.
_Avoid_: demo mode, sample data, offline mode

**Workstation UI bundle**:
The web UI a Device runs to work on one Workstation, built from the same commit as that Workstation's desktop app, signed by the publisher, shipped inside the desktop app and served to the Device over its connection. The Companion runs one only once its signature checks against the publisher key it pins, and keeps it by content hash.
_Avoid_: remote UI, web app, the Companion's UI (that is the shell's own hub)

**Publisher key**:
The key that signs every Workstation UI bundle a release ships, whose public half the Companion pins. Separate from the updater's key. A debug build of the Companion also trusts a dev key made on the developer's machine.
_Avoid_: bundle key (on its own), signing key (which one?)

**Landing**:
Where a Workstation UI bundle opens when the human tapped an inbox item: the item's workspace, and the card it names or the card whose agent is the session it names.
_Avoid_: deep link, route

**Unlock**:
One authentication on a Device (a biometric, or the phone's passcode), together with how long it lasts: until the Companion goes to the background or the phone locks.
_Avoid_: session (that is a terminal), login

**Remote role**:
What a Workstation lets a connection from an unlocked Device do: everything its desktop app can do, except manage Devices.
_Avoid_: mobile permissions, remote access (as the name of the permission)

**Relay**:
The server that carries encrypted traffic between a Workstation and its Devices without being able to read it.
_Avoid_: proxy, tunnel, server

**Push gateway**:
The publisher's service that delivers encrypted notifications to Devices through Apple and Google, and the only holder of the publisher's push credentials.
_Avoid_: notification server, push server

**Send permission**:
What a Device gives one Workstation so that the Push gateway will deliver that Workstation's notifications to it. The Push gateway signs it, and the Device can cancel it.
_Avoid_: push token (that is Apple's or Google's address for the Device), grant, subscription
