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
///
/// The string itself is the protocol crate's, because since the Companion
/// core there are two programs that build a handshake from it, and the
/// other one cannot read this file.
pub const NOISE_PARAMS: &str = protocol::PAIRING_NOISE_PARAMS;

/// How many paired, unrevoked devices the store will hold.
///
/// Five: a phone, a tablet and a spare, with room over. §3 said three
/// and the Companion spec raised it ("Pairing and the trust store",
/// answering §11 Q3).
///
/// A store rule, not a UI one, because the store is what a compromised or
/// buggy caller reaches: the cap has to hold whether the insert came from
/// the Settings panel or from a pairing handshake that ran without one.
/// `set_device_cap` is the seam a setting would raise it through.
pub const DEFAULT_DEVICE_CAP: usize = 5;

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
/// The Relay's admission token. A row like the two above it, so a store
/// written before the token existed needs no migration to gain it: the
/// row is simply not there, and not there reads as "none".
const META_RELAY_ADMISSION: &str = "remote_access_relay_admission";
const META_PUSH_GATEWAY_URL: &str = "push_gateway_url";
/// Whether the direct listener is wanted (ADR 0009). A row of its own
/// rather than a field of `RemoteAccess`: `SetRemoteAccess` writes that
/// struct whole, and an app older than v69 would write it without this.
const META_DIRECT_ENABLED: &str = "remote_access_direct";
/// The direct listener's certificate and its key, in one row
/// (`DirectIdentity::to_row`) so that two daemons minting at once cannot
/// end up holding one's certificate and the other's key.
const META_DIRECT_TLS: &str = "direct_tls";

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
#[derive(Clone, PartialEq, Eq)]
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
    /// The public half of the Device's hardware key (ADR 0001): the
    /// uncompressed SEC1 point of a P-256 key, as the Device registered
    /// it when it paired. Every connection is signed by this key, and
    /// `unlock.rs` is what checks that it was.
    ///
    /// `None` for a row written before the column existed. Such a row
    /// cannot connect, and `admit` says so by name.
    pub hardware_key: Option<Vec<u8>>,
    /// What this daemon seals this Device's notifications with, agreed
    /// when it paired (06 §5.6). `None` for a row from before the column,
    /// or after a revoke cleared it.
    ///
    /// Beside the daemon's own private key, in the file that is `0600`
    /// for exactly that: both are secrets the daemon has to be able to
    /// read at 02:00 with nobody at the desk.
    pub notification_key: Option<Vec<u8>>,
    /// The Device's send permission for this Workstation, handed over the
    /// encrypted channel after the shell mints it at the Push gateway.
    /// A credential: it is what the gateway takes as the Bearer token.
    pub send_permission: Option<String>,
    /// Next AEAD counter to seal with for this Device.
    pub notify_counter: u64,
}

/// Hand-written, and it leaves the notification key and the send
/// permission out. A row reaches an error message or a log line by being
/// formatted -- `Admission` carries one, and is -- and the two secrets a
/// row holds must not go with it. The other keys are public halves.
impl std::fmt::Debug for Device {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Device")
            .field("device_id", &self.device_id)
            .field("name", &self.name)
            .field("role", &self.role)
            .field("public_key", &protocol::hex_encode(&self.public_key))
            .field("hardware_key", &self.hardware_key.as_deref().map(protocol::hex_encode))
            .field("created_at_us", &self.created_at_us)
            .field("last_seen_at_us", &self.last_seen_at_us)
            .field("revoked_at_us", &self.revoked_at_us)
            .field("notify_counter", &self.notify_counter)
            .finish_non_exhaustive()
    }
}

/// What a pairing the desk confirmed hands the store: the Device's two
/// keys, the key its notifications will be sealed with, and what to call
/// it.
#[derive(Clone, PartialEq, Eq)]
pub struct Registration {
    /// The Device's Noise static public key.
    pub public_key: Vec<u8>,
    pub name: String,
    pub role: DeviceRole,
    pub hardware_key: Vec<u8>,
    pub notification_key: Vec<u8>,
}

/// Without the notification key, as `Device`'s is.
impl std::fmt::Debug for Registration {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Registration")
            .field("name", &self.name)
            .field("role", &self.role)
            .field("public_key", &protocol::hex_encode(&self.public_key))
            .field("hardware_key", &protocol::hex_encode(&self.hardware_key))
            .finish_non_exhaustive()
    }
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
    /// The row holds no hardware key, so there is nothing to verify a
    /// connection's signature against. Refused here, by name, and not
    /// left to fail as a signature that did not verify: the Device did
    /// nothing wrong, and what it has to do is pair again.
    NoHardwareKey(Device),
}

impl Admission {
    pub fn admitted(&self) -> Option<&Device> {
        match self {
            Admission::Admitted(d) => Some(d),
            _ => None,
        }
    }

