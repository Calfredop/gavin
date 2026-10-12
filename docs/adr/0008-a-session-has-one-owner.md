# A session takes input from one owner at a time

The Companion spec chose no locks between clients (story 57). The last write won, and keystrokes from the desk, an iPhone and an iPad interleaved in one PTY. Once a person actually used two Devices at once, that turned out to be the wrong trade. A quick reply from one Device landed in the middle of a line typed on another, and nothing on either screen said someone else was driving.

We decided that a session has at most one **Owner**: a Device, or the desk by default. Everyone else sees the session **Locked**. They can still read and scroll it, but the daemon refuses their input until they **Take over**. The lock is a courtesy, not a security boundary (ADR 0004 still gives every unlocked Device full control). Any client can take a session in one tap, and the only friction is a confirm when the owner typed within the last few seconds.

- **The daemon decides, in memory.** Two Devices racing a Take over need exactly one winner, so the arbiter is one mutex in the daemon (`ownership.rs`), not the desk webview. The record does not survive a restart, like presence.
- **The daemon answers ownership requests without forwarding them.** A Device reaches every desktop command through `InvokeDesktop`, and the desk host runs each one as the desk. A Take over forwarded to the host would therefore be a Take over by the desk. The two ownership commands are marked `RemoteAllowance::Daemon` in the command table, and the daemon answers them with the asking Device's identity.
- **The desk's system writers are exempt.** Rails, auto-resume, follow-up delivery and MCP calls write on the desk's connection, and a rail that stalls on a pocketed phone's lock is worse than one stray line. The daemon cannot refuse the desk's human without refusing those writers too, so the desk enforces the lock on its own surfaces.
- **A pocketed owner never strands a session.** When the owner's last connection ends, a 30-second grace starts. When it runs out, the session goes back to the desk. A revoked owner releases its sessions at once.

## Considered options

- **Keep no locks; strengthen the typing marker.** Rejected. A marker names the problem after the interleaving has already happened.
- **A hard lock that only the owner can release.** Rejected. A phone left on a table would hold the session hostage, and ADR 0004's laptop model already trusts every unlocked Device with the same reach.
- **Enforce in the desk host.** Rejected. Every forwarded call reaches the host as the desk, so the host cannot tell who is asking. The daemon is the only place that holds the Device's identity.
