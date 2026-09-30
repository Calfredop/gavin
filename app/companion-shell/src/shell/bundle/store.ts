// The native bundle cache, as `bundle.ts` uses it: the `BundleView`
// plugin's `installed`, `install` and `prune`, and nothing else of it.
import type { BundleStore } from "$shell/bundle/bundle";
import type { BundleViewPlugin } from "$shell/native/bundleView";

export function nativeBundleStore(view: Pick<BundleViewPlugin, "installed" | "install" | "prune">): BundleStore {
  return {
    installed: async (hash) => (await view.installed({ hash })).installed,
    install: (hash, files) => view.install({ hash, files }),
    prune: (keep) => view.prune({ keep }),
  };
}

/// The bundles worth keeping: the one each paired Workstation was last
/// seen serving. Kept in the page's storage by Workstation id, so a
/// bundle a Workstation moved off is pruned the next time one is
/// installed, and one it still serves is not.
export const LAST_BUNDLE_KEY = "gavin.shell.bundle.";

export interface BundleMemory {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function rememberBundle(memory: BundleMemory | null, workstationId: string, hash: string): void {
  try {
    memory?.setItem(`${LAST_BUNDLE_KEY}${workstationId}`, hash);
  } catch {
    // A bundle not remembered is pruned and fetched again: one download.
  }
}

/// The hashes to keep: what each of `workstationIds` last served, as
/// remembered, plus `current`.
export function bundlesToKeep(memory: BundleMemory | null, workstationIds: string[], current: string): string[] {
  const keep = new Set<string>([current]);
  for (const id of workstationIds) {
    try {
      const hash = memory?.getItem(`${LAST_BUNDLE_KEY}${id}`);
      if (hash) keep.add(hash);
    } catch {
      // Nothing remembered for this one.
    }
  }
  return [...keep];
}