    /// Why the device's connection is refused, as the Device is told
    /// it. `None` when it is not refused.
    pub fn connect_refusal(&self) -> Option<protocol::device_wire::ConnectRefusal> {
        use protocol::device_wire::ConnectRefusal;
        match self {
            Admission::Admitted(_) => None,
            Admission::Unknown => Some(ConnectRefusal::NotPaired),
            Admission::Revoked(_) => Some(ConnectRefusal::Revoked),
            Admission::Stale(_) => Some(ConnectRefusal::Stale),
            // Pairing again is what gives the row a hardware key.
            Admission::NoHardwareKey(_) => Some(ConnectRefusal::PairAgain),
            // Pairing again would not help: the row was written by a
            // Gavin newer than this one, and would be again.
            Admission::UnreadableRole(_) => Some(ConnectRefusal::Other),
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
            Admission::NoHardwareKey(_) => Some(
                "this device was paired before gavin checked its hardware key — pair it again to use it",
            ),
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
    /// The Relay's admission token: what the daemon presents to the
    /// Relay to be carried, and what the pairing QR hands a Device so it
    /// can present the same. `None` for a Relay the human has been given
    /// no token for yet -- which a Relay refuses, by name.
    ///
    /// Beside the URL and not in the app's `config.json`, for the URL's
    /// own reason: the daemon is what dials, at 02:00 with the app
    /// closed. And in a `0600` file beside a private key, which is the
    /// company a credential should keep.
    pub relay_admission: Option<String>,
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

/// The direct listener's TLS identity (ADR 0009): a self-signed P-256
/// certificate, DER, and its private key, PKCS#8 DER.
///
/// Self-signed, because what trusts it is a Device that pinned its hash
/// from the pairing QR (`protocol::relay::certificate_pin`), and nothing
/// else ever will. Its dates are rcgen's defaults and nobody checks them:
/// a pin has no clock in it, for the reason 05 §5 gives against
/// certificates on a laptop that sleeps for a week.
#[derive(Clone, PartialEq, Eq)]
pub struct DirectIdentity {
    pub certificate: Vec<u8>,
    pub private_key: Vec<u8>,
}

impl DirectIdentity {
    fn mint() -> anyhow::Result<Self> {
        let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256)?;
        let mut params = rcgen::CertificateParams::new(vec!["gavin-workstation".to_string()])?;
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, "Gavin Workstation");
        let certificate = params.self_signed(&key)?;
        Ok(Self { certificate: certificate.der().to_vec(), private_key: key.serialize_der() })
    }

    /// `[certificate length, u32 BE][certificate][key]`.
    fn to_row(&self) -> Vec<u8> {
        let mut row = Vec::with_capacity(4 + self.certificate.len() + self.private_key.len());
        row.extend_from_slice(&(self.certificate.len() as u32).to_be_bytes());
        row.extend_from_slice(&self.certificate);
        row.extend_from_slice(&self.private_key);
        row
    }

    fn from_row(row: &[u8]) -> Option<Self> {
        let length = u32::from_be_bytes(row.get(..4)?.try_into().ok()?) as usize;
        let certificate = row.get(4..4 + length)?.to_vec();
        let private_key = row.get(4 + length..)?.to_vec();
        (!certificate.is_empty() && !private_key.is_empty())
            .then_some(Self { certificate, private_key })
    }

    /// What a pairing QR carries for it.
    pub fn pin(&self) -> String {
        protocol::relay::certificate_pin(&self.certificate)
    }
}

/// Never the private key.
impl std::fmt::Debug for DirectIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DirectIdentity").field("pin", &self.pin()).finish_non_exhaustive()
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
    /// test the next column can be added by copying. The two after it
    /// were: `a_phase_two_trust_store_gains_the_hardware_key_column`.
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
        // there is no timestamp that means it. The two keys likewise: a
        // row from before them holds none, and there is no key that
        // means that. The send permission is the same absence: a Device
        // that has handed over none has not asked to be woken.
        for stmt in [
            "ALTER TABLE devices ADD COLUMN revoked_at_us INTEGER",
            "ALTER TABLE devices ADD COLUMN hardware_key BLOB",
            "ALTER TABLE devices ADD COLUMN notification_key BLOB",
            // Companion notifications (06 §5.6). Revoke clears the
            // permission and the counter with the key.
            "ALTER TABLE devices ADD COLUMN send_permission TEXT",
            "ALTER TABLE devices ADD COLUMN notify_counter INTEGER NOT NULL DEFAULT 0",
        ] {
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
    /// **Read by the transport.** `remote.rs` dials the Relay while
    /// `enabled` is set and there is a URL to dial, and lets go when
    /// either stops being true. This store only holds the answer: there
    /// is still nothing in it that opens a socket.
    pub fn remote_access(&self) -> anyhow::Result<RemoteAccess> {
        // Absent means off. A daemon that had never been told is not a
        // daemon that was told yes.
        let enabled = self.meta(META_REMOTE_ENABLED)?.map(|v| v == b"1").unwrap_or(false);
        Ok(RemoteAccess {
            enabled,
            relay_url: self.meta_text(META_RELAY_URL)?,
            relay_admission: self.meta_text(META_RELAY_ADMISSION)?,
        })
    }

    /// A stored setting as text, or `None` when it is absent or blank.
    ///
    /// An empty stored value is "none", not an empty string: the human
    /// clearing a field must not leave something that parses as an
    /// address, or is presented as a token.
    fn meta_text(&self, key: &str) -> anyhow::Result<Option<String>> {
        Ok(self.meta(key)?.and_then(|bytes| {
            let s = String::from_utf8_lossy(&bytes).trim().to_string();
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        }))
    }

    /// Writes all three settings, as given. What an ABSENT token in a
    /// request means -- "leave the stored one alone" -- is decided by the
    /// caller that read the request (`SessionManager::set_remote_access`);
    /// by the time a value reaches here it is the value to store.
    pub fn set_remote_access(&self, settings: &RemoteAccess) -> anyhow::Result<()> {
        self.set_meta(META_REMOTE_ENABLED, if settings.enabled { b"1" } else { b"0" })?;
        self.set_meta(
            META_RELAY_URL,
            settings.relay_url.as_deref().unwrap_or("").trim().as_bytes(),
        )?;
        self.set_meta(
            META_RELAY_ADMISSION,
            settings.relay_admission.as_deref().unwrap_or("").trim().as_bytes(),
        )?;
        Ok(())
    }

    /// Base URL of the Push gateway this daemon posts ciphertext to.
    pub fn push_gateway_url(&self) -> anyhow::Result<Option<String>> {
        self.meta_text(META_PUSH_GATEWAY_URL)
    }

    pub fn set_push_gateway_url(&self, url: Option<&str>) -> anyhow::Result<()> {
        self.set_meta(META_PUSH_GATEWAY_URL, url.unwrap_or("").trim().as_bytes())
    }

    /// Whether the direct listener is switched on (ADR 0009). It listens
    /// only while remote access is on as well; absent means off.
    pub fn direct_enabled(&self) -> anyhow::Result<bool> {
        Ok(self.meta(META_DIRECT_ENABLED)?.map(|v| v == b"1").unwrap_or(false))
    }

    pub fn set_direct_enabled(&self, enabled: bool) -> anyhow::Result<()> {
        self.set_meta(META_DIRECT_ENABLED, if enabled { b"1" } else { b"0" })
    }

    /// The direct listener's certificate and key, minted the first time
    /// they are asked for.
    ///
    /// Inserted only if absent, and then read back: the dev and release
    /// daemons share this file, and two that mint at once must both end
    /// up serving the one that was kept, or a Device pinned to one would
    /// be refused by the other.
    pub fn direct_identity(&self) -> anyhow::Result<DirectIdentity> {
        if let Some(identity) = self.meta(META_DIRECT_TLS)?.as_deref().and_then(DirectIdentity::from_row) {
            return Ok(identity);
        }
        let minted = DirectIdentity::mint()?;
        // A row that is there but does not read is replaced: it is not an
        // identity anyone could have pinned.
        if self.meta(META_DIRECT_TLS)?.is_some() {
            self.set_meta(META_DIRECT_TLS, &minted.to_row())?;
        } else {
            self.conn.execute(
                "INSERT OR IGNORE INTO trust_meta (key, value) VALUES (?1, ?2)",
                params![META_DIRECT_TLS, minted.to_row()],
            )?;
        }
        self.meta(META_DIRECT_TLS)?
            .as_deref()
            .and_then(DirectIdentity::from_row)
            .ok_or_else(|| anyhow::anyhow!("devices.sqlite: the direct listener's certificate did not keep"))
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
    ///
    /// A revived row takes the keys this pairing registered. The
    /// hardware key is whatever the Device proved it holds a moment ago,
    /// and the notification key was agreed in the channel that pairing
    /// left: the ones the row held belong to a pairing that is over.
    pub fn confirm_device(
        &self,
        device_id: &str,
        device: &Registration,
    ) -> anyhow::Result<Device> {
        self.confirm_device_at(device_id, device, now_us())
    }

    pub fn confirm_device_at(
        &self,
        device_id: &str,
        device: &Registration,
        now_us: i64,
    ) -> anyhow::Result<Device> {
        let Registration { public_key, name, role, hardware_key, notification_key } = device;
        if let Some(existing) = self.device_for_key(public_key)? {
            // A Device that is trusted already is asking for the slot it
            // has. One that was revoked gave its slot up, and is asking
            // for one like any other: without this, five Devices, one
            // revoked and replaced, and the revoked one paired again
            // would be six.
            if existing.is_revoked() {
                self.room_for_one_more()?;
            }
            self.conn.execute(
                "UPDATE devices
                    SET name = ?2, role = ?3, last_seen_at_us = ?4, revoked_at_us = NULL,
                        hardware_key = ?5, notification_key = ?6
                  WHERE device_id = ?1",
                params![
                    existing.device_id,
                    name,
                    role.as_str(),
                    now_us,
                    hardware_key,
                    notification_key
                ],
            )?;
            return self
                .device(&existing.device_id)?
                .ok_or_else(|| anyhow::anyhow!("devices.sqlite: revived device vanished"));
        }

        self.room_for_one_more()?;
        self.conn.execute(
            "INSERT INTO devices
                (device_id, public_key, name, role, created_at_us, last_seen_at_us, revoked_at_us,
                 hardware_key, notification_key)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, NULL, ?6, ?7)",
            params![device_id, public_key, name, role.as_str(), now_us, hardware_key, notification_key],
        )?;
        self.device(device_id)?
            .ok_or_else(|| anyhow::anyhow!("devices.sqlite: inserted device vanished"))
    }

    /// Refuses when every slot is taken.
    ///
    /// The cap counts UNREVOKED devices only. Counting revoked rows
    /// would mean five revocations brick pairing until someone went at
    /// the file with sqlite3 -- and a revoked device is precisely one
    /// that is not using its slot.
    fn room_for_one_more(&self) -> anyhow::Result<()> {
        let active = self.active_device_count()?;
        if active >= self.device_cap {
            anyhow::bail!(
                "gavin-daemon: {active} devices are already paired (the limit is {}) — revoke one before pairing another",
                self.device_cap
            );
        }
        Ok(())
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
            "UPDATE devices SET revoked_at_us = ?2,
                   notification_key = NULL,
                   send_permission = NULL,
                   notify_counter = 0
              WHERE device_id = ?1 AND revoked_at_us IS NULL",
            params![device_id, now_us],
        )?;
        Ok(changed > 0)
    }

