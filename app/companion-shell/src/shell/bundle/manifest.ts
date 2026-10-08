// The Companion bundle's manifest and the answer that carries it, as the
// shell reads them (ADR 0005; `protocol::companion_bundle`).
//
// Like the attention request, the bundle fetch is between the shell and
// Workstations of every version, so it carries an explicit API version
// and only ever grows by optional fields: this reads what it knows and
// passes over what it does not. The manifest is checked here for what
// can be checked without the archive -- its shape, its size, and whether
// the shell trusts its signer -- so a bundle that would be refused is
// never fetched. The signature itself is the Companion core's to verify,
// once the archive is in hand (`core.bundleOpen`).
import type { Connection } from "$shell/connection/connection";

/// `protocol::COMPANION_BUNDLE_API_VERSION`: what this shell reads.
export const COMPANION_BUNDLE_API_VERSION = 1;

/// `protocol::companion_bundle::BUNDLE_CHUNK_MAX`: the most archive bytes
/// one answer carries. A fetch asks for exactly this much at a time.
export const BUNDLE_CHUNK_MAX = 256 * 1024;

/// `protocol::companion_bundle::BUNDLE_SIZE_MAX`: the largest archive a
/// Device fetches. A manifest claiming more is refused before a byte is
/// asked for.
export const BUNDLE_SIZE_MAX = 64 * 1024 * 1024;

/// What a Workstation says of the bundle it serves, signed at build
/// time. Read tolerantly: a field this build does not know is dropped.
export interface BundleManifest {
  /// SHA-256 of the archive, lowercase hex. The name it is cached under.
  hash: string;
  size: number;
  /// Ed25519 over the signing message, hex.
  signature: string;
  /// The public key it verifies under, hex.
  signer: string;
  format: string;
  gavinVersion: string;
}

export type BundleAnswer =
  /// The Workstation's desktop app answered: the manifest of the bundle
  /// it carries (or null, for a build that carries none) and the slice
  /// asked for.
  | { state: "ready"; manifest: BundleManifest | null; offset: number; data: string }
  /// Nothing can serve a bundle: the desktop app is not running there.
  | { state: "desktop-app-not-running" };

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

/// How long a Workstation has to answer one ask. The desktop answers
/// from memory; the time is the Relay's. The Workstation's own wait for
/// its desktop (the daemon's `BUNDLE_BUDGET`, 25 s) sits under this.
export const BUNDLE_ASK_TIMEOUT_MS = 30_000;

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_128 = /^[0-9a-f]{128}$/;

/// Asks for the manifest and the slice `offset..offset+length` (length 0
/// for the manifest alone), and reads the answer. Rejects with
/// `BundleError` for an answer this build cannot read, and with the
/// connection's own error when it fails or times out.
export async function askBundle(
  connection: Connection,
  offset: number,
  length: number,
  timeoutMs = BUNDLE_ASK_TIMEOUT_MS
): Promise<BundleAnswer> {
  const reply = await connection.request(
    { type: "GetCompanionBundle", version: COMPANION_BUNDLE_API_VERSION, offset, length },
    (r) => isObject(r) && (r.type === "CompanionBundle" || r.type === "Error" || r.type === "Unsupported"),
    timeoutMs
  );
  return readBundleAnswer(reply);
}

export function readBundleAnswer(reply: unknown): BundleAnswer {
  if (!isObject(reply)) throw new BundleError("The Workstation's answer is not one this Companion reads.");
  if (reply.type === "Unsupported") {
    throw new BundleError("The Workstation's Gavin is too old to serve its UI to this phone. Update Gavin at the desk.");
  }
  if (reply.type === "Error") {
    throw new BundleError(
      `The Workstation did not serve its UI${typeof reply.message === "string" ? `: ${reply.message}` : ""}. Its Gavin may be older than this Companion.`
    );
  }
  if (reply.type !== "CompanionBundle") throw new BundleError("The Workstation's answer is not one this Companion reads.");
  if (reply.state === "desktop-app-not-running") return { state: "desktop-app-not-running" };
  if (reply.state !== "ready") {
    throw new BundleError("The Workstation reports a state this Companion does not know. Update the Companion.");
  }
  const manifest = reply.manifest === undefined || reply.manifest === null ? null : readManifest(reply.manifest);
  return {
    state: "ready",
    manifest,
    offset: typeof reply.offset === "number" && Number.isInteger(reply.offset) && reply.offset >= 0 ? reply.offset : 0,
    data: typeof reply.data === "string" ? reply.data : "",
  };
}

/// A manifest as the wire carried it, or a `BundleError` naming what is
/// wrong with it. Everything `protocol::companion_bundle::check_manifest`
/// checks before an archive is looked at, so the fetch is never started
/// for a bundle the core would refuse on its manifest alone.
export function readManifest(value: unknown): BundleManifest {
  if (!isObject(value)) throw new BundleError("The Workstation's bundle manifest is not one this Companion reads.");
  const { hash, size, signature, signer, format, gavinVersion } = value;
  if (typeof format !== "string" || format !== "tar") {
    throw new BundleError(`The Workstation's UI is in a format this Companion does not read (${String(format)}). Update the Companion.`);
  }
  if (typeof hash !== "string" || !HEX_64.test(hash)) throw new BundleError("The Workstation's bundle manifest names no hash.");
  if (typeof signer !== "string" || !HEX_64.test(signer)) throw new BundleError("The Workstation's bundle manifest names no signer.");
  if (typeof signature !== "string" || !HEX_128.test(signature)) {
    throw new BundleError("The Workstation's bundle manifest carries no signature.");
  }
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
    throw new BundleError("The Workstation's bundle manifest names no size.");
  }
  if (size > BUNDLE_SIZE_MAX) {
    throw new BundleError(`The Workstation's UI is larger than this Companion will fetch (${size} bytes).`);
  }
  return { hash, size, signature, signer, format, gavinVersion: typeof gavinVersion === "string" ? gavinVersion : "" };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
