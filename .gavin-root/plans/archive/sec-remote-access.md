---
kind: task
title: [sec] remote-access design: proxy-mediated mobile client
parent: review-security-audit.md
complexity: intricate
---
Design work, not audit. Propose how a mobile app reaches this daemon through a remote proxy without widening today's blast radius, and write `docs/security/05-remote-access.md` to spec grade — the document a later implementation card is cut from. Read `docs/security/00-threat-model.md` first, and `01-daemon-protocol.md` if it exists yet; if it does not, read `crates/protocol/src/lib.rs` (`Request`, `Response`, `socket_path`) and `crates/daemon/src/server.rs::bind_server` yourself.

## Start from two facts

1. The daemon has **no client identity at all**: the Unix socket's `0600` mode is the entire access control, and every connection is equally trusted.
2. The wire protocol is **61 request variants, several of which are shell execution by design** (`CreateSession { command }` → `/bin/sh -c`, `SpawnAgentSession`, `WriteInput` into any session). A proxy that forwards the protocol is a remote shell on the developer's machine.

So "put the socket behind a tunnel" is not a design; it is the vulnerability. The proposal has to make the *daemon* discriminate.

## Propose, and argue each choice against at least one rejected alternative

- **Pairing** — how a phone becomes trusted (QR/one-time code shown by the desktop app, key exchange), where the trust is stored, how it is revoked, how many devices.
- **Authentication** per connection and **authorization** per request — bound to the paired identity, not to the proxy.
- **Transport** — pick one of: mTLS end to end through a dumb relay; a tunnel the human already runs (Tailscale, SSH); a gavin-operated relay with end-to-end encryption. Argue it against the others for a single developer on a laptop that sleeps.
- **The narrowed capability surface** — the load-bearing part. Which requests a remote client may issue at all: reading the board and tree, session lists and status, screen snapshots, maybe `WriteInput` to a session it can see, maybe `SetPlanFrontmatterField`; and which it may never issue (`CreateSession` with a command, `SpawnAgentSession`, `Shutdown`, `InitGavinRoot`, anything by root path). Where that gate lives: **daemon-side, keyed on client identity**, so a compromised proxy or phone still cannot spawn. Sketch the protocol change: a client-role concept on the connection, and how `min_version_for`/the compat window carry it.
- **The proxy's own threat model** — what a compromised relay learns, what it can replay, what a stolen phone can do until revoked.
- **What `feat-ssh-support.md`** (To Do, same board — read it) shares with this: ssh workspaces are the desktop reaching a *remote* daemon, this is a *remote client* reaching the desktop's daemon. Name what the two must share (client identity, the role gate) and where they must not diverge.

## Output

`docs/security/05-remote-access.md`: context and the two facts; the proposal in the sections above; a phased plan whose **phase 1 is client identity on the local socket** (it is the prerequisite for everything else and worth having even with no mobile app); open questions for the human. **No code**, no protocol bump, no cards — the parent plan files cards after its dedupe pass.
