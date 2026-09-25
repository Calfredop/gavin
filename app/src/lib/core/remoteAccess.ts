// The Settings panel's Remote access section, as logic: the pairing
// ceremony's state machine, the device list's presentation, and the words
// every prompt in it says. `GlobalSettingsView.svelte` is a template over
// this and holds no rule of its own -- the repo's split (CLAUDE.md), and
// the only one that lets a rendered surface be tested at all.
//
// What the section is FOR, said once here because three different pieces
// of copy below depend on it being true: phase 2 gives the daemon a trust
// store and a pairing handshake and NO transport
// (`docs/security/05-remote-access.md` §10). Nothing listens, nothing
// dials. Turning remote access on records a choice; pairing a device
// writes a row. Both are real and durable, and neither makes this machine
// reachable from anywhere, because there is nothing yet to reach it
// through.

import { relativeTime } from "$lib/hub/appHub";
import { featureBlockedReason, type DaemonCompat } from "$lib/core/daemonCompat";
import { qrSvg } from "$lib/core/qr";

/// One row of the daemon's trust store, as `protocol::DeviceInfo` puts it
/// on the wire. The static public key is deliberately NOT here: the
/// daemon is what matches a handshake against the store, and a key on
/// screen invites a human to compare it by eye -- the job the six-digit
/// SAS exists to do properly.
export interface DeviceInfo {
  deviceId: string;
  name: string;
  /// `remote` for a paired phone; `app` is reserved for the ssh case.
  /// A string rather than a union, so a row written by a NEWER daemon
  /// reaches this screen as the word it was written with.
  role: string;
  /// Wall-clock epoch SECONDS, all three.
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
  /// Unseen for ninety days. Computed by the DAEMON, never re-derived
  /// here: the ninety-day window is the daemon's rule to enforce, and a
  /// second opinion in the app could grey a row the daemon will still
  /// accept, or leave un-greyed one it will refuse.
  stale: boolean;
}

/// `ListDevices`'s whole answer. The two settings ride along with the
/// rows rather than getting a request of their own, so the toggle, the
/// relay field and the list cannot draw three disagreeing accounts of one
/// store.
export interface DeviceList {
  devices: DeviceInfo[];
  remoteAccessEnabled: boolean;
  relayUrl: string | null;
}

/// `BeginPairing`'s answer.
export interface PairingOffer {
  /// `protocol::PairingQr`'s compact JSON. Opaque here: this module draws
  /// it and never reads inside it.
  qr: string;
  /// Wall-clock epoch SECONDS, the daemon's clock.
  expiresAt: number;
}

/// The `DevicePairingRequested` push: a phone finished the handshake and
/// is waiting on the human.
export interface PairingRequest {
  deviceId: string;
  name: string;
  /// Six decimal digits, derived from both static keys. The human
  /// compares them against the phone's screen.
  sas: string;
}

// -- the ceremony's state machine -------------------------------------

/// Where the pairing ceremony is. One at a time, deliberately: the daemon
/// keeps one offer and the human is looking at one QR.
export type PairingState =
  | { phase: "idle" }
  | { phase: "offer"; qr: string; expiresAt: number }
  | { phase: "requested"; qr: string; expiresAt: number; request: PairingRequest }
  | { phase: "confirmed"; request: PairingRequest }
  | { phase: "rejected"; request: PairingRequest }
  | { phase: "expired" };

export const PAIRING_IDLE: PairingState = { phase: "idle" };

/// `BeginPairing` answered. Reachable from ANY phase: pressing "Pair a
/// device" again starts the ceremony over, which is exactly what the
/// daemon does with the old offer and any handshake that rode on it.
export function pairingOffered(offer: PairingOffer): PairingState {
  return { phase: "offer", qr: offer.qr, expiresAt: offer.expiresAt };
}

/// A `DevicePairingRequested` push arrived.
///
/// Only from `offer`. A second request while one is still unanswered is
/// IGNORED rather than shown, because the human is already comparing six
/// digits against a phone in their hand, and swapping those digits out
/// from under them is precisely how a code nobody compared gets
/// confirmed. The recovery is pressing "Pair a device" again.
///
/// Ignored from `idle` too: a push with no offer on screen is either a
/// stale one or a handshake against an offer this window did not make,
/// and neither is a question to put in front of the human here.
export function pairingRequested(state: PairingState, request: PairingRequest): PairingState {
  if (state.phase !== "offer") return state;
  return { phase: "requested", qr: state.qr, expiresAt: state.expiresAt, request };
}

/// The human pressed Confirm, and `ConfirmPairing` succeeded.
export function pairingConfirmed(state: PairingState): PairingState {
  if (state.phase !== "requested") return state;
  return { phase: "confirmed", request: state.request };
}

