//! The Companion core, as the Companion shell's web layer calls it.
//!
//! The shell runs the core compiled to `wasm32-unknown-unknown`
//! (`docs/superpowers/specs/2026-09-27-companion-design.md`, "The
//! Companion shell"). This crate is the whole of what that module
//! exports: a way to hand it bytes, one function that answers a call, and
//! a way to read the answer back. Everything the calls do is the core's;
//! nothing here computes a byte of the wire.
//!
//! **A plain C ABI, and JSON across it.** No `wasm-bindgen`: the shell's
//! pipeline then needs cargo and the target and nothing else, and the
//! module imports nothing, so the web layer instantiates it with an empty
//! import object. The price is that bytes cross as hex, and at pairing's
//! sizes -- a handful of frames of a few hundred bytes -- that price is
//! nothing.
//!
//! **One exchange per instance.** An instance holds at most one pairing,
//! and the shell makes a fresh instance for each. A module that trapped
//! halfway through a call -- a panic is a trap on this target -- is then
//! thrown away with the one exchange it was running, and never asked
//! anything again.
//!
//! **The calls** (`op`, then its fields, camelCase):
//!
//! | op | takes | answers |
//! |---|---|---|
//! | `pairing-start` | `qr`, `noisePrivateKey`, `hardwareKey`, `deviceName`, `entropy` | `send`, `dials`, `workstationKey` |
//! | `pairing-receive` | `bytes` | `events` |
//! | `pairing-prove` | `signature` | `events` |
//! | `relay-reply` | `text` | `reply`, and for a refusal `reason` and `message` |
//!
//! Every answer is `{"ok": …}` or `{"error": {"kind", "message"}}`. The
//! kinds are the core's `CoreError` by name, and `request` for a call
//! that was not one.

use companion_core::connect::PairedWorkstation;
use companion_core::pairing::{relay_dials, PairingClient, PairingEvent};
use companion_core::{CoreError, DeviceKeys, Entropy};
use protocol::device_wire::{self, PairingVerdict};
use protocol::relay::RelayReply;
use protocol::PairingQr;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::RefCell;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case", rename_all_fields = "camelCase")]
enum Call {
    /// Reads the QR and prepares the handshake's first message, which is
    /// held until the Relay says the Workstation is there. Everything a
    /// pairing can be refused for before a byte is sent -- a code that is
    /// not one, a Workstation too old to pair with, a key of the wrong
    /// shape -- is refused here, before anything is dialled.
    PairingStart {
        qr: String,
        noise_private_key: String,
        hardware_key: String,
        device_name: String,
        entropy: String,
    },
    PairingReceive {
        bytes: String,
    },
    PairingProve {
        signature: String,
    },
    /// Reads one of the Relay's text frames.
    RelayReply {
        text: String,
    },
}

/// What the caller does next, for the web layer.
#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum Event {
    Send {
        bytes: String,
    },
    /// Have the hardware key sign this handshake hash. The bare hash,
    /// because that is what the native plugins take: they build the
    /// signed message themselves, so the hardware key can never be handed
    /// a message that means something anywhere else.
    Prove {
        handshake_hash: String,
    },
    CompareCode {
        code: String,
    },
    Finished(Finished),
}

#[derive(Serialize)]
#[serde(tag = "verdict", rename_all = "kebab-case")]
enum Finished {
    Paired { workstation: Kept },
    Rejected,
    Expired,
    Unknown,
}

/// What the shell keeps about a Workstation it paired with: the core's
/// `PairedWorkstation`, as the web layer stores it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Kept {
    workstation_key: String,
    relays: Vec<String>,
    relay_admission: Option<String>,
    device_id: String,
    notification_key: String,
}

impl From<&PairedWorkstation> for Kept {
    fn from(paired: &PairedWorkstation) -> Self {
        Self {
            workstation_key: protocol::hex_encode(&paired.workstation_key),
            relays: paired.relays.clone(),
            relay_admission: paired.relay_admission.clone(),
            device_id: paired.device_id.clone(),
            notification_key: protocol::hex_encode(&paired.notification_key),
        }
    }
}

