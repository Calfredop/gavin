// The Settings panel's Remote access section, as logic: the pairing
// ceremony's state machine, the device list's presentation, and the words
// every prompt in it says. `GlobalSettingsView.svelte` is a template over
// this and holds no rule of its own -- the repo's split (CLAUDE.md), and
// the only one that lets a rendered surface be tested at all.
//
// What the section is FOR, said once here because the copy below depends
// on it being true: while remote access is on, the DAEMON dials the Relay
// the human named and holds that connection, with the window open or
// closed (`crates/daemon/src/remote.rs`). Nothing listens on this machine
// -- both ends dial out -- and what travels through the Relay is a Noise
// channel the Relay holds no key for. A Device reaches the Workstation
// through that Relay and nowhere else, and becomes a Device only by
// pairing at the desk.

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
  /// WHETHER the daemon holds an admission token for the Relay, never
  /// what it is. The token is a credential somebody handed the human,
  /// and nothing on the desk needs to read it back.
  relayAdmissionSet: boolean;
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

/// The row this pairing is for, when the trust store already holds one.
///
/// `DevicePairingRequested` names the id the row already has: the daemon
/// files a Device under its Noise key, so the same id is the same key.
/// Which is also all it says: a copy of that key on another phone is the
/// same id, and confirming replaces the hardware key the row trusts.
export function knownDevice(
  request: PairingRequest,
  list: DeviceList | null,
): DeviceInfo | null {
  return list?.devices.find((d) => d.deviceId === request.deviceId) ?? null;
}

function knownDeviceLine(known: DeviceInfo): string {
  return `This desk already trusts a device called “${known.name}” with this identity. Confirming REPLACES that device's keys and drops its open connections: if you are not pairing that phone again right now, reject this.`;
}

