---
order: 17408
kind: task
title: "[sec-check] The Relay's 4096-socket pool and copied bandwidth have no per-IP, per-token or per-Workstation limit, though the docs promise a per-Workstation bandwidth limit on the public instance"
status: To Do
priority: low
complexity: moderate
labels: security, ready-for-human
---
Decide, then fix or close, a needs-validation lead from the 2026-10-15 security audit (run-1). It is not confirmed: the audit traced it in source and probed a local Relay, but could not observe the cross-tenant denial, because it could not exhaust a 4096-socket pool without a stress test and no shared public Relay is visible from the repository. Fingerprint: `gavin-relay/server/shared-slot-pool-without-per-principal-or-bandwidth-limit`.

Full record: `NEEDS-VALIDATION.md` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

Every connection to gavin-relay draws from one process-wide semaphore of `Limits::connections` (4096). It cannot be configured: main.rs always builds `Limits::default()`. A socket arriving at the ceiling is closed unread. A peer with no token holds a slot for up to the 5 s hello deadline per socket; at about 820 new sockets a second an unauthenticated peer keeps the pool full on any internet-facing instance. Any holder of the admission token can hold slots for as long as it answers pings, by registering Workstations under rendezvous ids it chooses itself: the per-rendezvous caps (4 registrations, 16 waiting) limit each id, and nothing limits how many ids one principal uses. Bytes on an admitted stream are counted and never limited.

The docs say otherwise. `docs/security/06-companion.md:312` says the Relay carries its own per-Workstation bandwidth limit, `:669` says the public Relay has per-Workstation bandwidth limits, and `docs/self-hosting-relay.md:167` says a public instance adds them. `docs/relay.md:275` admits they are not configurable yet. On a Relay shared by tenants who all hold the same token, the documented free public instance, one tenant can take the slots every other Workstation needs and run up the operator's bandwidth bill.

A local probe (prebuilt debug gavin-relay, loopback, one dummy token) showed one token holder registered under 8 self-chosen rendezvous ids; on one id the fifth registration was refused busy, so the cap is per id and not per principal; and a splice copied 512000 bytes in four 128000-byte frames with no budget refusal.

**Is there a public Relay?** Not in the code: there is no default Relay URL, the Settings field starts empty, and since v73 the desk can run a local Relay itself. The docs describe one: 05 open question 2's default is "ship it self-hostable first and run one public instance", 05:1047 says not to ship one before the self-hosted one works, and 06 §5 describes it as run by the publisher, free. Whether it exists, is planned, or has a front proxy is the owner's knowledge, and it is part of the decision below.

## Trace (lines as of 2026-10-16; re-read before editing)

- `crates/gavin-relay/src/main.rs:77` (config): `RelayConfig { …, limits: Limits::default() }`; listens on 0.0.0.0:8443 by default (DEFAULT_LISTEN, 33).
- `crates/gavin-relay/src/server.rs:54` (Limits, to 87): A global `connections` ceiling (71, 4096 at 84) and the per-rendezvous caps; nothing per source, per token or per byte.
- `crates/gavin-relay/src/server.rs:320` (serve_counting): One semaphore (329), try_acquire_owned at 351; at the ceiling the socket is dropped unread.
- `crates/gavin-relay/src/server.rs:391` (handle): The slot is held through TLS, the WebSocket handshake and the hello for up to hello_deadline (397); the token is checked only after that (436).
- `crates/gavin-relay/src/server.rs:508` (workstation): The cap at 516 is per rendezvous id. Ids are any 64 lowercase hex characters the peer picks (`crates/protocol/src/relay.rs:122-124`).
- `crates/gavin-relay/src/server.rs:646` (copy): Frames up to 128 KiB are forwarded with no byte or rate budget, only counted (679, 691).

## What the audit could not observe

- Whether a shared public Relay is deployed or planned, and whether its tenants share one admission token. Without a multi-tenant instance, the admitted-peer path affects only the owner's own machines, which is hardening.
- What per-IP connection caps, connection-rate limits or bandwidth shaping (proxy, load balancer, firewall) sit in front of any deployed instance. Those would bound both the unauthenticated 5 s hold and the admitted-peer accumulation.
- The pool exhaustion itself: the sandbox caps fds at 1024, the audit forbade stress, and the ceiling cannot be lowered without a rebuild.

## The decision

- [ ] Decision: Does gavin-relay itself enforce per-Workstation and per-principal limits, or do the docs name a proxy-level control instead?
  Options: A) Implement them in gavin-relay: a byte or rate budget per rendezvous or per stream, a registration and connection ceiling per token and per source address, and Limits configurable from the environment. B) Correct `docs/security/06-companion.md` and `docs/self-hosting-relay.md` to say gavin-relay enforces only the global and per-rendezvous caps, and name the proxy-level control (per-IP concurrent connections, connection rate, bandwidth shaping) a public or shared instance must put in front of it. C) B now, and A as its own card once a public Relay is actually planned.

## After the answer

- **A.** Extend `Limits` with the new ceilings and budgets, read them from `GAVIN_RELAY_*` variables in main.rs (documented in its header table and in docs/relay.md's limits table), and enforce them in serve_counting (per source address, before TLS), workstation (per token) and copy (per rendezvous or per stream; an over-budget stream is ended, not throttled silently). Regression tests in `crates/gavin-relay`: a RunningRelay with `Limits { connections: 4, .. }` where one token holder registers under 4 distinct ids, and a fifth, legitimate Workstation's socket must be served (today it is closed unread); and a stream that copies past its budget is ended. Then make the three doc passages describe what was built.
- **B.** In `docs/security/06-companion.md:312` replace "and the Relay carries its own per-Workstation bandwidth limit" with what gavin-relay does (a global socket ceiling, per-rendezvous registration and waiting caps, a 5 s hello deadline, a 128 KiB frame cap) and the control a shared instance needs in front of it. At `:669`, say the public Relay's per-Workstation limits come from its front proxy, naming which, or drop the claim until one exists. At `docs/self-hosting-relay.md:167`, say a public instance's limits come from its proxy, and add a short paragraph on what to configure in Caddy, nginx or a load balancer (per-IP concurrent connections, connection rate, bandwidth) beside the existing TLS-termination section (113-122). Align `docs/relay.md:275`. Record the residual: "gavin-relay limits sockets only in total and registrations only per rendezvous id. Any holder of a shared admission token can take the whole socket pool and any amount of bandwidth; an instance shared between tenants relies on its front proxy for per-source and per-tenant limits."
- **C.** Do B, and file a card for A with this card's trace and tests, labelled `security`, linked from this one.

## Done when

- The decision above is ticked, with the chosen option, the answer on whether a public Relay exists or is planned, and the reason under a dated "## Comments" heading.
- For A: the regression cases named above are tests in `crates/gavin-relay`, they fail before the change and pass after it, and the checks in CLAUDE.md pass for every part you touched.
- For B or C: no doc still promises a per-Workstation bandwidth limit that nothing enforces.
- You commit only your own files.
