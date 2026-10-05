// Getting a paired Workstation's UI ready to open (ADR 0005, companion-23):
// ask which bundle it serves, run it from the cache if that one is
// already here, and otherwise fetch it, verify it and install it.
//
// The cache is by content hash (the manifest's), so the same bundle from
// two Workstations on one version is stored once, and a Workstation
// that upgrades names a hash the cache does not hold and is fetched
// afresh. What is trusted is decided before the fetch (`trust.ts`), the
// signature is verified by the Companion core once the archive is in
// hand, and the files reach the native store only out of a bundle the
// core accepted. Nothing here touches the native side but through
// `BundleStore`, so it runs against a map in the suites.
import { fetchArchive, progressLine } from "$shell/bundle/fetch";
import { askBundle, BundleError, type BundleManifest } from "$shell/bundle/manifest";
import { judgeSigner } from "$shell/bundle/trust";
import type { Connection } from "$shell/connection/connection";
import { CoreError, type BundleFile, type CoreModule } from "$shell/core/core";

/// The native store of installed bundles, by hash.
export interface BundleStore {
  installed(hash: string): Promise<boolean>;
  install(hash: string, files: BundleFile[]): Promise<void>;
  /// Removes every installed bundle whose hash is not in `keep`.
  prune(keep: string[]): Promise<void>;
}

export interface ReadyBundleDeps {
  connection: Connection;
  store: BundleStore;
  core: () => Promise<CoreModule>;
  /// The keys a signer may be (`trustedKeys`).
  trusted: string[];
  /// What is being done, for the hub's "Opening…" line.
  say?(text: string): void;
  signal?: AbortSignal;
}

export interface ReadyBundle {
  hash: string;
  manifest: BundleManifest;
  /// Whether it was fetched now, or already installed.
  fetched: boolean;
}

/// The hash of the bundle to open, once it is installed. Rejects with a
/// `BundleError` whose message the hub shows.
export async function readyBundle(deps: ReadyBundleDeps): Promise<ReadyBundle> {
  const say = deps.say ?? (() => {});
  say("Asking which UI it serves…");
  const answer = await askBundle(deps.connection, 0, 0);
  if (answer.state !== "ready") {
    throw new BundleError("Gavin's desktop app is not running at the desk, so nothing there can serve its UI.");
  }
  const manifest = answer.manifest;
  if (!manifest) {
    throw new BundleError(
      "This Workstation's Gavin carries no UI for a phone: it was built without the Companion bundle."
    );
  }
  const verdict = judgeSigner(manifest, deps.trusted);
  if (!verdict.trusted) throw new BundleError(verdict.reason);

  if (await deps.store.installed(manifest.hash)) {
    return { hash: manifest.hash, manifest, fetched: false };
  }

  const archive = await fetchArchive(deps.connection, manifest, {
    onProgress: (progress) => say(progressLine(progress)),
    signal: deps.signal,
  });
  say("Checking its signature…");
  let opened;
  try {
    const exchange = await (await deps.core()).exchange();
    opened = exchange.bundleOpen({ archive, manifest, trustedKeys: deps.trusted });
  } catch (e) {
    if (e instanceof CoreError && e.kind === "bundle") throw new BundleError(sentence(e.message));
    throw new BundleError(`This Companion could not check the Workstation's UI: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (opened.hash !== manifest.hash) throw new BundleError("The Companion core opened a bundle other than the one asked for.");
  say("Installing it…");
  await deps.store.install(manifest.hash, opened.files);
  return { hash: manifest.hash, manifest, fetched: true };
}

function sentence(text: string): string {
  const trimmed = text.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}