    /// Deletes one device's row. `true` if there was one.
    ///
    /// What a Device does to itself (`RemoveThisDevice`), and the one
    /// write to this table that takes a row away: a revocation keeps the
    /// row so the desk can see what was revoked and when, and a Device
    /// that has left is not something the desk did. Its key is then a
    /// key the store has never seen, and its slot is free.
    ///
    /// This is only the row. Dropping the Device's connections is
    /// `SessionManager::remove_device`'s half, as it is for `revoke`.
    pub fn remove(&self, device_id: &str) -> anyhow::Result<bool> {
        let changed =
            self.conn.execute("DELETE FROM devices WHERE device_id = ?1", params![device_id])?;
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
            "UPDATE devices SET revoked_at_us = ?1,
                   notification_key = NULL,
                   send_permission = NULL,
                   notify_counter = 0
              WHERE revoked_at_us IS NULL",
            params![now_us],
        )?;
        self.write_fresh_keypair()?;
        // The direct listener's certificate goes with the key (ADR 0009):
        // every Device that pinned the old one has to pair again anyway,
        // and the next pairing pins the one minted for it.
        self.conn.execute("DELETE FROM trust_meta WHERE key = ?1", params![META_DIRECT_TLS])?;
        self.static_public_key()
    }

    /// Store the per-Device notification key agreed at pairing.
    pub fn set_notification_key(&self, device_id: &str, key: &[u8]) -> anyhow::Result<bool> {
        let changed = self.conn.execute(
            "UPDATE devices SET notification_key = ?2, notify_counter = 0
              WHERE device_id = ?1 AND revoked_at_us IS NULL",
            params![device_id, key],
        )?;
        Ok(changed > 0)
    }

    /// Store (or replace) the Device's send permission for this Workstation.
    pub fn set_send_permission(&self, device_id: &str, permission: &str) -> anyhow::Result<bool> {
        let changed = self.conn.execute(
            "UPDATE devices SET send_permission = ?2
              WHERE device_id = ?1 AND revoked_at_us IS NULL",
            params![device_id, permission],
        )?;
        Ok(changed > 0)
    }

    /// Clear a Device's send permission (the Device cancelled it, or the
    /// gateway refused it as cancelled/expired/invalid).
    pub fn clear_send_permission(&self, device_id: &str) -> anyhow::Result<bool> {
        let changed = self.conn.execute(
            "UPDATE devices SET send_permission = NULL
              WHERE device_id = ?1",
            params![device_id],
        )?;
        Ok(changed > 0)
    }

    /// Persist the next AEAD counter after a successful post.
    pub fn set_notify_counter(&self, device_id: &str, counter: u64) -> anyhow::Result<bool> {
        let changed = self.conn.execute(
            "UPDATE devices SET notify_counter = ?2 WHERE device_id = ?1",
            params![device_id, counter as i64],
        )?;
        Ok(changed > 0)
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
        Ok(judge(self.device_for_key(public_key)?, now_us))
    }

    /// May the device filed under this id stay connected?
    ///
    /// The same judgment as `admit`, reached from the other end: a
    /// connection that is already open carries the id the handshake's
    /// key was filed under, and is judged again by it once it has
    /// registered (`server::serve_connection`).
    pub fn admit_id(&self, device_id: &str) -> anyhow::Result<Admission> {
        self.admit_id_at(device_id, now_us())
    }

    pub fn admit_id_at(&self, device_id: &str, now_us: i64) -> anyhow::Result<Admission> {
        Ok(judge(self.device(device_id)?, now_us))
    }
}

