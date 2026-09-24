---
order: 22528
kind: task
title: Remote access: the trust store — trust.rs, devices.sqlite, the daemon's static key, revocation
status: To Do
parent: feat-remote-access-phase-2.md
complexity: complex
---
First task of [feat-remote-access-phase-2](./feat-remote-access-phase-2.md); read that card and `docs/security/05-remote-access.md` §3 ("Where the trust is stored", "How many, for how long", "Revocation") and §4 first.

Build `crates/daemon/src/trust.rs`: a daemon-owned SQLite file `devices.sqlite`, `0600`, in the state directory beside `registry.sqlite` (on Windows the same per-user directory the pipe token lives in), opened the way `registry.rs`'s `Registry::open` does — `CREATE TABLE IF NOT EXISTS` plus an `ALTER TABLE … ADD COLUMN` per later column, swallowed as a duplicate-column error. CLAUDE.md: a column added only to `CREATE TABLE IF NOT EXISTS` never reaches an existing database, so even at v1 write the `pre_v*`-style test against a hand-built old schema, so the next column has a test to copy.

Rows per §3: `device_id`, static public key, name, role (`remote`; `app` reserved for §9's ssh case), `created_at`, `last_seen_at`, `revoked_at`. The daemon's own static key pair lives in the same file, generated on first open — x25519, from the crate the pairing task will use for Noise (`snow` with its default resolver), so one dependency serves both; add it `--locked` and say in the commit body why that crate. The store answers: list, insert-after-confirm, revoke one, revoke all (which also rotates the daemon key and returns the new public key), touch `last_seen_at`, and refuses a device unseen for ninety days until it re-pairs. A cap of three devices, as a store rule the settings task can later raise.

Wire revocation into the connection: `ClientIdentity` grows `device_id: Option<String>` (§4 lists it; today's roles never set it), and revoking a device drops every live connection carrying that id — a lookup over the connections the server already tracks, not a hunt. No listener, no dial, no request shapes yet: the pairing task adds the protocol, and this task's public surface is Rust functions and their tests.

Tests in `trust.rs`: open on a fresh directory creates the file with the right mode (unix) and one key pair; a revoked row is listed as revoked and refused; revoke-all rotates the key so the old public key no longer matches; a ninety-day-stale device is refused and a fresh one is not; the device cap. A `server` test: a connection constructed with a `device_id` is closed when that device is revoked. `cargo test -p gavin-daemon -- --test-threads=4`. Commit only the files you touched.
