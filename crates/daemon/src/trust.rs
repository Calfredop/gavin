//! The trust store: which devices this daemon has paired with, and the
//! daemon's own static key pair.
//!
//! `docs/security/05-remote-access.md` §3 settles where this lives and
//! why: a daemon-owned SQLite file, `0600`, in the same `0700` directory
//! as the socket, beside `registry.sqlite`. Rejected there, with reasons:
//! the app's `config.json` (the daemon enforces, so the daemon must own
//! the truth -- a revocation has to hold at 02:00 with the app closed,
//! and `persist_workspaces` has already lost fields to save sites that
//! did not carry them), and the macOS Keychain for the daemon's key (a
//! headless process that stalls on an unlock dialog is a daemon that does
//! not come back after reboot).
//!
//! This module is the whole of phase 2's first task: Rust functions and
//! their tests. There is no listener, no dial and no request shape here
//! -- the pairing task adds the protocol that calls into this, and
//! phase 3's `remote.rs` adds the transport that carries it.

// Most of this module has no caller in the binary yet, by design: the
// card that builds it lands the store and its tests, and the two tasks
// after it land the callers -- the pairing handshake that writes a
// device, and the Settings panel that lists and revokes one. Allowed at
// the module rather than item by item so that list does not have to be
// maintained as each phase claims another function; the tests below are
// what proves every one of them works meanwhile. Same reasoning as
// `server::Role::Remote`, which has carried its own allow since phase 1.
#![allow(dead_code)]

use crate::registry::secure_db_file;
use rusqlite::{params, Connection};

/// The Noise pattern the pairing handshake runs (§3: "a Noise `XX`
/// handshake with the pairing secret mixed in as a pre-shared key").
///
/// It is a constant *here*, in the store, rather than in the pairing
/// module that will use it, for one reason: the daemon's static key pair
/// is generated from this string's DH function, and a handshake that
/// later names a different curve would silently fail to find the key it
/// already has on disk. One string, one key type, both ends of the
/// feature.
///
/// `psk3` rather than `psk0`: XX has three messages, and mixing the
/// pairing secret into the last one means a scanner that photographed
/// the QR still has to complete the full mutual exchange before the
/// secret does anything for it.
pub const NOISE_PARAMS: &str = "Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s";

/// How many paired, unrevoked devices the store will hold (§3: "Three
/// devices by default (Settings can raise it)").
///
/// A store rule, not a UI one, because the store is what a compromised or
/// buggy caller reaches: the cap has to hold whether the insert came from
/// the Settings panel or from a pairing handshake that ran without one.
/// `set_device_cap` is the seam the settings task raises it through.
pub const DEFAULT_DEVICE_CAP: usize = 3;

/// How long a device may go unseen before it must re-pair (§3: "a device
/// unseen for ninety days is shown greyed with 're-pair to use', and is
/// refused until re-paired").
///
/// Deliberately not an expiry stamped at pairing time: "a certificate
/// that lapses on a laptop that sleeps for a week is a re-pair the human
/// did not ask for". And deliberately not renewed silently on use, which
/// is how a stolen phone renews itself -- the renewal here is a fresh
/// desktop confirmation, nothing less.
pub const STALE_AFTER_DAYS: i64 = 90;

const STALE_AFTER_US: i64 = STALE_AFTER_DAYS * 24 * 60 * 60 * 1_000_000;

/// `trust_meta` keys for the daemon's own static key pair. Two rows
/// rather than one blob so a future reader can take the public half
/// without parsing past the private one.
const META_PRIVATE_KEY: &str = "static_private_key";
const META_PUBLIC_KEY: &str = "static_public_key";

/// `trust_meta` keys for the remote-access settings (`SetRemoteAccess`).
///
/// Here rather than in the app's `config.json` for the first of the three
/// reasons §3 gives about the device rows themselves, and it applies
/// unchanged: the daemon is what will dial (phase 3), so the daemon has
/// to own whether it should -- a setting the app holds is a setting that
/// is absent at 02:00 with the app closed, which is precisely when the
/// answer matters. It is also the file the QR's rendezvous list is read
/// out of, so keeping it beside the key the QR carries means one read,
/// one lock, and no way for the two halves of one payload to disagree.
const META_REMOTE_ENABLED: &str = "remote_access_enabled";
const META_RELAY_URL: &str = "remote_access_relay_url";

/// The daemon's clock, in microseconds since the epoch -- the same unit
/// and the same saturating read as `registry::now_us`, so timestamps from
/// the two stores are directly comparable and a machine whose date is
/// wrong does not take the daemon down.
pub(crate) fn now_us() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0)
}

/// What a paired device is allowed to be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceRole {
    /// A phone paired through §3's ceremony. The only role this phase
    /// writes.
    Remote,
    /// Reserved for §9's ssh case, where the thing on the other end of
    /// the handshake is another gavin app rather than a phone. Nothing
    /// writes it yet; it is named so the column's vocabulary is settled
    /// before a second writer exists.
    App,
    /// A role string this build does not recognise -- written by a NEWER
    /// daemon into the same `devices.sqlite`, which both builds share
    /// (see CLAUDE.md on what the dev and release daemons deliberately
    /// share).
    ///
    /// Carries the text so a row this build cannot read is never
    /// REWRITTEN as one it invented, exactly like
    /// `registry::SessionStatus::Unknown`. And `admit` refuses it:
    /// defaulting an unrecognised role to `remote` would be granting a
    /// role rather than reading one.
    Other(String),
}