#[cfg(test)]
impl TrustStore {
    /// Writes to the file as nothing in the daemon does, for a test in
    /// another module that needs a row the store would never write.
    pub(crate) fn raw(&self, sql: &str) {
        self.conn.execute(sql, []).unwrap();
    }
}

/// What a row is told, in the order a human would want it said: a
/// revoked Device is one they revoked, whatever else is true of its row.
fn judge(device: Option<Device>, now_us: i64) -> Admission {
    let Some(device) = device else {
        return Admission::Unknown;
    };
    if device.is_revoked() {
        return Admission::Revoked(device);
    }
    if matches!(device.role, DeviceRole::Other(_)) {
        return Admission::UnreadableRole(device);
    }
    if device.is_stale_at(now_us) {
        return Admission::Stale(device);
    }
    if device.hardware_key.is_none() {
        return Admission::NoHardwareKey(device);
    }
    Admission::Admitted(device)
}

const DEVICE_COLUMNS: &str = "device_id, public_key, name, role, created_at_us, last_seen_at_us, \
     revoked_at_us, hardware_key, notification_key, send_permission, notify_counter";

fn device_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Device> {
    Ok(Device {
        device_id: row.get(0)?,
        public_key: row.get(1)?,
        name: row.get(2)?,
        role: DeviceRole::from_stored(&row.get::<_, String>(3)?),
        created_at_us: row.get(4)?,
        last_seen_at_us: row.get(5)?,
        revoked_at_us: row.get(6)?,
        hardware_key: row.get(7)?,
        notification_key: row.get(8)?,
        send_permission: row.get(9)?,
        notify_counter: row.get::<_, i64>(10).unwrap_or(0) as u64,
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

    /// A stand-in hardware key, by its shape. Whether a signature
    /// verifies against one is `unlock.rs`'s to test; here it is a
    /// column.
    fn hardware(tag: u8) -> Vec<u8> {
        let mut key = vec![0x04];
        key.extend_from_slice(&[tag; 64]);
        key
    }

    /// What a pairing the desk confirmed hands the store.
    fn device(tag: u8, name: &str) -> Registration {
        Registration {
            public_key: key(tag),
            name: name.to_string(),
            role: DeviceRole::Remote,
            hardware_key: hardware(tag),
            notification_key: vec![tag; 32],
        }
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
            .confirm_device("dev-1", &device(1, "Pixel"))
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
        store.confirm_device("dev-1", &device(1, "Pixel")).unwrap();

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
            .confirm_device("dev-1", &device(1, "Pixel"))
            .unwrap();
        store.revoke("dev-1").unwrap();
        assert_eq!(store.active_device_count().unwrap(), 0);

        // The phone kept its key, so re-pairing it is the SAME row: the
        // caller's freshly minted id is ignored and the stored one comes
        // back, which is what keeps a later revoke aimed at the right
        // device.
        let revived = store
            .confirm_device("dev-2", &device(1, "Pixel (again)"))
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
        store.confirm_device("dev-1", &device(1, "Pixel")).unwrap();
        store.confirm_device("dev-2", &device(2, "iPhone")).unwrap();
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
            .confirm_device_at("stale", &device(1, "Old phone"), paired_at)
            .unwrap();
        store
            .confirm_device_at("fresh", &device(2, "New phone"), paired_at)
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
            .confirm_device_at("stale", &device(1, "Old phone"), day_91)
            .unwrap();
        assert!(store.admit_at(&key(1), day_91).unwrap().admitted().is_some());
    }

    /// The Companion spec, "Pairing and the trust store": "the device
    /// cap rises from three to five" -- a phone, a tablet and a spare.
    #[test]
    fn the_store_holds_five_devices_and_refuses_the_sixth() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = open_store(&dir);
        assert_eq!(store.device_cap(), 5);

        for n in 1..=5u8 {
            store.confirm_device(&format!("dev-{n}"), &device(n, "Phone")).unwrap();
        }

        let err = store.confirm_device("dev-6", &device(6, "One too many")).unwrap_err();
        assert!(err.to_string().contains("already paired"), "{err}");
        assert!(err.to_string().contains("the limit is 5"), "{err}");
        assert_eq!(store.list().unwrap().len(), 5);
        assert!(store.device("dev-6").unwrap().is_none());

        // A Device that is already one of the five pairs again: it is
        // asking for the slot it has.
        store.confirm_device("dev-9", &device(3, "Phone, again")).unwrap();
        assert_eq!(store.active_device_count().unwrap(), 5);

        // Revoking one frees the slot the cap was counting.
        store.revoke("dev-2").unwrap();
        store.confirm_device("dev-6", &device(6, "Now it fits")).unwrap();

        // And the cap is a store rule a setting can raise.
        store.set_device_cap(6);
        store.confirm_device("dev-7", &device(7, "Raised")).unwrap();
        assert_eq!(store.active_device_count().unwrap(), 6);
    }

    /// The cap counts the Devices that are trusted, however they came
    /// to be. A revoked Device that pairs again is asking for a slot
    /// like any other: five, one revoked, a sixth paired in its place --
    /// and the revoked one is back for a slot that has been given away.
    #[test]
    fn a_revoked_device_pairing_again_takes_a_slot_like_any_other() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        for n in 1..=5u8 {
            store.confirm_device(&format!("dev-{n}"), &device(n, "Phone")).unwrap();
        }
        store.revoke("dev-2").unwrap();
        store.confirm_device("dev-6", &device(6, "In its place")).unwrap();
        assert_eq!(store.active_device_count().unwrap(), 5);

        let err = store.confirm_device("dev-9", &device(2, "Back again")).unwrap_err();
        assert!(err.to_string().contains("already paired"), "{err}");
        assert!(err.to_string().contains("the limit is 5"), "{err}");
        assert_eq!(store.active_device_count().unwrap(), 5);
        // Refused, and left as it was: still revoked, under its own
        // name, with the keys it had.
        let refused = store.device("dev-2").unwrap().unwrap();
        assert!(refused.is_revoked());
        assert_eq!(refused.name, "Phone");
        assert!(matches!(store.admit(&key(2)).unwrap(), Admission::Revoked(_)));

        // With room made for it, it pairs again under the id it had.
        store.revoke("dev-6").unwrap();
        let back = store.confirm_device("dev-9", &device(2, "Back again")).unwrap();
        assert_eq!(back.device_id, "dev-2");
        assert!(!back.is_revoked());
        assert_eq!(store.active_device_count().unwrap(), 5);
    }

    /// A row reaches an error message or a log line by being formatted,
    /// and the notification key must not reach either.
    #[test]
    fn a_device_does_not_print_its_notification_key() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        let registration = Registration { notification_key: vec![0xa7; 32], ..device(1, "Pixel") };
        store.confirm_device("dev-1", &registration).unwrap();
        // Nor the send permission, the gateway's Bearer token.
        store.set_send_permission("dev-1", "v1.perm.bearer-secret").unwrap();
        let paired = store.device("dev-1").unwrap().unwrap();

        for shown in [
            format!("{paired:?}"),
            format!("{registration:?}"),
            format!("{:?}", store.admit(&key(1)).unwrap()),
        ] {
            assert!(shown.contains("Pixel"), "{shown}");
            assert!(!shown.contains("167"), "the key, as bytes: {shown}");
            assert!(!shown.to_lowercase().contains("a7a7"), "the key, as hex: {shown}");
            assert!(!shown.contains("bearer-secret"), "the permission: {shown}");
        }
    }

    /// ADR 0001: the Device registers its hardware key at pairing, and
    /// the Companion spec has each pairing agree a notification key.
    /// Both are the row's.
    #[test]
    fn a_confirmed_device_keeps_the_keys_it_paired_with() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        let paired = store.confirm_device("dev-1", &device(1, "Pixel")).unwrap();
        assert_eq!(paired.hardware_key, Some(hardware(1)));
        assert_eq!(paired.notification_key, Some(vec![1u8; 32]));

        // And they are there after a restart, which is when a Device
        // next connects.
        let read = open_store(&dir).device("dev-1").unwrap().unwrap();
        assert_eq!(read, paired);
    }

    /// A Device that pairs again keeps its row, and the row takes what
    /// the new pairing registered. The old notification key goes with
    /// the old pairing: it was agreed in a channel that is over.
    #[test]
    fn pairing_again_replaces_both_keys() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        store.confirm_device("dev-1", &device(1, "Pixel")).unwrap();

        let again = Registration {
            hardware_key: hardware(0x51),
            notification_key: vec![0x52; 32],
            ..device(1, "Pixel")
        };
        let revived = store.confirm_device("dev-2", &again).unwrap();
        assert_eq!(revived.device_id, "dev-1", "the same Noise key is the same Device");
        assert_eq!(revived.hardware_key, Some(hardware(0x51)));
        assert_eq!(revived.notification_key, Some(vec![0x52; 32]));
        assert_eq!(store.list().unwrap().len(), 1);
    }

    /// A row that holds no hardware key cannot pass the check every
    /// connection has to pass, so it is refused by name before any
    /// signature is asked for. Pairing again is what gives it one.
    #[test]
    fn a_device_with_no_hardware_key_is_told_to_pair_again() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        store.confirm_device("dev-1", &device(1, "Pixel")).unwrap();
        store
            .conn
            .execute("UPDATE devices SET hardware_key = NULL WHERE device_id = 'dev-1'", [])
            .unwrap();

        match store.admit(&key(1)).unwrap() {
            Admission::NoHardwareKey(d) => assert_eq!(d.device_id, "dev-1"),
            other => panic!("expected NoHardwareKey, got {other:?}"),
        }
        let refusal = store.admit(&key(1)).unwrap().refusal().unwrap();
        assert!(refusal.contains("pair it again"), "{refusal}");

        store.confirm_device("dev-1", &device(1, "Pixel")).unwrap();
        assert!(store.admit(&key(1)).unwrap().admitted().is_some());
    }

    /// Each refusal is a different thing for the Companion to tell the
    /// human holding it, so each is told to the Device as what it is.
    #[test]
    fn a_refusal_is_told_to_the_device_as_what_it_is() {
        use protocol::device_wire::ConnectRefusal;
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        let paired_at = 1_000 * DAY_US;
        for (n, id) in [(1u8, "fine"), (2, "revoked"), (3, "stale"), (4, "keyless"), (5, "kiosk")] {
            store.confirm_device_at(id, &device(n, id), paired_at).unwrap();
        }
        store.revoke("revoked").unwrap();
        store
            .conn
            .execute("UPDATE devices SET hardware_key = NULL WHERE device_id = 'keyless'", [])
            .unwrap();
        store.conn.execute("UPDATE devices SET role = 'kiosk' WHERE device_id = 'kiosk'", []).unwrap();
        let day_80 = paired_at + 80 * DAY_US;
        for id in ["fine", "revoked", "keyless", "kiosk"] {
            store.touch_at(id, day_80).unwrap();
        }

        let day_91 = paired_at + 91 * DAY_US;
        let told = |id: &str| store.admit_id_at(id, day_91).unwrap().connect_refusal();
        assert_eq!(told("fine"), None);
        assert_eq!(told("revoked"), Some(ConnectRefusal::Revoked));
        assert_eq!(told("stale"), Some(ConnectRefusal::Stale));
        assert_eq!(told("keyless"), Some(ConnectRefusal::PairAgain));
        assert_eq!(told("kiosk"), Some(ConnectRefusal::Other));
        assert_eq!(told("never-paired"), Some(ConnectRefusal::NotPaired));
    }

    /// A connection is judged by the key that completed its handshake;
    /// a connection that is already open is judged again by the id it
    /// carries. The two must agree.
    #[test]
    fn a_device_is_judged_the_same_by_its_id_as_by_its_key() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        let paired_at = 1_000 * DAY_US;
        store.confirm_device_at("dev-1", &device(1, "Pixel"), paired_at).unwrap();
        store.confirm_device_at("dev-2", &device(2, "iPhone"), paired_at).unwrap();
        store.revoke("dev-2").unwrap();

        for now in [paired_at, paired_at + 91 * DAY_US] {
            assert_eq!(
                store.admit_id_at("dev-1", now).unwrap(),
                store.admit_at(&key(1), now).unwrap()
            );
            assert_eq!(
                store.admit_id_at("dev-2", now).unwrap(),
                store.admit_at(&key(2), now).unwrap()
            );
        }
        assert!(store.admit_id_at("dev-1", paired_at).unwrap().admitted().is_some());
        assert!(matches!(store.admit_id_at("dev-2", paired_at).unwrap(), Admission::Revoked(_)));
        assert_eq!(store.admit_id("never-paired").unwrap(), Admission::Unknown);
    }

    /// The Companion spec, user story 11: "a Device [can] remove itself
    /// from a Workstation". The row goes -- it is not marked, as a
    /// revocation marks it -- and no other row is touched.
    #[test]
    fn removing_a_device_deletes_only_its_own_row() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        store.confirm_device("dev-1", &device(1, "Pixel")).unwrap();
        let kept = store.confirm_device("dev-2", &device(2, "iPhone")).unwrap();
        store.confirm_device("dev-3", &device(3, "Tablet")).unwrap();
        store.revoke("dev-3").unwrap();
        let revoked = store.device("dev-3").unwrap().unwrap();
        let key_before = store.static_public_key().unwrap();

        assert!(store.remove("dev-1").unwrap());

        assert_eq!(store.list().unwrap(), vec![kept, revoked]);
        assert!(store.device("dev-1").unwrap().is_none());
        assert_eq!(
            store.static_public_key().unwrap(),
            key_before,
            "one Device leaving is not a reason to strand the others"
        );
        // Removing what is not there removes nothing and says so.
        assert!(!store.remove("dev-1").unwrap());
        assert!(!store.remove("never-paired").unwrap());
        assert_eq!(store.list().unwrap().len(), 2);
    }

    #[test]
    fn a_removed_device_is_unknown_and_frees_its_slot() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        for n in 1..=5u8 {
            store.confirm_device(&format!("dev-{n}"), &device(n, "Phone")).unwrap();
        }
        assert!(store.remove("dev-4").unwrap());

        assert_eq!(store.admit(&key(4)).unwrap(), Admission::Unknown);
        assert_eq!(store.active_device_count().unwrap(), 4);
        store.confirm_device("dev-6", &device(6, "In its place")).unwrap();

        // It may pair again, and is then a Device the store has never
        // seen: a new row, under the id it is given.
        store.revoke("dev-1").unwrap();
        let again = store.confirm_device("dev-7", &device(4, "Back")).unwrap();
        assert_eq!(again.device_id, "dev-7");
    }

    /// The trap CLAUDE.md names, against the store this daemon finds on
    /// a machine that paired in phase 2: the schema as phase 2 left it,
    /// built by hand, with a Device and the settings in it. `CREATE
    /// TABLE IF NOT EXISTS` is a no-op against that file, so the two
    /// columns reach it only through their own `ALTER TABLE`.
    #[test]
    fn a_phase_two_trust_store_gains_the_hardware_key_column() {
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
                    last_seen_at_us INTEGER NOT NULL,
                    revoked_at_us INTEGER
                );
                CREATE TABLE trust_meta (key TEXT PRIMARY KEY, value BLOB NOT NULL);
                CREATE UNIQUE INDEX devices_by_public_key ON devices (public_key);
                INSERT INTO trust_meta (key, value) VALUES
                    ('static_private_key', X'1111111111111111111111111111111111111111111111111111111111111111'),
                    ('static_public_key', X'2222222222222222222222222222222222222222222222222222222222222222'),
                    ('remote_access_enabled', X'31'),
                    ('remote_access_relay_url', CAST('wss://relay.example/gavin' AS BLOB));
                INSERT INTO devices
                    (device_id, public_key, name, role, created_at_us, last_seen_at_us, revoked_at_us)
                VALUES
                    ('old-1', X'0101010101010101010101010101010101010101010101010101010101010101',
                     'Paired in phase two', 'remote', 1, 1, NULL),
                    ('old-2', X'0202020202020202020202020202020202020202020202020202020202020202',
                     'Revoked in phase two', 'remote', 1, 1, 7)",
            )
            .unwrap();
        }

        let store = TrustStore::open(&path).unwrap();

        // What was there is as it was.
        assert_eq!(store.static_public_key().unwrap(), vec![0x22; 32]);
        assert_eq!(store.static_private_key().unwrap(), vec![0x11; 32]);
        assert!(store.remote_access().unwrap().enabled);
        let old = store.device("old-1").unwrap().unwrap();
        assert_eq!(old.name, "Paired in phase two");
        assert_eq!(old.public_key, key(1));
        assert!(!old.is_revoked());
        assert_eq!(store.device("old-2").unwrap().unwrap().revoked_at_us, Some(7));

        // The rows that predate the columns hold no keys -- absent, not
        // empty -- and so cannot connect until they pair again.
        assert_eq!(old.hardware_key, None);
        assert_eq!(old.notification_key, None);
        assert!(matches!(
            store.admit_at(&key(1), 2).unwrap(),
            Admission::NoHardwareKey(_)
        ));
        // Revoked is still what a revoked row is told first.
        assert!(matches!(store.admit_at(&key(2), 2).unwrap(), Admission::Revoked(_)));

        // And the columns are writable on the old file: the phase-two
        // Device pairs again and keeps its row.
        let paired = store.confirm_device_at("dev-new", &device(1, "Paired again"), 3).unwrap();
        assert_eq!(paired.device_id, "old-1");
        assert_eq!(paired.created_at_us, 1);
        assert_eq!(paired.hardware_key, Some(hardware(1)));
        assert_eq!(paired.notification_key, Some(vec![1u8; 32]));
        assert!(store.admit_at(&key(1), 3).unwrap().admitted().is_some());

        // Opening it again runs the same statements against a file that
        // now has the columns, and loses nothing.
        drop(store);
        let reopened = TrustStore::open(&path).unwrap();
        assert_eq!(reopened.device("old-1").unwrap().unwrap(), paired);
        assert_eq!(reopened.list().unwrap().len(), 2);
    }

    #[test]
    fn a_role_this_build_cannot_read_is_refused_rather_than_defaulted() {
        // Both daemons share this file (CLAUDE.md), so a newer one can
        // write a role vocabulary this build predates. Reading it as
        // `remote` would be granting a role rather than reading one.
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        store.confirm_device("dev-1", &device(1, "From the future")).unwrap();
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
            .confirm_device_at("dev-1", &device(1, "Pixel"), paired_at)
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
        store.confirm_device("dev-1", &device(1, "Pixel")).unwrap();
        // The same key again revives the one row rather than inserting a
        // second one -- which is only true because the index reached this
        // pre-existing table.
        store.confirm_device("dev-2", &device(1, "Pixel")).unwrap();
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

    /// The direct listener's switch (ADR 0009) is off until it is turned
    /// on, and turning remote access on or off does not touch it.
    #[test]
    fn direct_connection_is_off_until_it_is_switched_on() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        assert!(!store.direct_enabled().unwrap());
        store.set_direct_enabled(true).unwrap();
        store
            .set_remote_access(&RemoteAccess { enabled: false, relay_url: None, relay_admission: None })
            .unwrap();
        assert!(open_store(&dir).direct_enabled().unwrap(), "kept across a reopen and a SetRemoteAccess");
        store.set_direct_enabled(false).unwrap();
        assert!(!store.direct_enabled().unwrap());
    }

    /// One certificate for the store, whoever asks first: the dev and
    /// release daemons share the file, and a Device pinned to the
    /// certificate one of them served must be let in by the other.
    #[test]
    fn the_direct_certificate_is_minted_once_and_shared() {
        let dir = tempfile::tempdir().unwrap();
        let first = open_store(&dir).direct_identity().unwrap();
        let second = open_store(&dir).direct_identity().unwrap();
        assert_eq!(first, second);
        assert_eq!(first.pin().len(), 64);
        // It is a certificate and key the listener can serve.
        gavin_relay::direct::server_config(&first.certificate, &first.private_key).unwrap();
        // A row that does not read is replaced rather than served.
        let store = open_store(&dir);
        store.set_meta(META_DIRECT_TLS, b"\x00\x00").unwrap();
        let replaced = store.direct_identity().unwrap();
        assert_ne!(replaced, first);
        assert_eq!(open_store(&dir).direct_identity().unwrap(), replaced);
    }

    /// "Revoke all" strands every Device that pinned the old key, so the
    /// certificate goes with it.
    #[test]
    fn revoke_all_mints_a_new_direct_certificate() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        let before = store.direct_identity().unwrap();
        store.revoke_all().unwrap();
        assert_ne!(store.direct_identity().unwrap().pin(), before.pin());
    }

    /// The switch and the URL are independent, which is the whole reason
    /// they are two values: turning remote access off and on again must
    /// not cost the human the address they typed.
    #[test]
    fn turning_remote_access_off_keeps_the_relay_url() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        let url = Some("wss://relay.example/gavin".to_string());

        store.set_remote_access(&RemoteAccess { enabled: true, relay_url: url.clone(), relay_admission: None }).unwrap();
        store.set_remote_access(&RemoteAccess { enabled: false, relay_url: url.clone(), relay_admission: None }).unwrap();

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
                    relay_admission: None,
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
                relay_admission: None,
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
        let settings = RemoteAccess {
            enabled: true,
            relay_url: Some("wss://relay.example/gavin".into()),
            relay_admission: Some("let-me-in".into()),
        };
        store.set_remote_access(&settings).unwrap();
        let before = store.static_public_key().unwrap();

        let after = store.revoke_all().unwrap();

        assert_ne!(before, after, "revoke_all must rotate the key");
        assert_eq!(store.remote_access().unwrap(), settings);
    }

    /// The Relay's admission token is the third remote-access setting,
    /// and absent means none -- the state every store written before the
    /// token existed is in.
    #[test]
    fn a_store_that_was_never_told_has_no_relay_admission() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        assert_eq!(store.remote_access().unwrap().relay_admission, None);
    }

    /// Kept across the switch for the reason the URL is: a token the
    /// human has to find and paste again is one they can paste wrongly.
    #[test]
    fn the_relay_admission_survives_a_reopen_and_the_switch() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        let url = Some("wss://relay.example/gavin".to_string());
        let token = Some("let-me-in".to_string());

        store
            .set_remote_access(&RemoteAccess {
                enabled: true,
                relay_url: url.clone(),
                relay_admission: token.clone(),
            })
            .unwrap();
        store
            .set_remote_access(&RemoteAccess {
                enabled: false,
                relay_url: url.clone(),
                relay_admission: token.clone(),
            })
            .unwrap();

        let read = store.remote_access().unwrap();
        assert!(!read.enabled);
        assert_eq!(read.relay_admission, token);
        assert_eq!(open_store(&dir).remote_access().unwrap(), read);
    }

    /// A cleared field is "no token", never an empty one: the daemon
    /// presents what it reads, and an empty token is one the Relay
    /// refuses by a name that would send the human looking for a typo.
    #[test]
    fn a_blank_relay_admission_reads_back_as_none() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        for blank in ["", "   "] {
            store
                .set_remote_access(&RemoteAccess {
                    enabled: true,
                    relay_url: None,
                    relay_admission: Some(blank.to_string()),
                })
                .unwrap();
            assert_eq!(store.remote_access().unwrap().relay_admission, None, "{blank:?}");
        }
        // And what is kept is trimmed: a token pasted with the newline
        // that followed it in a terminal is still that token.
        store
            .set_remote_access(&RemoteAccess {
                enabled: true,
                relay_url: None,
                relay_admission: Some("  let-me-in\n".to_string()),
            })
            .unwrap();
        assert_eq!(
            store.remote_access().unwrap().relay_admission.as_deref(),
            Some("let-me-in")
        );
    }

    /// The store this daemon finds on a machine that paired in phase 2:
    /// the two settings that existed then, written as they were written
    /// then, and no token. No column was added -- `trust_meta` is
    /// key/value precisely so a new setting is a row -- so what has to
    /// hold is that the missing row reads as "none" and the rows that
    /// are there are left as they were.
    #[test]
    fn a_store_from_before_the_token_reads_it_as_absent() {
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
                    last_seen_at_us INTEGER NOT NULL,
                    revoked_at_us INTEGER
                );
                CREATE TABLE trust_meta (key TEXT PRIMARY KEY, value BLOB NOT NULL);
                INSERT INTO trust_meta (key, value) VALUES
                    ('remote_access_enabled', X'31'),
                    ('remote_access_relay_url', CAST('wss://relay.example/gavin' AS BLOB))",
            )
            .unwrap();
        }

        let store = TrustStore::open(&path).unwrap();
        let read = store.remote_access().unwrap();
        assert!(read.enabled);
        assert_eq!(read.relay_url.as_deref(), Some("wss://relay.example/gavin"));
        assert_eq!(read.relay_admission, None);

        // And the token is writable on the old file.
        store
            .set_remote_access(&RemoteAccess {
                relay_admission: Some("let-me-in".into()),
                ..read
            })
            .unwrap();
        let read = open_store(&dir).remote_access().unwrap();
        assert_eq!(read.relay_admission.as_deref(), Some("let-me-in"));
        assert_eq!(read.relay_url.as_deref(), Some("wss://relay.example/gavin"));
    }

    /// One string for both ends of the handshake: the daemon's responder
    /// builds from this, and the Companion core's initiator from the
    /// protocol crate's.
    #[test]
    fn the_noise_parameters_are_the_protocol_crates() {
        assert_eq!(NOISE_PARAMS, protocol::PAIRING_NOISE_PARAMS);
    }

    /// Pairing writes the notification key (`confirm_device`); the send
    /// permission and the counter come after, from the Device and from
    /// the posts. Revoking clears all three, so a revoked phone gets no
    /// more pushes.
    #[test]
    fn notification_key_and_permission_round_trip_and_revoke_clears_them() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        let paired = store.confirm_device("dev-1", &device(1, "phone")).unwrap();
        assert_eq!(paired.notification_key, Some(vec![1u8; 32]));
        assert!(paired.send_permission.is_none());
        assert_eq!(paired.notify_counter, 0);

        let notif = vec![9u8; 32];
        assert!(store.set_notification_key("dev-1", &notif).unwrap());
        assert!(store.set_send_permission("dev-1", "v1.perm.tag").unwrap());
        assert!(store.set_notify_counter("dev-1", 7).unwrap());

        let read = store.device("dev-1").unwrap().unwrap();
        assert_eq!(read.notification_key.as_deref(), Some(notif.as_slice()));
        assert_eq!(read.send_permission.as_deref(), Some("v1.perm.tag"));
        assert_eq!(read.notify_counter, 7);

        assert!(store.revoke("dev-1").unwrap());
        let revoked = store.device("dev-1").unwrap().unwrap();
        assert!(revoked.notification_key.is_none());
        assert!(revoked.send_permission.is_none());
        assert_eq!(revoked.notify_counter, 0);
    }

    /// A Device that pairs again while still trusted takes the new
    /// notification key, and keeps the send permission it handed over
    /// and the counter the posts reached. The permission is the phone's
    /// grant for this Workstation, still good at the gateway -- which
    /// clears it on its own if it is not. And the counter only goes up:
    /// it is the phone's replay guard, not the nonce (that is random),
    /// and a phone that keeps the highest counter it has seen from this
    /// Workstation would drop every push after a restart as a replay.
    #[test]
    fn pairing_again_keeps_the_send_permission_and_the_counter() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        store.confirm_device("dev-1", &device(1, "Pixel")).unwrap();
        store.set_send_permission("dev-1", "v1.perm.tag").unwrap();
        store.set_notify_counter("dev-1", 7).unwrap();

        let again = Registration { notification_key: vec![0x52; 32], ..device(1, "Pixel") };
        let revived = store.confirm_device("dev-2", &again).unwrap();
        assert_eq!(revived.device_id, "dev-1");
        assert_eq!(revived.notification_key, Some(vec![0x52; 32]));
        assert_eq!(revived.send_permission.as_deref(), Some("v1.perm.tag"));
        assert_eq!(revived.notify_counter, 7);
    }

    #[test]
    fn a_devices_database_from_before_notifications_gains_the_columns() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devices.sqlite");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE devices (
                    device_id TEXT PRIMARY KEY,
                    public_key BLOB NOT NULL,
                    name TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'remote',
                    created_at_us INTEGER NOT NULL,
                    last_seen_at_us INTEGER NOT NULL,
                    revoked_at_us INTEGER
                );
                CREATE TABLE trust_meta (key TEXT PRIMARY KEY, value BLOB NOT NULL);
                INSERT INTO devices
                    (device_id, public_key, name, role, created_at_us, last_seen_at_us, revoked_at_us)
                 VALUES ('dev-1', X'01', 'old', 'remote', 1, 1, NULL);",
            )
            .unwrap();
        }
        let store = TrustStore::open(&path).unwrap();
        let device = store.device("dev-1").unwrap().unwrap();
        assert!(device.notification_key.is_none());
        assert!(device.send_permission.is_none());
        assert_eq!(device.notify_counter, 0);
        assert!(store.set_notification_key("dev-1", &[3u8; 32]).unwrap());
        assert!(store.set_send_permission("dev-1", "v1.perm.tag").unwrap());
    }

    #[test]
    fn push_gateway_url_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir);
        assert_eq!(store.push_gateway_url().unwrap(), None);
        store.set_push_gateway_url(Some("https://push.example")).unwrap();
        assert_eq!(
            store.push_gateway_url().unwrap().as_deref(),
            Some("https://push.example")
        );
        store.set_push_gateway_url(Some("  ")).unwrap();
        assert_eq!(store.push_gateway_url().unwrap(), None);
    }
}