struct Failure {
    kind: &'static str,
    message: String,
}

impl Failure {
    fn request(message: impl Into<String>) -> Self {
        Self {
            kind: "request",
            message: message.into(),
        }
    }
}

impl From<CoreError> for Failure {
    fn from(e: CoreError) -> Self {
        let kind = match e {
            CoreError::Offer(_) => "offer",
            CoreError::Entropy => "entropy",
            CoreError::WrongWorkstation => "wrong-workstation",
            CoreError::HardwareKey(_) => "hardware-key",
            CoreError::Handshake(_) => "handshake",
            CoreError::Frame(_) => "frame",
            CoreError::NotReady => "not-ready",
            CoreError::Finished => "finished",
        };
        Self {
            kind,
            message: e.to_string(),
        }
    }
}

struct Pairing {
    client: PairingClient,
    offer: PairingQr,
}

thread_local! {
    /// The one exchange this instance runs.
    static PAIRING: RefCell<Option<Pairing>> = const { RefCell::new(None) };
    /// The last answer, until the next call replaces it.
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Answers one call: `input` is its JSON, and so is what comes back.
pub fn call(input: &[u8]) -> Vec<u8> {
    let answer = match serde_json::from_slice::<Call>(input) {
        Ok(call) => answer(call),
        Err(e) => Err(Failure::request(format!(
            "not a call this core answers: {e}"
        ))),
    };
    let value = match answer {
        Ok(ok) => json!({ "ok": ok }),
        Err(failure) => json!({ "error": { "kind": failure.kind, "message": failure.message } }),
    };
    serde_json::to_vec(&value).unwrap_or_default()
}

fn answer(call: Call) -> Result<Value, Failure> {
    match call {
        Call::PairingStart {
            qr,
            noise_private_key,
            hardware_key,
            device_name,
            entropy,
        } => {
            if PAIRING.with(|p| p.borrow().is_some()) {
                return Err(Failure::request(
                    "this instance already ran a pairing; each exchange gets an instance of its own",
                ));
            }
            let offer = PairingQr::parse(&qr)
                .map_err(|e| CoreError::Offer(format!("it is not a Gavin pairing code ({e})")))?;
            let keys = DeviceKeys::from_private(&bytes("noisePrivateKey", &noise_private_key)?)?;
            let hardware_key = bytes("hardwareKey", &hardware_key)?;
            let entropy = Entropy::from_bytes(bytes("entropy", &entropy)?);
            let dials = relay_dials(&offer)?;
            let (client, first) =
                PairingClient::start(&offer, &keys, &hardware_key, &device_name, entropy)?;
            let answer = json!({
                "send": protocol::hex_encode(&first),
                "workstationKey": offer.daemon_public_key,
                "dials": dials
                    .iter()
                    .map(|dial| json!({ "url": dial.url, "hello": dial.hello.to_frame() }))
                    .collect::<Vec<_>>(),
            });
            PAIRING.with(|p| *p.borrow_mut() = Some(Pairing { client, offer }));
            Ok(answer)
        }
        Call::PairingReceive { bytes: arrived } => {
            let arrived = bytes("bytes", &arrived)?;
            with_pairing(|pairing| {
                let events = pairing.client.receive(&arrived)?;
                events_for(pairing, events)
            })
        }
        Call::PairingProve { signature } => {
            let signature = bytes("signature", &signature)?;
            with_pairing(|pairing| {
                let events = pairing.client.prove(&signature)?;
                events_for(pairing, events)
            })
        }
        Call::RelayReply { text } => match RelayReply::from_frame(&text) {
            Ok(RelayReply::Ready) => Ok(json!({ "reply": "ready" })),
            Ok(RelayReply::Refused { reason }) => Ok(json!({
                "reply": "refused",
                "reason": reason,
                "message": reason.to_string(),
            })),
            // An announcement is a Workstation's to read, and a reply a
            // newer Relay sent is none this Device can act on.
            Ok(RelayReply::Incoming { .. } | RelayReply::Unknown) => {
                Ok(json!({ "reply": "other" }))
            }
            Err(e) => Err(Failure::request(format!("not a reply from a Relay: {e}"))),
        },
    }
}

fn with_pairing(f: impl FnOnce(&mut Pairing) -> Result<Value, Failure>) -> Result<Value, Failure> {
    PAIRING.with(|p| match p.borrow_mut().as_mut() {
        Some(pairing) => f(pairing),
        None => Err(Failure::from(CoreError::NotReady)),
    })
}

fn events_for(pairing: &Pairing, events: Vec<PairingEvent>) -> Result<Value, Failure> {
    let events = events
        .into_iter()
        .map(|event| event_for(pairing, event))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({ "events": events }))
}