impl DeviceRole {
    pub fn as_str(&self) -> &str {
        match self {
            DeviceRole::Remote => "remote",
            DeviceRole::App => "app",
            DeviceRole::Other(s) => s,
        }
    }

    pub fn from_stored(s: &str) -> Self {
        match s {
            "remote" => DeviceRole::Remote,
            "app" => DeviceRole::App,
            other => DeviceRole::Other(other.to_string()),
        }
    }
}

/// One row of the trust store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    pub device_id: String,
    /// The device's Noise static public key -- the thing the handshake
    /// proves possession of, and the only identity that matters. Stored
    /// as the raw bytes the handshake hands over, so no encoding has to
    /// agree between this store and `snow`.
    pub public_key: Vec<u8>,
    pub name: String,
    pub role: DeviceRole,
    pub created_at_us: i64,
    pub last_seen_at_us: i64,
    pub revoked_at_us: Option<i64>,
}

impl Device {
    pub fn is_revoked(&self) -> bool {
        self.revoked_at_us.is_some()
    }

    /// Whether this device has gone unseen long enough to need re-pairing.
    /// Takes the clock rather than reading it so a caller that is already
    /// deciding several devices at once judges them all against the same
    /// instant.
    pub fn is_stale_at(&self, now_us: i64) -> bool {
        now_us.saturating_sub(self.last_seen_at_us) >= STALE_AFTER_US
    }
}

/// The answer to "may the device holding this static key connect?".
///
/// An enum rather than a bool because every refusal has a different thing
/// to say to the human, and the pairing task has to say it: a revoked
/// device is one they revoked, a stale one needs re-pairing, and an
/// unknown key is a phone that was never here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Admission {
    /// Paired, not revoked, seen inside the window.
    Admitted(Device),
    /// No row holds this static key.
    Unknown,
    /// Revoked from the desktop. Kept as a row, so the refusal can name
    /// the device rather than pretend it was never here.
    Revoked(Device),
    /// Unseen for `STALE_AFTER_DAYS`: "re-pair to use".
    Stale(Device),
    /// The row's role is one this build does not recognise, so this build
    /// cannot say what it would be allowed to do. See `DeviceRole::Other`.
    UnreadableRole(Device),
}

impl Admission {
    pub fn admitted(&self) -> Option<&Device> {
        match self {
            Admission::Admitted(d) => Some(d),
            _ => None,
        }
    }

    /// Why the device was refused, in words a push can carry. `None` when
    /// it was not refused.
    pub fn refusal(&self) -> Option<&'static str> {
        match self {
            Admission::Admitted(_) => None,
            Admission::Unknown => Some("this device is not paired with gavin"),
            Admission::Revoked(_) => Some("this device was revoked — pair it again to use it"),
            Admission::Stale(_) => {
                Some("this device has not been seen for 90 days — pair it again to use it")
            }
            Admission::UnreadableRole(_) => {
                Some("this device was paired by a newer gavin — update gavin to use it")
            }
        }
    }
}

/// Whether this daemon should be reachable from away, and through what.
///
/// Two values rather than one `Option<String>` where `None` means off,
/// because the human's relay URL must survive them turning the switch off
/// and on again -- a setting that forgets what it was is a setting they
/// have to retype, and a URL they retype is a URL they can mistype.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RemoteAccess {
    pub enabled: bool,
    /// `None` for "no relay": direct only (LAN, Tailscale), which §5
    /// calls the same code path minus the relay. Kept RAW -- the daemon
    /// has nothing to validate a self-hosted relay's URL against (§11
    /// Q2), and a rule it invented would refuse an address that works.
    pub relay_url: Option<String>,
}

impl RemoteAccess {
    /// The rendezvous list the QR carries (§3, "What the QR carries":
    /// "the relay URL, or LAN host and port, or both").
    ///
    /// EMPTY in this phase unless the human has set a relay, and empty is
    /// the honest answer rather than a gap: there is no transport yet, so
    /// there is nowhere to point a phone. Phase 3 is what adds the LAN
    /// address beside it.
    pub fn rendezvous(&self) -> Vec<String> {
        self.relay_url.iter().cloned().collect()
    }
}

/// The daemon's paired devices and its own static key pair.
///
/// Not `Sync` (it holds a `rusqlite::Connection`), and held the way
/// `Registry` is: behind a `Mutex` on `SessionManager`.
pub struct TrustStore {
    conn: Connection,
    device_cap: usize,
}

