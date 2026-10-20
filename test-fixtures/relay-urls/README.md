# Relay URLs, and whether they may be dialled

`cases.json` is one table read by two suites:

- `crates/protocol/src/relay.rs` — `RelayUrl::parse`, the rule the daemon and
  the Companion core dial by;
- `app/src/lib/core/remoteAccess.test.ts` — `relayUrlProblem`, the mirror of
  that rule the Settings field's hint is written from.

The two are separate implementations of one rule, in two languages, and a
mirror is only a mirror while something holds it to the original. This file is
that: a case added here is asserted on both sides, so the hint under the field
cannot say "the daemon will not dial it" about a URL the daemon is dialling, or
say nothing about one it refuses.

Each case is `url`, and either `dial` — with the `host`, `port` and whether the
host is `local` — or `refuse`, with the reason's name.

A case may also carry `thisMachine`: the `hosts` this machine answers to and the
`directPorts` its daemons' direct listeners take (ADR 0009). Such a case is
judged as above and then by `RelayUrl::refuse_direct_listener` (and
`relayUrlProblem`'s same check): a URL naming one of this machine's direct
listeners is refused as `direct-listener`, because a direct listener is not a
Relay and the daemon would be dialling itself. Loopback, `localhost` and the
unspecified address are this machine whatever `hosts` says. A case without
`thisMachine` is judged by `parse` alone.