/// The question the six digits are for.
///
/// `danger` is not about destruction here: it is what keeps keyboard
/// focus on the dismissing button (`ConfirmPrompt.svelte`), so Enter
/// cannot confirm a code nobody compared. That is the entire point of an
/// SAS -- an attacker who photographed the QR and scanned it faster gets
/// a dialog whose digits do not match the phone in the human's hand --
/// and a prompt answerable by reflex would give it away.
export function pairingConfirmCopy(
  request: PairingRequest,
  known: DeviceInfo | null = null,
): ConfirmCopy {
  return {
    title: `Pair “${request.name}”?`,
    lines: [
      `Your phone should be showing ${formatSas(request.sas)}. If it is showing anything else, reject this: some other device completed the handshake.`,
      ...(known ? [knownDeviceLine(known)] : []),
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

/// What "on" actually means. The section says it in its own words
/// because a switch that makes a background process dial out should say
/// so before it is pressed: what is opened on this machine (nothing),
/// whether it depends on this window (it does not), and what off means.
export const TRANSPORT_NOTE =
  "On, the daemon dials the Relay below and stays connected to it, with this window open or closed. It opens no port on this machine — both ends dial out — and the Relay carries traffic it cannot read. Off, it dials nothing. A Device becomes one only by pairing here, at the desk.";

/// What the note says instead against a daemon that does not dial --
/// one older than v52, which has the switch and the Relay URL and acts on
/// neither. `TRANSPORT_NOTE` would be untrue of it, and the human would
/// turn remote access on, see nothing wrong, and wait for a Device that
/// cannot arrive.
export function transportNote(compat: DaemonCompat | null): string {
  const blocked = featureBlockedReason(compat, "relayDial");
  if (blocked === null) return TRANSPORT_NOTE;
  return `The running daemon dials nothing, whatever this switch says: it keeps the switch and the Relay URL, and acts on neither. ${blocked}`;
}

/// What turning the switch on changes at the desk today, said under the
/// switch because nowhere else would: with it on, the red button no
/// longer quits (keepRunning.ts), and a human who never read this would
/// go looking for an app that did not close.
export const KEEP_RUNNING_NOTE =
  "While it is on, closing the window keeps gavin running in the menu bar — Quit is in that icon's menu — and your Mac does not idle-sleep while an agent is running. The display still sleeps.";

/// The relay field's own line.
export const RELAY_NOTE =
  "The Relay this Workstation and its Devices both dial. It goes into the pairing QR, so a Device that scans it knows where to look. It starts wss:// — or ws:// for a Relay on this machine or this network. Empty means there is nowhere to dial.";

/// The admission token's own line. It has to say that the field is
/// write-only, because the first thing a human does with a credential
/// field that comes back empty is assume the save failed.
export const ADMISSION_NOTE =
  "What the Relay asks of everything it carries: whoever runs the Relay gives it to you. The daemon keeps it and presents it when it dials, and it goes into the pairing QR beside the Relay URL. Once saved it is not shown again. Changing the Relay URL forgets it — a token belongs to the Relay that issued it.";

/// The relay URL to send, or null for "no relay".
export function relayUrlToSave(draft: string): string | null {
  const trimmed = draft.trim();
  return trimmed === "" ? null : trimmed;
}

// -- which Relay URLs the daemon will dial ------------------------------
//
// A mirror of `protocol::relay::RelayUrl::parse`, which is the rule the
// daemon dials by. It is a second implementation in a second language,
// so it is held to the first by a table both suites read:
// `test-fixtures/relay-urls/cases.json`. Change the rule in one place
// and that table fails in the other.

/// Why the daemon will not dial a URL. The kinds are the daemon's own
/// (`RelayUrlError`), under the names the shared table gives them.
export interface RelayUrlProblem {
  kind:
    | "no-scheme"
    | "scheme"
    | "no-host"
    | "host"
    | "port"
    | "credentials"
    | "plain-to-public-host";
  message: string;
}

/// Four decimal parts from 0 to 255, none with a leading zero. Nothing
/// else is an IPv4 address here -- not octal, not hex, not one number.
function parseIpv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/// The eight groups of an IPv6 address, or null. Groups of one to four
/// hex digits, one `::` at most, and an IPv4 address allowed in place of
/// the last two groups. No zone: `fe80::1%en0` is not an address.
function parseIpv6(text: string): number[] | null {
  const halves = text.split("::");
  if (halves.length > 2) return null;

  const groupsOf = (half: string, last: boolean): number[] | null => {
    if (half === "") return [];
    const parts = half.split(":");
    const groups: number[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (last && i === parts.length - 1 && part.includes(".")) {
        const v4 = parseIpv4(part);
        if (v4 === null) return null;
        groups.push(v4[0] * 256 + v4[1], v4[2] * 256 + v4[3]);
      } else if (/^[0-9a-fA-F]{1,4}$/.test(part)) {
        groups.push(parseInt(part, 16));
      } else {
        return null;
      }
    }
    return groups;
  };

  if (halves.length === 1) {
    const groups = groupsOf(halves[0], true);
    return groups !== null && groups.length === 8 ? groups : null;
  }
  const head = groupsOf(halves[0], false);
  const tail = groupsOf(halves[1], true);
  if (head === null || tail === null) return null;
  // `::` stands for at least one group.
  if (head.length + tail.length > 7) return null;
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

function ipv4IsLocal([a, b]: number[]): boolean {
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    // Tailscale hands these out, and encrypts what travels to them.
    (a === 100 && b >= 64 && b <= 127)
  );
}

function ipv6IsLocal(groups: number[]): boolean {
  const loopback = groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
  return loopback || (groups[0] & 0xffc0) === 0xfe80 || (groups[0] & 0xfe00) === 0xfc00;
}

/// A name is local only when it says so itself; any other name is
/// public, because nothing here resolves one.
function nameIsLocal(name: string): boolean {
  const n = (name.endsWith(".") ? name.slice(0, -1) : name).toLowerCase();
  return n === "localhost" || n.endsWith(".localhost") || n.endsWith(".local");
}

/// An unbracketed host: the IPv4 address it is, "name" for a name, or
/// null for something that is neither -- or that a webview's URL parser
/// would read as a different host than the daemon's does. See
/// `name_or_ipv4` in `protocol::relay` for why a host that ends in a
/// number has to be an address written plainly.
function nameOrIpv4(host: string): number[] | "name" | null {
  if (!/^[A-Za-z0-9.-]+$/.test(host)) return null;
  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  const labels = name.split(".");
  if (labels.some((label) => label === "")) return null;
  const last = labels[labels.length - 1];
  if (/^[0-9]+$/.test(last) || /^0x/i.test(last)) return parseIpv4(host);
  return "name";
}

const NOT_A_HOST =
  "The Relay URL's host is not a host name or an address — letters, digits, dots and hyphens, or an address written plainly.";

/// What is wrong with a Relay URL, as the daemon would find it, or null
/// when the daemon will dial it.
export function relayUrlProblem(draft: string): RelayUrlProblem | null {
  const url = draft.trim();
  const at = url.indexOf("://");
  if (at < 0) return { kind: "no-scheme", message: "No scheme — a Relay URL starts wss://." };
  const scheme = url.slice(0, at).toLowerCase();
  if (scheme !== "wss" && scheme !== "ws") {
    return { kind: "scheme", message: `A Relay URL starts wss://, not ${scheme}://.` };
  }
  const authority = url.slice(at + 3).split(/[/?#]/)[0];
  if (authority.includes("@")) {
    return {
      kind: "credentials",
      message:
        "A Relay URL must not carry a user or password — the admission token has its own field.",
    };
  }

  const noHost: RelayUrlProblem = { kind: "no-host", message: "The Relay URL names no host." };
  const badHost: RelayUrlProblem = { kind: "host", message: NOT_A_HOST };
  const badPort: RelayUrlProblem = {
    kind: "port",
    message: "The Relay URL's port is not a number from 1 to 65535.",
  };

  let port: string | null;
  let local: boolean;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close < 0) return noHost;
    const host = authority.slice(1, close);
    if (host === "") return noHost;
    const groups = parseIpv6(host);
    if (groups === null) return badHost;
    const after = authority.slice(close + 1);
    if (after !== "" && !after.startsWith(":")) return badPort;
    port = after === "" ? null : after.slice(1);
    local = ipv6IsLocal(groups);
  } else {
    const colon = authority.lastIndexOf(":");
    const host = colon < 0 ? authority : authority.slice(0, colon);
    port = colon < 0 ? null : authority.slice(colon + 1);
    if (host === "") return noHost;
    const judged = nameOrIpv4(host);
    if (judged === null) return badHost;
    local = judged === "name" ? nameIsLocal(host) : ipv4IsLocal(judged);
  }

  if (port !== null) {
    // Decimal digits and nothing else. `Number` would take a sign, a
    // space and an exponent, and no URL parser does.
    if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return badPort;
  }
  if (scheme === "ws" && !local) {
    return {
      kind: "plain-to-public-host",
      message:
        "ws:// would send the admission token unencrypted — use wss:// for a Relay that is not on this machine or this network.",
    };
  }
  return null;
}

/// A hint, never a refusal to save. The daemon stores the string as
/// typed (§11 Q2) — but it will only DIAL one it can read and may dial,
/// and its one other way of saying so is a line in its log.
export function relayUrlHint(draft: string): string | null {
  if (draft.trim() === "") return null;
  const problem = relayUrlProblem(draft);
  return problem === null
    ? null
    : `${problem.message} Saved as typed, but the daemon will not dial it.`;
}

// -- the admission token ------------------------------------------------

/// What to send for the token: the token typed, or `undefined` to leave
/// the stored one as it is.
///
/// Empty is "unchanged", not "cleared". The field is write-only, so it
/// is empty whenever the human has not just typed into it -- and a save
/// that read that as "clear" would wipe the token every time the switch
/// was toggled. Clearing is its own button, which sends `ADMISSION_CLEAR`.
export function admissionToSave(draft: string): string | undefined {
  const trimmed = draft.trim();
  return trimmed === "" ? undefined : trimmed;
}

/// What the daemon reads as "forget the token".
export const ADMISSION_CLEAR = "";

/// Whether the daemon will hold a token once a save has landed, so the
/// field can say so at once rather than after the next read.
///
/// The daemon's rule (`SessionManager::set_remote_access`), mirrored: a
/// token that was sent is the token; an empty one clears it; and with
/// none sent the stored one is kept FOR THE SAME RELAY. A save that
/// changes the Relay URL forgets it, because the daemon presents what it
/// holds to whatever it dials.
export function admissionAfterSave(
  stored: { relayUrl: string | null; relayAdmissionSet: boolean },
  relayUrl: string | null,
  admission: string | undefined
): boolean {
  if (admission !== undefined) return admission.trim() !== ADMISSION_CLEAR;
  return stored.relayAdmissionSet && stored.relayUrl === relayUrl;
}

/// The field cannot show the token, so this is where it says whether
/// there is one.
export function admissionPlaceholder(set: boolean): string {
  return set ? "A token is stored — type a new one to replace it" : "No token stored";
}

/// The admission field's own gate, on top of the section's. A daemon
/// older than v52 parses `SetRemoteAccess` and drops the token on the
/// floor (the compat gate is per request TYPE), so against one the field
/// would accept a token and keep nothing.
export function relayAdmissionBlocked(compat: DaemonCompat | null): string | null {
  return featureBlockedReason(compat, "relayAdmission");
}

// -- whether pairing can work -------------------------------------------

/// Why a QR drawn now could not pair anything, or null when it could.
///
/// A Device reaches this Workstation through the Relay and nowhere
/// else. With remote access off, or no Relay the daemon will dial, the
/// daemon is not connected to one: a Device would scan the QR, dial, and
/// be told the Workstation is not there -- two minutes of the human's
/// time, spent finding out what this can say before the QR is drawn.
///
/// Null before the settings have been read: unknown is not unavailable.
///
/// A daemon that does not dial at all comes first, and is refused by
/// the version it needs: nothing in the settings can make a QR from it
/// work.
export function pairingUnavailable(
  list: DeviceList | null,
  compat: DaemonCompat | null
): string | null {
  const blocked = featureBlockedReason(compat, "relayDial");
  if (blocked !== null) return blocked;
  if (list === null) return null;
  if (!list.remoteAccessEnabled) {
    return "Turn remote access on first — a Device pairs through the Relay, and with this off the daemon is not connected to it.";
  }
  if (list.relayUrl === null) {
    return "Set a Relay URL first — a Device pairs through the Relay.";
  }
  if (relayUrlHint(list.relayUrl) !== null) {
    return "The daemon will not dial the Relay URL above, so a Device has nowhere to pair through.";
  }
  return null;
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