impl TrustStore {
    /// Opens (creating) `devices.sqlite`, generating the daemon's static
    /// key pair the first time.
    ///
    /// Schema handling is `Registry::open`'s, for the reason CLAUDE.md
    /// states: `CREATE TABLE IF NOT EXISTS` is a no-op against a file
    /// that already has the table, so a column only ever reaches an
    /// existing database through its own `ALTER TABLE ... ADD COLUMN`.
    /// `revoked_at_us` is therefore added *below* rather than in the
    /// CREATE above -- deliberately, at v1, so that both paths (fresh
    /// file, existing file) run the same statement and
    /// `a_devices_database_from_before_revocation_gains_the_column` is a
    /// test the next column can be added by copying.
    ///
    /// The unique index on `public_key` is an index rather than a column
    /// constraint for the same reason: SQLite cannot ALTER a UNIQUE onto
    /// an existing column, but `CREATE UNIQUE INDEX IF NOT EXISTS`
    /// reaches a table that was already there.
    pub fn open(path: &std::path::Path) -> anyhow::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS devices (
                device_id TEXT PRIMARY KEY,
                public_key BLOB NOT NULL,
                name TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'remote',
                created_at_us INTEGER NOT NULL,
                last_seen_at_us INTEGER NOT NULL
            );
            -- The daemon's own static key pair, and nothing else yet.
            -- A key/value table rather than a one-row table so the next
            -- daemon-wide fact (a rotation counter, a stored device cap)
            -- is a row, not a migration.
            CREATE TABLE IF NOT EXISTS trust_meta (
                key TEXT PRIMARY KEY,
                value BLOB NOT NULL
            );
            -- One row per static key: the key IS the identity, so two
            -- rows claiming it would make `admit` pick one arbitrarily.
            CREATE UNIQUE INDEX IF NOT EXISTS devices_by_public_key
                ON devices (public_key)",
        )?;
        // `ALTER TABLE ADD COLUMN` has no IF NOT EXISTS in SQLite, and
        // re-running it is a plain error rather than a corruption risk,
        // so the duplicate is swallowed rather than probed for with a
        // pragma -- the same shape, and the same reasoning, as
        // `Registry::open`.
        //
        // Nullable with no default: `NULL` is exactly "not revoked", and
        // there is no timestamp that means it.
        for stmt in ["ALTER TABLE devices ADD COLUMN revoked_at_us INTEGER"] {
            let _ = conn.execute(stmt, []);
        }
        let store = Self { conn, device_cap: DEFAULT_DEVICE_CAP };
        store.ensure_static_keypair()?;
        // Reasserted on every open, not just the one that creates the
        // file: there is no on-disk marker for a mode, and this file
        // holds a private key. Same call, same reason, as the three
        // stores beside it.
        secure_db_file(path)?;
        Ok(store)
    }

    /// How many unrevoked devices this store will hold.
    pub fn device_cap(&self) -> usize {
        self.device_cap
    }

    /// Raises (or lowers) the cap. In memory only: where the number is
    /// *persisted* is the settings task's call, and it applies whatever
    /// it persists here at open. Lowering below the number of devices
    /// already paired does not un-pair any of them -- it only refuses the
    /// next insert, which is the one decision a cap gets to make.
    pub fn set_device_cap(&mut self, cap: usize) {
        self.device_cap = cap;
    }

    // -- the daemon's own key pair ------------------------------------

    /// The daemon's static public key: what the QR carries (§3) and what
    /// every paired phone pinned.
    ///
    /// Read from the file on every call rather than cached on the struct,
    /// so `revoke_all`'s rotation cannot leave a stale copy behind in a
    /// caller that happened to read first.
    pub fn static_public_key(&self) -> anyhow::Result<Vec<u8>> {
        self.meta(META_PUBLIC_KEY)?
            .ok_or_else(|| anyhow::anyhow!("devices.sqlite: no daemon static public key"))
    }

    /// The private half, for the handshake to build with. Never leaves
    /// the daemon: §3's "what it must not carry" names the daemon's
    /// private key first.
    pub fn static_private_key(&self) -> anyhow::Result<Vec<u8>> {
        self.meta(META_PRIVATE_KEY)?
            .ok_or_else(|| anyhow::anyhow!("devices.sqlite: no daemon static private key"))
    }

    fn meta(&self, key: &str) -> anyhow::Result<Option<Vec<u8>>> {
        let found = self
            .conn
            .query_row("SELECT value FROM trust_meta WHERE key = ?1", params![key], |row| {
                row.get::<_, Vec<u8>>(0)
            })
            .ok();
        Ok(found)
    }

    fn set_meta(&self, key: &str, value: &[u8]) -> anyhow::Result<()> {
        self.conn.execute(
            "INSERT INTO trust_meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![key, value],
        )?;
        Ok(())
    }

    /// Generates the key pair if either half is missing.
    ///
    /// "Either", not "both": a half-written pair is not a key, and the
    /// only safe reading of one is to mint a fresh pair -- a daemon that
    /// kept a public key it has no private half for would hand out QR
    /// codes no phone could ever complete a handshake against.
    fn ensure_static_keypair(&self) -> anyhow::Result<()> {
        if self.meta(META_PRIVATE_KEY)?.is_some() && self.meta(META_PUBLIC_KEY)?.is_some() {
            return Ok(());
        }
        self.write_fresh_keypair()
    }

    fn write_fresh_keypair(&self) -> anyhow::Result<()> {
        let keypair = generate_static_keypair()?;
        self.set_meta(META_PRIVATE_KEY, &keypair.private)?;
        self.set_meta(META_PUBLIC_KEY, &keypair.public)?;
        Ok(())
    }

    // -- remote-access settings ---------------------------------------

    /// Whether remote access is switched on, and which relay to be
    /// reachable through.
    ///
    /// **Stored and inert in phase 2.** Nothing in this build reads
    /// `enabled` to decide to dial or listen -- §10's "must not" for this
    /// phase is that no listener opens and no relay is dialled, and the
    /// way to be sure of that is for there to be no code that could.
    /// "Remote access on" today means rows in a file and a panel that
    /// says so in its own words.
    pub fn remote_access(&self) -> anyhow::Result<RemoteAccess> {
        // Absent means off. A daemon that had never been told is not a
        // daemon that was told yes.
        let enabled = self.meta(META_REMOTE_ENABLED)?.map(|v| v == b"1").unwrap_or(false);
        let relay_url = match self.meta(META_RELAY_URL)? {
            // An empty stored value is "no relay", not an empty URL: the
            // human clearing the field must not leave something that
            // parses as an address.
            Some(bytes) => {
                let s = String::from_utf8_lossy(&bytes).trim().to_string();
                if s.is_empty() {
                    None
                } else {
                    Some(s)
                }
            }
            None => None,
        };
        Ok(RemoteAccess { enabled, relay_url })
    }

    pub fn set_remote_access(&self, settings: &RemoteAccess) -> anyhow::Result<()> {
        self.set_meta(META_REMOTE_ENABLED, if settings.enabled { b"1" } else { b"0" })?;
        self.set_meta(
            META_RELAY_URL,
            settings.relay_url.as_deref().unwrap_or("").trim().as_bytes(),
        )?;
        Ok(())
    }

    // -- devices -------------------------------------------------------

    /// Every device, revoked ones included, oldest first.
    ///
    /// Revoked rows are listed rather than deleted so the Settings list
    /// can show what was revoked and when; `admit` is what refuses them.
    pub fn list(&self) -> anyhow::Result<Vec<Device>> {
        let sql = format!("SELECT {DEVICE_COLUMNS} FROM devices ORDER BY created_at_us, device_id");
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map([], device_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn device(&self, device_id: &str) -> anyhow::Result<Option<Device>> {
        let sql = format!("SELECT {DEVICE_COLUMNS} FROM devices WHERE device_id = ?1");
        Ok(self.conn.query_row(&sql, params![device_id], device_from_row).ok())
    }

    /// The device holding this static key, if any.
    ///
    /// The pairing task calls this DURING the handshake, before it pushes
    /// `DevicePairingRequested`, so a phone that is re-pairing is offered
    /// under the `device_id` it already has rather than a second one.
    pub fn device_for_key(&self, public_key: &[u8]) -> anyhow::Result<Option<Device>> {
        let sql = format!("SELECT {DEVICE_COLUMNS} FROM devices WHERE public_key = ?1");
        Ok(self.conn.query_row(&sql, params![public_key], device_from_row).ok())
    }

    /// Writes a device into the store. §3: this runs only after the human
    /// has compared the SAS and confirmed **on the desktop** -- the store
    /// does not do the confirming, it records that it happened.
    ///
    /// A key that is already in the store REVIVES its row rather than
    /// inserting a second one: the phone keeps its key across a re-pair,
    /// so the same key arriving again is the same phone, and a second row
    /// would mean a revocation that only reached one of them. The revived
    /// row keeps its `device_id` and `created_at_us` -- which is why this
    /// returns the `Device` rather than `()`: a caller that minted
    /// `device_id` for the push must read back the id the store actually
    /// used, or a later revoke, grant or live-connection drop keyed by it
    /// names nothing.
    ///
    /// Reviving a REVOKED row is allowed, and is the same act as pairing
    /// a new phone: the human just compared a six-digit code and pressed
    /// confirm. Revocation is "this device is no longer trusted", not a
    /// ban.
    pub fn confirm_device(
        &self,
        device_id: &str,
        public_key: &[u8],
        name: &str,
        role: DeviceRole,
    ) -> anyhow::Result<Device> {
        self.confirm_device_at(device_id, public_key, name, role, now_us())
    }

    pub fn confirm_device_at(
        &self,
        device_id: &str,
        public_key: &[u8],
        name: &str,
        role: DeviceRole,
        now_us: i64,
    ) -> anyhow::Result<Device> {
        if let Some(existing) = self.device_for_key(public_key)? {
            self.conn.execute(
                "UPDATE devices
                    SET name = ?2, role = ?3, last_seen_at_us = ?4, revoked_at_us = NULL
                  WHERE device_id = ?1",
                params![existing.device_id, name, role.as_str(), now_us],
            )?;
            return self
                .device(&existing.device_id)?
                .ok_or_else(|| anyhow::anyhow!("devices.sqlite: revived device vanished"));
        }

        // The cap counts UNREVOKED devices only. Counting revoked rows
        // would mean three revocations brick pairing until someone went
        // at the file with sqlite3 -- and a revoked device is precisely
        // one that is not using its slot.
        let active = self.active_device_count()?;
        if active >= self.device_cap {
            anyhow::bail!(
                "gavin-daemon: {active} devices are already paired (the limit is {}) — revoke one before pairing another",
                self.device_cap
            );
        }
        self.conn.execute(
            "INSERT INTO devices
                (device_id, public_key, name, role, created_at_us, last_seen_at_us, revoked_at_us)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, NULL)",
            params![device_id, public_key, name, role.as_str(), now_us],
        )?;
        self.device(device_id)?
            .ok_or_else(|| anyhow::anyhow!("devices.sqlite: inserted device vanished"))
    }

    /// How many devices are currently using a slot against the cap.
    pub fn active_device_count(&self) -> anyhow::Result<usize> {
        let n: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM devices WHERE revoked_at_us IS NULL",
            [],
            |row| row.get(0),
        )?;
        Ok(n as usize)
    }

    /// Marks one device revoked. `true` if this call is what revoked it;
    /// `false` if there was no such device or it was already revoked.
    ///
    /// The timestamp of the FIRST revocation is kept -- `WHERE
    /// revoked_at_us IS NULL` -- so a second press of Revoke does not
    /// rewrite when the human actually stopped trusting the phone.
    ///
    /// This is only the row. Dropping the live connections that carry the
    /// device id is `SessionManager::revoke_device`'s half, because the
    /// connections are the server's to hold, not the store's.
    pub fn revoke(&self, device_id: &str) -> anyhow::Result<bool> {
        self.revoke_at(device_id, now_us())
    }

    pub fn revoke_at(&self, device_id: &str, now_us: i64) -> anyhow::Result<bool> {
        let changed = self.conn.execute(
            "UPDATE devices SET revoked_at_us = ?2
              WHERE device_id = ?1 AND revoked_at_us IS NULL",
            params![device_id, now_us],
        )?;
        Ok(changed > 0)
    }

    /// Revokes every device and rotates the daemon's static key,
    /// returning the new public key.
    ///
    /// §3: the rotation is the point. Marking rows is a change to a file;
    /// a new static key invalidates every phone at once **even if the
    /// store is somehow restored from a backup**, because each phone
    /// pinned the old key and the handshake it pinned it for no longer
    /// completes. That is what makes this the one-button answer to a lost
    /// phone.
    pub fn revoke_all(&self) -> anyhow::Result<Vec<u8>> {
        self.revoke_all_at(now_us())
    }

    pub fn revoke_all_at(&self, now_us: i64) -> anyhow::Result<Vec<u8>> {
        self.conn.execute(
            "UPDATE devices SET revoked_at_us = ?1 WHERE revoked_at_us IS NULL",
            params![now_us],
        )?;
        self.write_fresh_keypair()?;
        self.static_public_key()
    }

    /// Records that a device was seen just now -- what holds the ninety-day
    /// staleness window open. `false` if there is no such device.
    pub fn touch(&self, device_id: &str) -> anyhow::Result<bool> {
        self.touch_at(device_id, now_us())
    }

    pub fn touch_at(&self, device_id: &str, now_us: i64) -> anyhow::Result<bool> {
        let changed = self.conn.execute(
            "UPDATE devices SET last_seen_at_us = ?2 WHERE device_id = ?1",
            params![device_id, now_us],
        )?;
        Ok(changed > 0)
    }

    /// May the device holding this static key connect?
    ///
    /// Deliberately does NOT touch `last_seen_at`: §3 rejects "silent
    /// renewal on use", and a check that renewed what it checks would be
    /// exactly that. `touch` is a separate call the transport makes once
    /// a connection is actually established.
    pub fn admit(&self, public_key: &[u8]) -> anyhow::Result<Admission> {
        self.admit_at(public_key, now_us())
    }

    pub fn admit_at(&self, public_key: &[u8], now_us: i64) -> anyhow::Result<Admission> {
        let device = match self.device_for_key(public_key)? {
            Some(d) => d,
            None => return Ok(Admission::Unknown),
        };
        if device.is_revoked() {
            return Ok(Admission::Revoked(device));
        }
        if matches!(device.role, DeviceRole::Other(_)) {
            return Ok(Admission::UnreadableRole(device));
        }
        if device.is_stale_at(now_us) {
            return Ok(Admission::Stale(device));
        }
        Ok(Admission::Admitted(device))
    }
}

