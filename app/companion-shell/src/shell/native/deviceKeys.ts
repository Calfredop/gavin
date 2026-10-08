// The shell's second native plugin: the Device's two keys (ADR 0001).
//
// Like the bundle webview's plugin, only the shell's own web layer -- the
// hub, shipped in the binary -- can call it. A bundle's webview has no
// Capacitor bridge, so no bundle reaches it (the bundle probe tries).
//
// - **The hardware key**, P-256, never leaves the hardware: the Secure
//   Enclave on iOS, StrongBox or else the TEE on Android. It signs only
//   after the owner proves they are there (a biometric, falling back to the
//   passcode), and only one kind of message: `"gavin-device-unlock-v1"`
//   followed by a 32-byte handshake hash, which is what the daemon checks
//   after every handshake (`device_wire::unlock_message`).
// - **The Noise key**, X25519, is 32 bytes kept this-device-only. It has to
//   reach this layer: the Companion core does the Diffie-Hellman in WASM
//   (ADR 0002), and derives the key's public half there too
//   (`DeviceKeys::from_private`) -- neither iOS below Safari 18.4 nor
//   Android below API 33 has X25519 anywhere else.
//
// The decisions over what it reports (whether this phone can be a Device,
// what a refusal says, whether a signature is good) are `keys/deviceKeys.ts`.
import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/// Where the hardware key lives. `software-debug` is the one kind that is
/// not hardware: a debug build on a Simulator or an emulator, which have
/// no presence-gated hardware key to offer, and only a debug daemon
/// accepts it.
export type KeyBacking = "secure-enclave" | "strongbox" | "tee" | "software-debug";

/// What a call can be refused with: the `code` of the rejection.
export type KeysErrorCode =
  /// No passcode (or secure lock screen): nothing here could require the owner.
  | "no-passcode"
  /// No hardware keystore to hold the hardware key.
  | "no-hardware-keystore"
  /// The keys already exist. Creating them again would silently make this
  /// a new Device; delete them first, on purpose.
  | "keys-exist"
  /// There are no keys (never created, deleted, or invalidated by the
  /// phone when its passcode was removed).
  | "no-keys"
  /// The owner dismissed the prompt.
  | "cancelled"
  /// A handshake hash that is not 32 bytes of hex. Refused before any prompt.
  | "bad-hash"
  /// `signUnlocked`: no Unlock is held -- never made, or ended by the
  /// app going to the background or the phone locking.
  | "locked"
  /// `signUnlocked`: the Unlock is held, but the hardware no longer signs
  /// under it. On Android, the key's auth window has closed since the
  /// owner last authenticated; a new Unlock opens it again.
  | "unlock-expired"
  /// `unlock`: the app went to the background while the prompt was up,
  /// so the authentication does not count.
  | "background"
  | "failed";

export interface DeviceKeysStatus {
  platform: "ios" | "android";
  /// A passcode, or a secure lock screen, is set.
  passcodeSet: boolean;
  /// The phone has a hardware keystore. On Android this is the phone's own
  /// claim, which an emulator makes falsely; creating the key reads the
  /// level it actually got, and that is the last word.
  hardwareKeystore: boolean;
  /// This build may fall back to a software key marked `software-debug`:
  /// only a debug build, and on iOS only on a Simulator.
  softwareFallback: boolean;
  /// Present only when both keys are.
  keys: { backing: KeyBacking } | null;
  /// A debug build: the hub shows its keys panel.
  debugBuild: boolean;
  /// A debug build launched to run the keys check (`scripts/keys.sh`).
  checkRequested: boolean;
}

export interface DevicePublicKeys {
  /// The hardware key's public half: the 65-byte uncompressed P-256 point,
  /// hex. What the pairing payload registers.
  hardwareKey: string;
  backing: KeyBacking;
  /// Android: the hardware key's attestation chain, leaf first, each
  /// certificate base64 DER. A release daemon refuses a key that does not
  /// attest TEE or StrongBox. Empty on iOS, which has no such attestation.
  attestation: string[];
}

export interface DeviceKeysPlugin {
  status(): Promise<DeviceKeysStatus>;
  /// Creates both keys. Refused with `no-passcode` or
  /// `no-hardware-keystore` on a phone that cannot be a Device, and with
  /// `keys-exist` when it already is one. `challenge` (hex) goes into the
  /// Android attestation; a random one when absent.
  createKeys(options?: { challenge?: string }): Promise<DevicePublicKeys>;
  publicKeys(): Promise<DevicePublicKeys>;
  /// The Noise key's private half, hex, for the Companion core.
  noiseKey(): Promise<{ privateKey: string }>;
  /// Asks for the owner (Face ID, Touch ID or a fingerprint, else the
  /// passcode), then signs `"gavin-device-unlock-v1" || handshakeHash`
  /// with the hardware key. `reason` is what the prompt says. The
  /// signature is ASN.1 DER, hex.
  sign(options: { handshakeHash: string; reason: string }): Promise<{ signature: string }>;
  deleteKeys(): Promise<void>;
}

/// Where the app is, as the native side sees it (`lifecycle` events):
///
/// - `foreground`: it came back to the front after being in the
///   background. Not sent at launch; `unlockState` says where it is then.
/// - `background`: it went to the background -- Home, the app switcher,
///   another app, a call answered. The native side has already ended the
///   Unlock.
/// - `screen-locked`: the phone locked. The Unlock is ended, likewise.
///
/// Brief interruptions -- Control Center, the notification shade, a call
/// banner, the Unlock's own prompt -- are none of these, and are not sent
/// (`docs/research/2026-09-28-companion-device-keys.md`, "Brief
/// interruptions"). On iOS the shade does send the app to the background,
/// so a background over within two seconds is not sent either, nor the
/// foreground after it (`DeviceKeysPlugin.briefBackground`).
export type LifecyclePhase = "foreground" | "background" | "screen-locked";

export interface UnlockPlugin {
  /// The Unlock (ADR 0004): asks for the owner once -- Face ID, Touch ID
  /// or a fingerprint, else the passcode -- and holds that
  /// authentication while the app stays in front, so `signUnlocked`
  /// signs without asking again. On iOS the evaluated `LAContext` is
  /// held; on Android the hardware key's auth window is what opened.
  /// Refused with `cancelled`, `no-keys`, `no-passcode`, or `background`
  /// when the app left the front while the prompt was up.
  unlock(options: { reason: string }): Promise<void>;
  /// Signs `"gavin-device-unlock-v1" || handshakeHash` under the held
  /// Unlock, never showing anything. Refused with `locked` when no
  /// Unlock is held and `unlock-expired` when the hardware no longer
  /// signs under it.
  signUnlocked(options: { handshakeHash: string }): Promise<{ signature: string }>;
  /// Ends the Unlock.
  lock(): Promise<void>;
  /// Whether an Unlock is held, and whether the app is in front now.
  unlockState(): Promise<{ unlocked: boolean; foreground: boolean }>;
  addListener(event: "lifecycle", listener: (e: { phase: LifecyclePhase }) => void): Promise<PluginListenerHandle>;
}

/// A debug build on iOS: one line per lifecycle notification, with where
/// the app stands, for the console beside `[gavin-unlock]`.
export interface LifecycleTracePlugin {
  addListener(event: "trace", listener: (e: { line: string }) => void): Promise<PluginListenerHandle>;
}

export const DeviceKeys = registerPlugin<DeviceKeysPlugin & UnlockPlugin & LifecycleTracePlugin>("DeviceKeys");