/// The human pressed Reject, or the confirm failed and the app rejected
/// on their behalf.
export function pairingRejected(state: PairingState): PairingState {
  if (state.phase !== "requested") return state;
  return { phase: "rejected", request: state.request };
}

/// The two-minute window ran out.
///
/// Only an `offer` expires. Once a phone has completed the handshake the
/// secret has done its work: the window gates when a handshake may
/// START, and cutting the human off mid-comparison because a timer ran
/// out would throw away a ceremony that is already finished and force
/// the whole thing again.
export function pairingTick(state: PairingState, nowMs: number): PairingState {
  if (state.phase !== "offer") return state;
  return secondsLeft(state.expiresAt, nowMs) > 0 ? state : { phase: "expired" };
}

/// The human dismissed the panel.
export function pairingClosed(): PairingState {
  return PAIRING_IDLE;
}

/// Whether the QR panel is on screen at all.
export function pairingOpen(state: PairingState): boolean {
  return state.phase !== "idle";
}

/// Seconds until the offer lapses, never negative. Derived from the
/// daemon's absolute stamp rather than counted down from two minutes, so
/// a panel left open across a laptop suspend shows the truth when the
/// screen comes back.
export function secondsLeft(expiresAt: number, nowMs: number): number {
  return Math.max(0, Math.ceil(expiresAt - nowMs / 1000));
}