const DEVICE_COLUMNS: &str =
    "device_id, public_key, name, role, created_at_us, last_seen_at_us, revoked_at_us";

fn device_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Device> {
    Ok(Device {
        device_id: row.get(0)?,
        public_key: row.get(1)?,
        name: row.get(2)?,
        role: DeviceRole::from_stored(&row.get::<_, String>(3)?),
        created_at_us: row.get(4)?,
        last_seen_at_us: row.get(5)?,
        revoked_at_us: row.get(6)?,
    })
}

/// A fresh x25519 static key pair, from the same crate and the same
/// parameter string the pairing handshake will run on.
///
/// `snow` rather than `x25519-dalek` directly: the handshake needs snow
/// regardless, and a key minted by a different crate is a key that has to
/// be proved byte-compatible with the one snow expects. One dependency,
/// one representation, and `NOISE_PARAMS` names the curve exactly once.
fn generate_static_keypair() -> anyhow::Result<snow::Keypair> {
    let params: snow::params::NoiseParams = NOISE_PARAMS
        .parse()
        .map_err(|e| anyhow::anyhow!("devices.sqlite: bad Noise parameters {NOISE_PARAMS:?}: {e:?}"))?;
    Ok(snow::Builder::new(params).generate_keypair()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in static key. Not a real x25519 key and it does not need
    /// to be: the store records whatever the handshake proved, and every
    /// test here is about the row, never the curve. 32 bytes because that
    /// is the size the real ones are.
    fn key(tag: u8) -> Vec<u8> {
        vec![tag; 32]
    }

    fn open_store(dir: &tempfile::TempDir) -> TrustStore {
        TrustStore::open(&dir.path().join("devices.sqlite")).unwrap()
    }

    const DAY_US: i64 = 24 * 60 * 60 * 1_000_000;

    #[test]
    fn opening_a_fresh_directory_creates_the_file_and_one_key_pair() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devices.sqlite");
        let store = TrustStore::open(&path).unwrap();

        assert!(path.exists(), "devices.sqlite was not created");

        // 0600, like the socket and the three stores beside it. Only unix
        // states this as a mode -- on Windows the file sits under
        // %LOCALAPPDATA%, inheriting the user's own profile ACL, which is
        // the same reasoning `secure_db_file` carries.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "devices.sqlite mode {mode:o}");
        }

        let public = store.static_public_key().unwrap();
        let private = store.static_private_key().unwrap();
        assert_eq!(public.len(), 32, "x25519 public key is 32 bytes");
        assert_eq!(private.len(), 32, "x25519 private key is 32 bytes");
        assert_ne!(public, private);
        assert!(store.list().unwrap().is_empty(), "a fresh store has no devices");
    }

    #[test]
    fn reopening_keeps_the_same_key_pair() {
        // The whole point of storing it: the QR a phone scanned last week
        // named this key, and a daemon that minted a new one at every
        // start would have un-paired every device on every restart.
        let dir = tempfile::tempdir().unwrap();
        let first = open_store(&dir).static_public_key().unwrap();
        let second = open_store(&dir).static_public_key().unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn two_stores_do_not_share_a_key_pair() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        assert_ne!(
            open_store(&a).static_public_key().unwrap(),
            open_store(&b).static_public_key().unwrap(),
            "the key pair must come from the CSPRNG, not from a constant"
        );
    }

    #[test]
    fn the_noise_parameters_parse_and_name_a_32_byte_curve() {
        // Guards the constant itself: a typo in NOISE_PARAMS would
        // otherwise only surface when the pairing task first tried to run
        // a handshake, long after keys had been minted from whatever
        // curve the typo resolved to.
        let params: snow::params::NoiseParams = NOISE_PARAMS.parse().unwrap();
        let keypair = snow::Builder::new(params).generate_keypair().unwrap();
        assert_eq!(keypair.public.len(), 32);
    }

    #[test]
    fn a_confirmed_device_is_listed_and_admitted() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);

        let device = store
            .confirm_device("dev-1", &key(1), "Pixel", DeviceRole::Remote)
            .unwrap();
        assert_eq!(device.device_id, "dev-1");
        assert_eq!(device.name, "Pixel");
        assert_eq!(device.role, DeviceRole::Remote);
        assert!(!device.is_revoked());

        assert_eq!(store.list().unwrap(), vec![device.clone()]);
        assert_eq!(store.admit(&key(1)).unwrap(), Admission::Admitted(device));
        assert_eq!(store.admit(&key(9)).unwrap(), Admission::Unknown);
    }

    #[test]
    fn a_revoked_device_is_listed_as_revoked_and_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        store.confirm_device("dev-1", &key(1), "Pixel", DeviceRole::Remote).unwrap();

        assert!(store.revoke("dev-1").unwrap());

        // Listed, not deleted: the Settings list shows what was revoked.
        let listed = store.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].is_revoked(), "the row must carry revoked_at_us");

        match store.admit(&key(1)).unwrap() {
            Admission::Revoked(d) => assert_eq!(d.device_id, "dev-1"),
            other => panic!("expected Revoked, got {other:?}"),
        }

        // A second revoke changes nothing and does not rewrite WHEN the
        // human stopped trusting the phone.
        let first_at = listed[0].revoked_at_us;
        assert!(!store.revoke("dev-1").unwrap(), "already revoked");
        assert_eq!(store.device("dev-1").unwrap().unwrap().revoked_at_us, first_at);

        assert!(!store.revoke("never-paired").unwrap());
    }

    #[test]
    fn revoking_frees_the_slot_and_re_pairing_revives_the_same_row() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        let paired = store
            .confirm_device("dev-1", &key(1), "Pixel", DeviceRole::Remote)
            .unwrap();
        store.revoke("dev-1").unwrap();
        assert_eq!(store.active_device_count().unwrap(), 0);

        // The phone kept its key, so re-pairing it is the SAME row: the
        // caller's freshly minted id is ignored and the stored one comes
        // back, which is what keeps a later revoke aimed at the right
        // device.
        let revived = store
            .confirm_device("dev-2", &key(1), "Pixel (again)", DeviceRole::Remote)
            .unwrap();
        assert_eq!(revived.device_id, "dev-1");
        assert_eq!(revived.created_at_us, paired.created_at_us);
        assert_eq!(revived.name, "Pixel (again)");
        assert!(!revived.is_revoked());
        assert_eq!(store.list().unwrap().len(), 1, "no second row for the same key");
        assert!(store.admit(&key(1)).unwrap().admitted().is_some());
    }

    #[test]
    fn revoke_all_rotates_the_key_so_the_old_public_key_no_longer_matches() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        store.confirm_device("dev-1", &key(1), "Pixel", DeviceRole::Remote).unwrap();
        store.confirm_device("dev-2", &key(2), "iPhone", DeviceRole::Remote).unwrap();
        let before = store.static_public_key().unwrap();

        let after = store.revoke_all().unwrap();

        assert_ne!(after, before, "revoke all must rotate the daemon's static key");
        assert_eq!(store.static_public_key().unwrap(), after, "and the rotation must persist");
        assert_eq!(
            store.static_private_key().unwrap().len(),
            32,
            "the private half must be rotated with it, not left behind"
        );
        // Every device, not just one.
        for d in store.list().unwrap() {
            assert!(d.is_revoked(), "{} survived revoke all", d.device_id);
        }
        assert!(matches!(store.admit(&key(1)).unwrap(), Admission::Revoked(_)));
        assert!(matches!(store.admit(&key(2)).unwrap(), Admission::Revoked(_)));

        // And it survives a restart -- a rotation only held in memory is
        // a rotation a reboot undoes.
        assert_eq!(open_store(&dir).static_public_key().unwrap(), after);
    }

    #[test]
    fn a_device_unseen_for_ninety_days_is_refused_and_a_fresh_one_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        let paired_at = 1_000 * DAY_US;
        store
            .confirm_device_at("stale", &key(1), "Old phone", DeviceRole::Remote, paired_at)
            .unwrap();
        store
            .confirm_device_at("fresh", &key(2), "New phone", DeviceRole::Remote, paired_at)
            .unwrap();

        // One of them was seen again on day 60; the other never was.
        let day_60 = paired_at + 60 * DAY_US;
        assert!(store.touch_at("fresh", day_60).unwrap());

        let day_91 = paired_at + 91 * DAY_US;
        match store.admit_at(&key(1), day_91).unwrap() {
            Admission::Stale(d) => assert_eq!(d.device_id, "stale"),
            other => panic!("expected Stale, got {other:?}"),
        }
        assert!(
            store.admit_at(&key(2), day_91).unwrap().admitted().is_some(),
            "a device seen 31 days ago is not stale"
        );

        // The boundary is ninety days exactly, and a day short of it is
        // still admitted -- pinned so a later change to the window is a
        // failing test rather than a silent re-pair the human did not ask
        // for.
        assert!(store
            .admit_at(&key(1), paired_at + (STALE_AFTER_DAYS - 1) * DAY_US)
            .unwrap()
            .admitted()
            .is_some());
        assert!(matches!(
            store.admit_at(&key(1), paired_at + STALE_AFTER_DAYS * DAY_US).unwrap(),
            Admission::Stale(_)
        ));

        // And re-pairing is what clears it, exactly as §3 says.
        store
            .confirm_device_at("stale", &key(1), "Old phone", DeviceRole::Remote, day_91)
            .unwrap();
        assert!(store.admit_at(&key(1), day_91).unwrap().admitted().is_some());
    }

    #[test]
    fn the_store_holds_three_devices_and_refuses_the_fourth() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = open_store(&dir);
        assert_eq!(store.device_cap(), 3);

        for n in 1..=3u8 {
            store
                .confirm_device(&format!("dev-{n}"), &key(n), "Phone", DeviceRole::Remote)
                .unwrap();
        }

        let err = store
            .confirm_device("dev-4", &key(4), "One too many", DeviceRole::Remote)
            .unwrap_err();
        assert!(err.to_string().contains("already paired"), "{err}");
        assert_eq!(store.list().unwrap().len(), 3);

        // Revoking one frees the slot the cap was counting.
        store.revoke("dev-2").unwrap();
        store
            .confirm_device("dev-4", &key(4), "Now it fits", DeviceRole::Remote)
            .unwrap();

        // And the cap is a store rule the settings task can raise.
        store.set_device_cap(5);
        store
            .confirm_device("dev-5", &key(5), "Raised", DeviceRole::Remote)
            .unwrap();
        assert_eq!(store.active_device_count().unwrap(), 4);
    }

    #[test]
    fn a_role_this_build_cannot_read_is_refused_rather_than_defaulted() {
        // Both daemons share this file (CLAUDE.md), so a newer one can
        // write a role vocabulary this build predates. Reading it as
        // `remote` would be granting a role rather than reading one.
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        store.confirm_device("dev-1", &key(1), "From the future", DeviceRole::Remote).unwrap();
        store
            .conn
            .execute("UPDATE devices SET role = 'kiosk' WHERE device_id = 'dev-1'", [])
            .unwrap();

        let listed = &store.list().unwrap()[0];
        assert_eq!(listed.role, DeviceRole::Other("kiosk".to_string()));
        assert_eq!(listed.role.as_str(), "kiosk", "the text must round-trip, not be rewritten");
        assert!(matches!(store.admit(&key(1)).unwrap(), Admission::UnreadableRole(_)));
    }

    #[test]
    fn admitting_does_not_renew_the_staleness_window() {
        // §3 rejects "silent renewal on use", because that is how a
        // stolen phone renews itself. `admit` reads; only `touch` writes.
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        let paired_at = 1_000 * DAY_US;
        store
            .confirm_device_at("dev-1", &key(1), "Pixel", DeviceRole::Remote, paired_at)
            .unwrap();

        let day_80 = paired_at + 80 * DAY_US;
        assert!(store.admit_at(&key(1), day_80).unwrap().admitted().is_some());

        assert_eq!(
            store.device("dev-1").unwrap().unwrap().last_seen_at_us,
            paired_at,
            "admit must not move last_seen_at"
        );
        assert!(matches!(
            store.admit_at(&key(1), paired_at + 91 * DAY_US).unwrap(),
            Admission::Stale(_)
        ));
    }

    #[test]
    fn a_devices_database_from_before_revocation_gains_the_column() {
        // The CLAUDE.md trap, written at v1 so the NEXT column has a test
        // to copy: `CREATE TABLE IF NOT EXISTS` is a no-op against a file
        // that already has the table, so a column only ever reaches an
        // existing database through its own ALTER. Built here with the
        // OLD schema -- a devices table with no `revoked_at_us` -- then
        // opened (which runs the ALTER), then the revocation path is
        // exercised end to end on the pre-existing row.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devices.sqlite");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE devices (
                    device_id TEXT PRIMARY KEY,
                    public_key BLOB NOT NULL,
                    name TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'remote',
                    created_at_us INTEGER NOT NULL,
                    last_seen_at_us INTEGER NOT NULL
                );
                CREATE TABLE trust_meta (key TEXT PRIMARY KEY, value BLOB NOT NULL);
                INSERT INTO devices
                    (device_id, public_key, name, role, created_at_us, last_seen_at_us)
                VALUES ('old-1', X'0101010101010101010101010101010101010101010101010101010101010101',
                        'Paired before revocation existed', 'remote', 1, 1)",
            )
            .unwrap();
        }

        let store = TrustStore::open(&path).unwrap();

        // The pre-existing row reads back with a NULL revoked_at_us --
        // the absence is "not revoked", never a match.
        let old = store.device("old-1").unwrap().unwrap();
        assert!(!old.is_revoked());
        assert_eq!(old.name, "Paired before revocation existed");

        // And the new column is writable on the old row.
        assert!(store.revoke("old-1").unwrap());
        assert!(store.device("old-1").unwrap().unwrap().is_revoked());
        assert!(matches!(store.admit(&key(1)).unwrap(), Admission::Revoked(_)));

        // The key pair the old file never had is minted on this open, not
        // left missing -- a daemon whose store predates the key must
        // still be able to answer a QR request.
        assert_eq!(store.static_public_key().unwrap().len(), 32);
    }

    #[test]
    fn a_devices_database_from_before_the_unique_key_index_gains_it() {
        // The index is the other half of the same trap: SQLite cannot
        // ALTER a UNIQUE constraint onto an existing column, so the
        // uniqueness of `public_key` is carried by an index that
        // `CREATE ... IF NOT EXISTS` can reach a table that was already
        // there.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devices.sqlite");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE devices (
                    device_id TEXT PRIMARY KEY,
                    public_key BLOB NOT NULL,
                    name TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'remote',
                    created_at_us INTEGER NOT NULL,
                    last_seen_at_us INTEGER NOT NULL
                );
                CREATE TABLE trust_meta (key TEXT PRIMARY KEY, value BLOB NOT NULL)",
            )
            .unwrap();
        }

        let store = TrustStore::open(&path).unwrap();
        store.confirm_device("dev-1", &key(1), "Pixel", DeviceRole::Remote).unwrap();
        // The same key again revives the one row rather than inserting a
        // second one -- which is only true because the index reached this
        // pre-existing table.
        store.confirm_device("dev-2", &key(1), "Pixel", DeviceRole::Remote).unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
    }

    /// Absent means OFF. A daemon that has never been told anything is
    /// not a daemon that was told yes -- and this is the state every
    /// existing `devices.sqlite` is in, since the store shipped a phase
    /// before the setting did.
    #[test]
    fn a_store_that_was_never_told_has_remote_access_off() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        assert_eq!(store.remote_access().unwrap(), RemoteAccess::default());
        assert!(!store.remote_access().unwrap().enabled);
        assert!(store.remote_access().unwrap().relay_url.is_none());
        assert!(store.remote_access().unwrap().rendezvous().is_empty());
    }

    /// The switch and the URL are independent, which is the whole reason
    /// they are two values: turning remote access off and on again must
    /// not cost the human the address they typed.
    #[test]
    fn turning_remote_access_off_keeps_the_relay_url() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        let url = Some("wss://relay.example/gavin".to_string());

        store.set_remote_access(&RemoteAccess { enabled: true, relay_url: url.clone() }).unwrap();
        store.set_remote_access(&RemoteAccess { enabled: false, relay_url: url.clone() }).unwrap();

        let read = store.remote_access().unwrap();
        assert!(!read.enabled);
        assert_eq!(read.relay_url, url);
        // And it survives a reopen, because the daemon that will one day
        // dial is the one that comes back after a reboot.
        assert_eq!(open_store(&dir).remote_access().unwrap(), read);
    }

    /// A cleared field is "no relay", never an empty address. The QR
    /// reads its rendezvous list straight out of this, and an entry that
    /// is the empty string is one a phone would try to dial.
    #[test]
    fn a_blank_relay_url_reads_back_as_none() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        for blank in ["", "   "] {
            store
                .set_remote_access(&RemoteAccess {
                    enabled: true,
                    relay_url: Some(blank.to_string()),
                })
                .unwrap();
            let read = store.remote_access().unwrap();
            assert_eq!(read.relay_url, None, "{blank:?}");
            assert!(read.rendezvous().is_empty(), "{blank:?}");
        }
    }

    /// The rendezvous list the QR carries: the relay when there is one,
    /// nothing when there is not. Empty is honest in this phase -- no
    /// transport exists, so there is nowhere to point a phone.
    #[test]
    fn the_rendezvous_list_is_the_relay_or_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        store
            .set_remote_access(&RemoteAccess {
                enabled: true,
                relay_url: Some("wss://relay.example/gavin".into()),
            })
            .unwrap();
        assert_eq!(
            store.remote_access().unwrap().rendezvous(),
            vec!["wss://relay.example/gavin".to_string()]
        );
    }

    /// Rotating the daemon key must not take the human's settings with
    /// it. "Revoke all devices" answers a lost phone; it is not a factory
    /// reset, and a human who pressed it should not also find remote
    /// access switched off and their relay URL gone.
    #[test]
    fn revoke_all_rotates_the_key_and_leaves_the_settings_alone() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        let settings =
            RemoteAccess { enabled: true, relay_url: Some("wss://relay.example/gavin".into()) };
        store.set_remote_access(&settings).unwrap();
        let before = store.static_public_key().unwrap();

        let after = store.revoke_all().unwrap();

        assert_ne!(before, after, "revoke_all must rotate the key");
        assert_eq!(store.remote_access().unwrap(), settings);
    }
}