fn event_for(pairing: &Pairing, event: PairingEvent) -> Result<Event, Failure> {
    Ok(match event {
        PairingEvent::Send(bytes) => Event::Send {
            bytes: protocol::hex_encode(&bytes),
        },
        PairingEvent::Prove { message } => Event::Prove {
            handshake_hash: protocol::hex_encode(&handshake_hash(&message)?),
        },
        PairingEvent::CompareCode { sas } => Event::CompareCode { code: sas },
        PairingEvent::Finished(verdict) => Event::Finished(match &verdict {
            PairingVerdict::Paired { .. } => {
                match PairedWorkstation::from_pairing(&pairing.offer, &verdict)? {
                    Some(paired) => Finished::Paired {
                        workstation: Kept::from(&paired),
                    },
                    None => Finished::Unknown,
                }
            }
            PairingVerdict::Rejected => Finished::Rejected,
            PairingVerdict::Expired => Finished::Expired,
            PairingVerdict::Unknown => Finished::Unknown,
        }),
    })
}

/// The handshake hash out of the message the core asks to have signed:
/// `device_wire::unlock_message`, whose prefix the native plugins add
/// themselves.
fn handshake_hash(message: &[u8]) -> Result<Vec<u8>, Failure> {
    let prefix = device_wire::unlock_message(&[]);
    match message.strip_prefix(prefix.as_slice()) {
        Some(hash) if hash.len() == HANDSHAKE_HASH_BYTES => Ok(hash.to_vec()),
        _ => Err(Failure::from(CoreError::Handshake(
            "the message to sign is not an unlock message over a 32-byte handshake hash".into(),
        ))),
    }
}

/// BLAKE2s, in both handshakes: what the native plugins accept, and
/// nothing else.
const HANDSHAKE_HASH_BYTES: usize = 32;

fn bytes(field: &str, hex: &str) -> Result<Vec<u8>, Failure> {
    protocol::hex_decode(hex).map_err(|e| Failure::request(format!("{field} is not hex ({e})")))
}

// -- the ABI --------------------------------------------------------------

/// Room for `len` bytes of a call, for the caller to write into and hand
/// to `gavin_call`.
#[no_mangle]
pub extern "C" fn gavin_alloc(len: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
}

/// Answers the call in the `len` bytes at `ptr` and returns the length of
/// the answer, which `gavin_output` points at until the next call.
///
/// # Safety
///
/// `ptr` and `len` must be what one `gavin_alloc(len)` returned and was
/// asked for, and not yet handed here: this takes the bytes back, wipes
/// them -- a call can carry the Device's Noise key -- and frees them.
#[no_mangle]
pub unsafe extern "C" fn gavin_call(ptr: *mut u8, len: usize) -> usize {
    let mut input = Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len));
    let answer = call(&input);
    input.fill(0);
    drop(input);
    OUTPUT.with(|output| {
        let mut output = output.borrow_mut();
        output.fill(0);
        *output = answer;
        output.len()
    })
}

/// Where the last answer is.
#[no_mangle]
pub extern "C" fn gavin_output() -> *const u8 {
    OUTPUT.with(|output| output.borrow().as_ptr())
}

#[cfg(test)]
mod tests;
