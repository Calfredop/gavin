// Fetching a Companion bundle's archive over a Workstation's connection
// (ADR 0005): a chunk at a time, each at most `BUNDLE_CHUNK_MAX` bytes,
// until the manifest's size is in hand.
//
// Every answer carries the manifest again, and this holds the
// Workstation to the one it started with: a desktop that upgrades in the
// middle of a fetch serves a different archive from then on, and the two
// halves would not hash to anything. The fetch stops and says so; the
// next visit fetches the new bundle whole.
import { askBundle, BundleError, BUNDLE_CHUNK_MAX, type BundleManifest } from "$shell/bundle/manifest";
import type { Connection } from "$shell/connection/connection";

export interface FetchProgress {
  /// Bytes in hand, and the manifest's size.
  received: number;
  size: number;
}

export interface FetchOptions {
  onProgress?(progress: FetchProgress): void;
  signal?: AbortSignal;
  /// Per ask.
  timeoutMs?: number;
}

/// The archive `manifest` names, byte for byte, or a `BundleError`.
export async function fetchArchive(
  connection: Connection,
  manifest: BundleManifest,
  options: FetchOptions = {}
): Promise<Uint8Array> {
  const archive = new Uint8Array(manifest.size);
  let received = 0;
  options.onProgress?.({ received, size: manifest.size });
  while (received < manifest.size) {
    if (options.signal?.aborted) throw new BundleError("The fetch was stopped.");
    const answer = await askBundle(connection, received, BUNDLE_CHUNK_MAX, options.timeoutMs);
    if (answer.state !== "ready") {
      throw new BundleError("Gavin's desktop app stopped running at the desk while its UI was being fetched.");
    }
    if (!answer.manifest || answer.manifest.hash !== manifest.hash) {
      throw new BundleError("The Workstation's UI changed while it was being fetched. Open it again.");
    }
    if (answer.offset !== received) {
      throw new BundleError("The Workstation answered a part of its UI that was not asked for.");
    }
    const chunk = fromBase64(answer.data);
    if (chunk.length === 0) throw new BundleError("The Workstation served less of its UI than its manifest names.");
    if (received + chunk.length > manifest.size) {
      throw new BundleError("The Workstation served more of its UI than its manifest names.");
    }
    archive.set(chunk, received);
    received += chunk.length;
    options.onProgress?.({ received, size: manifest.size });
  }
  return archive;
}

/// Base64, as `CompanionBundle.data` carries a chunk. `atob` is every
/// webview's; a chunk is a third of a megabyte, and this runs once per.
export function fromBase64(text: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    throw new BundleError("The Workstation served a part of its UI that is not base64.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/// The progress line the hub shows under "Opening…".
export function progressLine(progress: FetchProgress): string {
  const percent = progress.size === 0 ? 100 : Math.floor((progress.received / progress.size) * 100);
  return `Fetching its UI… ${percent}%`;
}
