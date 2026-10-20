---
order: 32768
kind: task
title: "[sec] Any LAN or tailnet peer that sends nothing can fill the direct listener's single 16-socket cap and lock paired Devices out of the direct path"
status: Done
priority: low
complexity: moderate
---
Fix a low-severity finding from the 2026-10-15 security audit (run-1). Fingerprint: `crates/daemon/src/direct.rs:OPEN:shared-between-unauthenticated-and-carried`.

Full record: `findings.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

The daemon's direct TLS listener (ADR 0009) binds 0.0.0.0 and accepts a socket from any address that protocol::relay::address_is_local calls local: loopback, RFC1918, link-local, or 100.64.0.0/10 (tailnet and carrier-grade NAT alike). It then takes one of OPEN=16 process-wide places before any TLS, hello, rendezvous or token check. Two kinds of socket draw on that one counter. A stranger's silent socket holds its place until the 5 s HELLO deadline or until it hangs up. A paired Device's authenticated, carried connection holds its place for the whole life of the connection. So a peer on the same Wi-Fi, LAN or tailnet can keep the cap full: it opens 16 TCP sockets, says nothing, and reopens them every 5 s. While it does, every new direct dial is closed unread, whether from a paired Device reconnecting or from a phone pairing over the QR's direct address. Connections already being carried are not evicted. The Relay-stream code in remote.rs keeps MAX_CONNECTING apart from the pairing ceiling for exactly this reason: what asks for a connection 'must not be able to take the places the owner needs'. The direct listener puts strangers and owners in one pool. Current-tree calibration: the shipped Companion shell refuses every pinned (direct) dial, because no caller passes trustPinned to webSocketOpener. Today's phones therefore use the Relay, and the direct path is reached only by the native test Device and by future clients.

## Root cause

admit() in crates/daemon/src/direct.rs checks only the peer address (address_is_local). It then takes a place from one global AtomicUsize (OPEN_NOW) capped at OPEN = 16 through Open::begin(). The direct-device thread holds that place for the whole of serve(): up to HELLO = 5 s through answering::answer for a peer that presents nothing, and for the entire carry() of an authenticated Device connection (remote::serve_device blocks until the connection ends). There is no separate, smaller budget for sockets that have not passed verdict(), and no per-source-address limit.

## The invariant to enforce

A peer that has presented nothing should not be able to stop a paired Device from reaching verdict(). Sockets that have not passed verdict() (no TLS, no hello, wrong rendezvous or token) should draw on a pre-authentication budget that is bounded per source address, and a full budget should make room by dropping the oldest silent socket rather than refusing the newcomer. Connections that passed verdict() and are being proved or carried should hold places that no unauthenticated peer can take. That is the separation remote.rs keeps between MAX_STREAMS, MAX_CONNECTING and proved connections, applied at the stage where a direct stranger actually competes, and it is what ADR 0009 promises when it says anything that is not a Device hello is refused before any state is touched.

## Trace (lines as of 2026-10-16; re-read before editing)

- `crates/daemon/src/direct.rs:216` (supervise): While remote access and Direct connection are both on, the listener binds 0.0.0.0:<port> (8445 release, 8446 dev, GAVIN_DIRECT_PORT override) and is reachable from every interface.
- `crates/daemon/src/direct.rs:280` (listen): Each accepted socket is passed to admit() with its peer address.
- `crates/daemon/src/direct.rs:309` (admit): The only check on the peer is address_is_local(peer.ip()). Any loopback, RFC1918, link-local or 100.64/10 source passes, and nothing has been read yet.
- `crates/daemon/src/direct.rs:313` (admit): Open::begin() takes one of OPEN=16 global places before TLS or the hello.
- `crates/daemon/src/direct.rs:327` (admit (direct-device thread)): The place (_open) is held for the whole of serve(). For a silent stranger that means up to HELLO (5 s) in answering::answer. For an authenticated Device it means the entire carried session in remote::serve_device / serve_pairing, which block until the connection ends (remote.rs:755-830).
- `crates/daemon/src/direct.rs:314` (admit): With all places taken, a new direct dial, including a paired Device's, is dropped unread with the note 'the listener holds as many as it will'.

## Fix

Give strangers and owners separate budgets, and limit strangers per source address. (1) A pre-authentication budget for sockets that have not passed verdict(), capped per source IP (for example 2) as well as in total. When the total is full, drop the oldest socket that has not yet sent its hello instead of refusing the newcomer. A Device that finishes TLS and its hello in tens of milliseconds then gets through, even against an attacker who reopens sockets constantly. (2) A separate budget for connections that verdict() accepted and that are being proved or carried, entered before the pre-authentication place is given back. (3) A shorter deadline for the first TLS bytes than the 5 s HELLO, so a silent socket holds its place for less time. A split budget on its own does not fix this finding. An attacker would simply fill the smaller pre-authentication budget, and a new direct dial still needs one of those places to reach verdict(). The per-address limit and the drop-oldest rule are what stop a single LAN or tailnet peer. An attacker that controls many source addresses can still compete for places, so this lowers the risk without removing it, and the Relay fallback stays the backstop. Regression test: fill the whole pre-authentication cap with silent sockets from several loopback addresses (127.0.0.2 and up). Then show that a new socket which completes TLS and a valid hello promptly is still admitted, because the oldest silent socket is dropped to make room. Also show that a third silent socket from one address is refused while that address's first two are held.

`crates/daemon/src/direct.rs`, as a sketch only:

```
/// Sockets not yet past `verdict`: TLS, the WebSocket handshake and the hello.
const ANSWERING: usize = 8;
/// Of those, how many one source address may hold.
const ANSWERING_PER_PEER: usize = 2;
/// Sockets let in or carried, after `verdict` said yes.
const CARRIED: usize = 16;

/// Sockets being answered, by source address, oldest first, each with a
/// handle that `shutdown`s it so its place can be reclaimed.
struct Answering { by_peer: HashMap<IpAddr, usize>, queue: VecDeque<(u64, IpAddr, TcpStream)> }
static ANSWERING_NOW: Mutex<Answering> = /* ... */;
static CARRIED_NOW: AtomicUsize = AtomicUsize::new(0);

// admit():
//   lock ANSWERING_NOW;
//   if by_peer[peer.ip()] >= ANSWERING_PER_PEER { refuse; return }
//   if queue.len() >= ANSWERING { pop the oldest entry and shutdown(Both) its clone }
//   push (id, peer.ip(), socket.try_clone()); hand an AnsweringPlace guard to serve().
// serve():
//   answering::answer(socket, tls, HELLO)  // optionally a shorter first-byte deadline
//   verdict(...)?;
//   let carried = Place::begin(&CARRIED_NOW, CARRIED).ok_or(Busy)?;  // refuse Busy if none
//   drop(answering_place);   // gives back the per-peer and total pre-auth place
//   answered.ready() ... carry, holding `carried` until the connection ends.
```

## Done when

- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests in the touched crate or module, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched.
- The audit reproduction no longer works. It is the record's `execution` field in `findings.json`.
- Follow the CLAUDE.md traps that apply: a new SQLite column needs its own `ALTER TABLE`, a widened request needs a compat-gate entry, and you commit only your own files.
