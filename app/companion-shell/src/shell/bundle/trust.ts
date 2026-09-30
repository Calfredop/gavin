// Which keys a bundle may be signed by (ADR 0005, "Store compliance";
// spec stories 78 and 80).
//
// - A **store build** trusts the pinned publisher key and nothing else.
//   A bundle signed by any other key -- a developer's, a compromised
//   Workstation's -- is refused, before it is fetched.
// - A **debug build** also trusts the dev key made on the developer's
//   machine (`stage-companion.mjs`), whose public half the native side
//   hands over only in a DEBUG build (`BundleView.devPublisherKey`): the
//   file is embedded in debug builds alone, and a release binary answers
//   null whatever it finds.
//
// Pure: what is trusted is decided from what the native side said, and
// nothing here reads a build flag of its own.
import type { BundleManifest } from "$shell/bundle/manifest";
import { PUBLISHER_KEY } from "$shell/bundle/publisherKey";

export interface TrustSources {
  /// Whether this is a debug build, as the native side reports it.
  debugBuild: boolean;
  /// The dev key's public half, hex, as the native side handed it over --
  /// null outside a debug build, and in one that embeds none.
  devKey: string | null;
  /// The pinned publisher key. Only a test hands in another.
  publisherKey?: string | null;
}

const HEX_64 = /^[0-9a-f]{64}$/;

/// The keys a bundle's signer may be, hex, in the order they are named.
export function trustedKeys(sources: TrustSources): string[] {
  const keys: string[] = [];
  const publisher = sources.publisherKey === undefined ? PUBLISHER_KEY : sources.publisherKey;
  if (publisher && HEX_64.test(publisher)) keys.push(publisher);
  if (sources.debugBuild && sources.devKey && HEX_64.test(sources.devKey)) keys.push(sources.devKey);
  return keys;
}

export type TrustVerdict =
  | { trusted: true }
  /// Why not, in a sentence for the hub.
  | { trusted: false; reason: string };

/// Whether the manifest's signer is a key this build trusts. Checked on
/// the manifest alone, before the archive is fetched.
export function judgeSigner(manifest: Pick<BundleManifest, "signer">, keys: string[]): TrustVerdict {
  if (keys.length === 0) {
    return {
      trusted: false,
      reason: "This Companion pins no publisher key, so it runs no Workstation's UI. A debug build trusts the dev key its native side embeds.",
    };
  }
  if (keys.includes(manifest.signer)) return { trusted: true };
  return {
    trusted: false,
    reason: `The Workstation's UI was signed by a key this Companion does not trust (${manifest.signer.slice(0, 12)}…). A store build runs only what the publisher signed.`,
  };
}