/// `1:59`, `0:05`, or `expired`.
export function countdownLabel(expiresAt: number, nowMs: number): string {
  const left = secondsLeft(expiresAt, nowMs);
  if (left === 0) return "expired";
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

/// `123456` -> `123 456`. Two groups of three, because that is how a
/// human reads six digits off one screen and checks them against
/// another; an unbroken run is where a transposition hides.
export function formatSas(sas: string): string {
  return /^\d{6}$/.test(sas) ? `${sas.slice(0, 3)} ${sas.slice(3)}` : sas;
}

// -- the QR ------------------------------------------------------------

export interface QrDraw {
  /// The side of the square, quiet zone included.
  size: number;
  /// The `d` of one `<path>`. Empty when `error` is set.
  path: string;
  /// Why there is nothing to draw, or null. Shown instead of the code:
  /// a blank square where a QR should be is a panel that looks broken
  /// and says nothing.
  error: string | null;
}

export function qrDraw(payload: string): QrDraw {
  try {
    const { size, path } = qrSvg(payload);
    return { size, path, error: null };
  } catch (e) {
    return { size: 0, path: "", error: e instanceof Error ? e.message : String(e) };
  }
}

// -- the device list ---------------------------------------------------

export interface DeviceRow {
  deviceId: string;
  name: string;
  role: string;
  /// "3w ago" / "just now". Relative on purpose: the question a row
  /// answers is "is this still something I use", not "what date was it".
  pairedAt: string;
  lastSeen: string;
  /// The absolute stamps, for the row's `title`. Relative text is for
  /// reading at a glance; the exact moment is for the one time it
  /// matters.
  pairedAtTitle: string;
  lastSeenTitle: string;
  /// Greyed out: revoked, or unseen for ninety days.
  dimmed: boolean;
  /// What is wrong with the row, in the fewest words that are true, or
  /// null for a device that simply works.
  note: string | null;
  /// Whether Revoke would do anything. A revoked row keeps its button
  /// disabled rather than losing it: a button that vanishes leaves the
  /// reader wondering whether they clicked it.
  revocable: boolean;
}

/// §3's own words for a device the daemon will refuse until it is paired
/// again. Exported so the surfaces test can hold the section to it.
export const STALE_NOTE = "re-pair to use";
export const REVOKED_NOTE = "revoked";

export function deviceRows(devices: DeviceInfo[], nowMs: number): DeviceRow[] {
  return [...devices]
    // Revoked rows last, then most recently seen first. A revoked device
    // is kept on screen -- it is the record that the revocation happened
    // -- but it is not what the human came to this list to find.
    .sort((a, b) => {
      const revoked = Number(a.revokedAt !== null) - Number(b.revokedAt !== null);
      return revoked !== 0 ? revoked : b.lastSeenAt - a.lastSeenAt;
    })
    .map((d) => ({
      deviceId: d.deviceId,
      name: d.name,
      role: d.role,
      pairedAt: relativeTime(d.createdAt * 1000, nowMs),
      lastSeen: relativeTime(d.lastSeenAt * 1000, nowMs),
      pairedAtTitle: new Date(d.createdAt * 1000).toLocaleString(),
      lastSeenTitle: new Date(d.lastSeenAt * 1000).toLocaleString(),
      dimmed: d.revokedAt !== null || d.stale,
      note: d.revokedAt !== null ? REVOKED_NOTE : d.stale ? STALE_NOTE : null,
      revocable: d.revokedAt === null,
    }));
}

/// What the list says when it is empty. Not "no devices": the sentence
/// has to say that pairing is the thing that makes one exist, because
/// nothing else on this screen does.
export const NO_DEVICES = "No devices are paired. Pair a device is what makes one exist.";

// -- the prompts -------------------------------------------------------

/// The shape `askConfirm` takes. Declared structurally rather than
/// imported so this module stays free of the dialog queue -- it decides
/// what is ASKED, and `dialog.ts` owns the asking.
export interface ConfirmCopy {
  title: string;
  lines: string[];
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
}

/// The question the six digits are for.
///
/// `danger` is not about destruction here: it is what keeps keyboard
/// focus on the dismissing button (`ConfirmPrompt.svelte`), so Enter
/// cannot confirm a code nobody compared. That is the entire point of an
/// SAS -- an attacker who photographed the QR and scanned it faster gets
/// a dialog whose digits do not match the phone in the human's hand --
/// and a prompt answerable by reflex would give it away.
export function pairingConfirmCopy(request: PairingRequest): ConfirmCopy {
  return {
    title: `Pair “${request.name}”?`,
    lines: [
      `Your phone should be showing ${formatSas(request.sas)}. If it is showing anything else, reject this: some other device completed the handshake.`,
      "Confirming is what writes this device into the daemon's trust store. Until you confirm, it does not exist.",
      "If you lose the phone, Revoke all devices is the one-button answer — it rotates the daemon's key, so every device has to pair again.",
    ],
    confirmLabel: "Pair this device",
    cancelLabel: "Reject",
    danger: true,
  };
}

export function revokeDeviceCopy(row: { name: string }): ConfirmCopy {
  return {
    title: `Revoke “${row.name}”?`,
    lines: [
      "The daemon stops trusting this device immediately and drops any connection it has open — whether gavin is on screen or not.",
      "It can pair again from here; pairing is what makes a device exist.",
    ],
    confirmLabel: "Revoke device",
    cancelLabel: "Cancel",
    danger: true,
  };
}

/// The one-button answer to a lost phone (§3, "Revocation").
export function revokeAllCopy(): ConfirmCopy {
  return {
    title: "Revoke all devices?",
    lines: [
      "Every paired device is revoked AND the daemon's own key is rotated. Each phone pinned the old key, so none of them can come back even if the trust store is later restored from a backup.",
      "Every phone has to pair again from this screen.",
      "This is the answer to a phone you have lost.",
    ],
    confirmLabel: "Revoke all and rotate the key",
    cancelLabel: "Cancel",
    danger: true,
  };
}

// -- the section's own copy -------------------------------------------

/// What "on" actually means in this build. The section says it in its own
/// words because the alternative is a switch that promises reachability
/// and delivers a row in a database -- and the human would only find out
/// when a phone they do not have yet failed to connect.
export const TRANSPORT_NOTE =
  "Nothing listens and nothing dials: this build has no transport yet, so turning remote access on records the choice for a phone app that does not exist yet. What IS real is the trust store — a paired device is written to disk, and revoking one holds at 02:00 with gavin closed.";

/// The relay field's own line. The daemon keeps the URL raw and has no
/// opinion about which relay you self-host, so neither does this.
export const RELAY_NOTE =
  "Where a phone would reach this daemon once there is something to reach it through. Empty means LAN only. It is stored exactly as typed — gavin has no opinion about whose relay it is — and it goes into the pairing QR so a phone knows where to look.";

/// The relay URL to send, or null for "no relay, LAN only".
export function relayUrlToSave(draft: string): string | null {
  const trimmed = draft.trim();
  return trimmed === "" ? null : trimmed;
}

/// A hint, never a refusal. The daemon stores the string raw (§11 Q2), so
/// the app has no standing to reject one — but a value with no scheme is
/// almost certainly a half-typed one, and saying so beats storing it
/// silently.
export function relayUrlHint(draft: string): string | null {
  const trimmed = draft.trim();
  if (trimmed === "" || trimmed.includes("://")) return null;
  return "No scheme — a relay URL usually starts wss:// or https://. Saved as typed either way.";
}

/// The gate. Every control in the section reads this: the toggle, the
/// relay row, Pair a device, each Revoke, and Revoke all devices. Without
/// a consumer the `FEATURE_MIN_VERSION.remoteAccess` entry the handshake
/// task added gates nothing at all (CLAUDE.md).
///
/// Null when the daemon is new enough, or when there is no verdict yet --
/// `featureBlockedReason` does not pre-emptively grey a surface out
/// before the app has connected.
export function remoteAccessBlocked(compat: DaemonCompat | null): string | null {
  return featureBlockedReason(compat, "remoteAccess");
}
