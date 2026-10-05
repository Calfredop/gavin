// The served bundle, from the shell's side: reading the manifest, deciding
// what is trusted, fetching in chunks, and the cache -- against a
// Workstation played by a function and a store played by a map. The
// signature itself is checked by the real Companion core, in
// `core.test.ts`; here the core is a fake that records what it was asked
// to open.
import { describe, expect, it, vi } from "vitest";
import { readyBundle, type BundleStore } from "$shell/bundle/bundle";
import { fetchArchive, fromBase64, progressLine } from "$shell/bundle/fetch";
import {
  askBundle,
  BUNDLE_CHUNK_MAX,
  BUNDLE_SIZE_MAX,
  BundleError,
  COMPANION_BUNDLE_API_VERSION,
  readBundleAnswer,
  readManifest,
  type BundleManifest,
} from "$shell/bundle/manifest";
import { bundlesToKeep, LAST_BUNDLE_KEY, nativeBundleStore, rememberBundle } from "$shell/bundle/store";
import { judgeSigner, trustedKeys } from "$shell/bundle/trust";
import type { Connection } from "$shell/connection/connection";
import { CoreError, type BundleFile, type CoreModule } from "$shell/core/core";

const PUBLISHER = "aa".repeat(32);
const DEV = "bb".repeat(32);

function manifest(overrides: Partial<BundleManifest> = {}): BundleManifest {
  return {
    hash: "11".repeat(32),
    size: 10,
    signature: "22".repeat(64),
    signer: DEV,
    format: "tar",
    gavinVersion: "0.1.0",
    ...overrides,
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/// A Workstation that serves `archive` under `manifest`, answering every
/// GetCompanionBundle the way the daemon and desktop do.
function workstation(served: { manifest: BundleManifest | null; archive: Uint8Array } | "absent"): {
  connection: Connection;
  asks: Array<{ offset: number; length: number }>;
  replace(next: { manifest: BundleManifest; archive: Uint8Array }): void;
} {
  const asks: Array<{ offset: number; length: number }> = [];
  let current = served;
  const connection = {
    request: vi.fn(async (message: unknown) => {
      const m = message as { type: string; version: number; offset: number; length: number };
      expect(m.type).toBe("GetCompanionBundle");
      expect(m.version).toBe(COMPANION_BUNDLE_API_VERSION);
      asks.push({ offset: m.offset, length: m.length });
      if (current === "absent") return { type: "CompanionBundle", version: 1, state: "desktop-app-not-running" };
      const length = Math.min(m.length, BUNDLE_CHUNK_MAX);
      const slice = current.archive.subarray(m.offset, m.offset + length);
      return {
        type: "CompanionBundle",
        version: 1,
        state: "ready",
        manifest: current.manifest,
        offset: m.offset,
        data: toBase64(slice),
      };
    }),
    close: () => {},
    closed: new Promise<string>(() => {}),
    isClosed: false,
  } as unknown as Connection;
  return {
    connection,
    asks,
    replace: (next) => {
      current = next;
    },
  };
}

function mapStore(): BundleStore & { files: Map<string, BundleFile[]> } {
  const files = new Map<string, BundleFile[]>();
  return {
    files,
    installed: async (hash) => files.has(hash),
    install: async (hash, list) => {
      files.set(hash, list);
    },
    prune: async (keep) => {
      for (const hash of [...files.keys()]) if (!keep.includes(hash)) files.delete(hash);
    },
  };
}

/// A core whose `bundleOpen` accepts a bundle signed by a trusted key
/// and refuses the rest, the way the real one does by signature.
function fakeCore(): { core: () => Promise<CoreModule>; opened: Array<{ archive: Uint8Array; trustedKeys: string[] }> } {
  const opened: Array<{ archive: Uint8Array; trustedKeys: string[] }> = [];
  const core: CoreModule = {
    exchange: async () =>
      ({
        bundleOpen({ archive, manifest, trustedKeys }: { archive: Uint8Array; manifest: BundleManifest; trustedKeys: string[] }) {
          opened.push({ archive, trustedKeys });
          if (!trustedKeys.includes(manifest.signer)) {
            throw new CoreError("bundle", "the bundle was signed by a key this Companion does not trust");
          }
          if (manifest.signature.startsWith("ff")) throw new CoreError("bundle", "the bundle's signature does not verify");
          return { hash: manifest.hash, files: [{ path: "index.html", data: toBase64(archive) }] };
        },
      }) as never,
  };
  return { core: async () => core, opened };
}

describe("the bundle answer", () => {
  it("reads the manifest and the slice, and a desktop that is not running", () => {
    const m = manifest();
    expect(readBundleAnswer({ type: "CompanionBundle", version: 1, state: "ready", manifest: m, offset: 3, data: "YQ==" })).toEqual({
      state: "ready",
      manifest: m,
      offset: 3,
      data: "YQ==",
    });
    expect(readBundleAnswer({ type: "CompanionBundle", version: 1, state: "desktop-app-not-running" })).toEqual({
      state: "desktop-app-not-running",
    });
    // A desktop that carries no bundle.
    expect(readBundleAnswer({ type: "CompanionBundle", version: 1, state: "ready" })).toEqual({
      state: "ready",
      manifest: null,
      offset: 0,
      data: "",
    });
  });

  it("grows by optional fields: what it does not know is dropped", () => {
    const m = manifest();
    const read = readBundleAnswer({
      type: "CompanionBundle",
      version: 2,
      state: "ready",
      manifest: { ...m, compression: "none" },
      offset: 0,
      data: "",
      etag: "x",
    });
    expect(read).toEqual({ state: "ready", manifest: m, offset: 0, data: "" });
  });

  it("refuses what it cannot read, in words", () => {
    expect(() => readBundleAnswer({ type: "Unsupported", request_type: "GetCompanionBundle", min_version: 57 })).toThrow(/too old/);
    expect(() => readBundleAnswer({ type: "Error", message: "boom" })).toThrow(/boom/);
    expect(() => readBundleAnswer({ type: "CompanionBundle", version: 1, state: "warming-up" })).toThrow(BundleError);
    expect(() => readBundleAnswer("no")).toThrow(BundleError);
  });

  it("refuses a manifest the core would refuse, before any fetch", () => {
    expect(() => readManifest(manifest({ format: "zip" }))).toThrow(/format/);
    expect(() => readManifest(manifest({ hash: "zz" }))).toThrow(/hash/);
    expect(() => readManifest(manifest({ signer: "ab" }))).toThrow(/signer/);
    expect(() => readManifest(manifest({ signature: "ab" }))).toThrow(/signature/);
    expect(() => readManifest(manifest({ size: -1 }))).toThrow(/size/);
    expect(() => readManifest(manifest({ size: BUNDLE_SIZE_MAX + 1 }))).toThrow(/larger/);
    expect(readManifest({ ...manifest(), gavinVersion: undefined }).gavinVersion).toBe("");
  });

  it("asks with the version it reads and the slice it wants", async () => {
    const ws = workstation({ manifest: manifest({ size: 3 }), archive: new Uint8Array([1, 2, 3]) });
    const answer = await askBundle(ws.connection, 1, 2);
    expect(answer).toEqual({ state: "ready", manifest: manifest({ size: 3 }), offset: 1, data: toBase64(new Uint8Array([2, 3])) });
    expect(ws.asks).toEqual([{ offset: 1, length: 2 }]);
  });
});

describe("trust", () => {
  it("a store build trusts the publisher key alone; a debug build the dev key too", () => {
    expect(trustedKeys({ debugBuild: false, devKey: DEV, publisherKey: PUBLISHER })).toEqual([PUBLISHER]);
    expect(trustedKeys({ debugBuild: true, devKey: DEV, publisherKey: PUBLISHER })).toEqual([PUBLISHER, DEV]);
    expect(trustedKeys({ debugBuild: true, devKey: null, publisherKey: PUBLISHER })).toEqual([PUBLISHER]);
    // A dev key that is not a key is not trusted either.
    expect(trustedKeys({ debugBuild: true, devKey: "not-hex", publisherKey: PUBLISHER })).toEqual([PUBLISHER]);
  });

  it("with no publisher key pinned a store build trusts nothing, and says so", () => {
    expect(trustedKeys({ debugBuild: false, devKey: DEV, publisherKey: null })).toEqual([]);
    const verdict = judgeSigner(manifest({ signer: PUBLISHER }), []);
    expect(verdict.trusted).toBe(false);
    if (!verdict.trusted) expect(verdict.reason).toMatch(/pins no publisher key/);
  });

  it("a store build refuses a dev-key bundle; a debug build runs it", () => {
    const store = trustedKeys({ debugBuild: false, devKey: DEV, publisherKey: PUBLISHER });
    const verdict = judgeSigner(manifest({ signer: DEV }), store);
    expect(verdict.trusted).toBe(false);
    if (!verdict.trusted) expect(verdict.reason).toMatch(/does not trust/);
    expect(judgeSigner(manifest({ signer: PUBLISHER }), store)).toEqual({ trusted: true });
    const debug = trustedKeys({ debugBuild: true, devKey: DEV, publisherKey: PUBLISHER });
    expect(judgeSigner(manifest({ signer: DEV }), debug)).toEqual({ trusted: true });
  });
});

describe("the fetch", () => {
  const big = new Uint8Array(BUNDLE_CHUNK_MAX * 2 + 777).map((_, i) => i % 251);

  it("asks a chunk at a time until the size is in hand, reporting progress", async () => {
    const m = manifest({ size: big.length });
    const ws = workstation({ manifest: m, archive: big });
    const progress: string[] = [];
    const archive = await fetchArchive(ws.connection, m, { onProgress: (p) => progress.push(progressLine(p)) });
    expect(archive).toEqual(big);
    expect(ws.asks).toEqual([
      { offset: 0, length: BUNDLE_CHUNK_MAX },
      { offset: BUNDLE_CHUNK_MAX, length: BUNDLE_CHUNK_MAX },
      { offset: BUNDLE_CHUNK_MAX * 2, length: BUNDLE_CHUNK_MAX },
    ]);
    expect(progress[0]).toBe("Fetching its UI… 0%");
    expect(progress.at(-1)).toBe("Fetching its UI… 100%");
  });

  it("stops when the Workstation's bundle changes under it", async () => {
    const m = manifest({ size: big.length });
    const ws = workstation({ manifest: m, archive: big });
    const other = manifest({ hash: "33".repeat(32), size: 5 });
    const request = ws.connection.request as ReturnType<typeof vi.fn>;
    const first = request.getMockImplementation()!;
    request.mockImplementation(async (...args: unknown[]) => {
      if (ws.asks.length === 1) ws.replace({ manifest: other, archive: new Uint8Array(5) });
      return first(...args);
    });
    await expect(fetchArchive(ws.connection, m)).rejects.toThrow(/changed while it was being fetched/);
  });

  it("stops when the desktop app goes away, and refuses a short or a wrong slice", async () => {
    const m = manifest({ size: 4 });
    const absent = workstation("absent");
    await expect(fetchArchive(absent.connection, m)).rejects.toThrow(/stopped running/);

    const short = workstation({ manifest: m, archive: new Uint8Array(2) });
    await expect(fetchArchive(short.connection, m)).rejects.toThrow(/less of its UI/);

    const wrong = workstation({ manifest: m, archive: new Uint8Array(4) });
    (wrong.connection.request as ReturnType<typeof vi.fn>).mockResolvedValue({
      type: "CompanionBundle",
      version: 1,
      state: "ready",
      manifest: m,
      offset: 2,
      data: "AAAA",
    });
    await expect(fetchArchive(wrong.connection, m)).rejects.toThrow(/not asked for/);

    const long = workstation({ manifest: m, archive: new Uint8Array(4) });
    (long.connection.request as ReturnType<typeof vi.fn>).mockResolvedValue({
      type: "CompanionBundle",
      version: 1,
      state: "ready",
      manifest: m,
      offset: 0,
      data: toBase64(new Uint8Array(9)),
    });
    await expect(fetchArchive(long.connection, m)).rejects.toThrow(/more of its UI/);
  });

  it("reads base64 and refuses what is not", () => {
    expect(fromBase64("AQID")).toEqual(new Uint8Array([1, 2, 3]));
    expect(fromBase64("")).toEqual(new Uint8Array(0));
    expect(() => fromBase64("not base64!")).toThrow(BundleError);
  });
});

describe("readying a bundle", () => {
  const archive = new Uint8Array([7, 8, 9, 10]);
  const m = manifest({ size: archive.length, signer: DEV });

  it("fetches, verifies and installs a bundle the cache does not hold, then hits the cache", async () => {
    const ws = workstation({ manifest: m, archive });
    const store = mapStore();
    const { core, opened } = fakeCore();
    const said: string[] = [];
    const first = await readyBundle({ connection: ws.connection, store, core, trusted: [PUBLISHER, DEV], say: (t) => said.push(t) });
    expect(first).toEqual({ hash: m.hash, manifest: m, fetched: true });
    expect(opened).toHaveLength(1);
    expect(opened[0].archive).toEqual(archive);
    expect(opened[0].trustedKeys).toEqual([PUBLISHER, DEV]);
    expect(store.files.get(m.hash)).toEqual([{ path: "index.html", data: toBase64(archive) }]);
    expect(said[0]).toMatch(/Asking/);
    expect(said).toContain("Checking its signature…");
    expect(said.at(-1)).toBe("Installing it…");

    // An unchanged hash is a cache hit: the manifest is asked for, and
    // nothing is fetched or opened.
    ws.asks.length = 0;
    const again = await readyBundle({ connection: ws.connection, store, core, trusted: [PUBLISHER, DEV] });
    expect(again).toEqual({ hash: m.hash, manifest: m, fetched: false });
    expect(ws.asks).toEqual([{ offset: 0, length: 0 }]);
    expect(opened).toHaveLength(1);
  });

  it("a Workstation upgrade names a new hash, which is fetched", async () => {
    const ws = workstation({ manifest: m, archive });
    const store = mapStore();
    const { core } = fakeCore();
    await readyBundle({ connection: ws.connection, store, core, trusted: [DEV] });
    const upgraded = manifest({ hash: "44".repeat(32), size: 2, signer: DEV, gavinVersion: "0.2.0" });
    ws.replace({ manifest: upgraded, archive: new Uint8Array([1, 2]) });
    const next = await readyBundle({ connection: ws.connection, store, core, trusted: [DEV] });
    expect(next).toEqual({ hash: upgraded.hash, manifest: upgraded, fetched: true });
    expect([...store.files.keys()]).toEqual([m.hash, upgraded.hash]);
    // Pruning to the current bundle drops the old one.
    await store.prune([upgraded.hash]);
    expect([...store.files.keys()]).toEqual([upgraded.hash]);
  });

  it("a store build refuses a dev-key bundle before fetching a byte of it", async () => {
    const ws = workstation({ manifest: m, archive });
    const store = mapStore();
    const { core, opened } = fakeCore();
    await expect(readyBundle({ connection: ws.connection, store, core, trusted: [PUBLISHER] })).rejects.toThrow(
      /does not trust/
    );
    expect(ws.asks).toEqual([{ offset: 0, length: 0 }]);
    expect(opened).toHaveLength(0);
    expect(store.files.size).toBe(0);
  });

  it("a bundle with a bad signature is refused by the core and never installed", async () => {
    const bad = manifest({ size: archive.length, signer: DEV, signature: "ff".repeat(64) });
    const ws = workstation({ manifest: bad, archive });
    const store = mapStore();
    const { core } = fakeCore();
    await expect(readyBundle({ connection: ws.connection, store, core, trusted: [DEV] })).rejects.toThrow(
      /signature does not verify/
    );
    expect(store.files.size).toBe(0);
  });

  it("says when the desktop app is not running, and when the Workstation carries no UI", async () => {
    const store = mapStore();
    const { core } = fakeCore();
    await expect(readyBundle({ connection: workstation("absent").connection, store, core, trusted: [DEV] })).rejects.toThrow(
      /desktop app is not running/
    );
    const bare = workstation({ manifest: null, archive: new Uint8Array(0) });
    await expect(readyBundle({ connection: bare.connection, store, core, trusted: [DEV] })).rejects.toThrow(/carries no UI/);
  });
});

describe("the native store and what to keep", () => {
  it("carries the three calls to the plugin", async () => {
    const view = {
      installed: vi.fn(async ({ hash }: { hash: string }) => ({ installed: hash === "a" })),
      install: vi.fn(async () => {}),
      prune: vi.fn(async () => {}),
    };
    const store = nativeBundleStore(view);
    expect(await store.installed("a")).toBe(true);
    expect(await store.installed("b")).toBe(false);
    await store.install("b", [{ path: "index.html", data: "" }]);
    expect(view.install).toHaveBeenCalledWith({ hash: "b", files: [{ path: "index.html", data: "" }] });
    await store.prune(["b"]);
    expect(view.prune).toHaveBeenCalledWith({ keep: ["b"] });
  });

  it("keeps what each paired Workstation last served, and the current one", () => {
    const memory = new Map<string, string>();
    const m = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v) };
    rememberBundle(m, "ws-1", "h1");
    rememberBundle(m, "ws-2", "h2");
    expect(memory.get(`${LAST_BUNDLE_KEY}ws-1`)).toBe("h1");
    expect(bundlesToKeep(m, ["ws-1", "ws-2", "ws-3"], "h9").sort()).toEqual(["h1", "h2", "h9"]);
    expect(bundlesToKeep(m, ["ws-2"], "h2")).toEqual(["h2"]);
    // No storage: only the current one, and nothing throws.
    rememberBundle(null, "ws-1", "h1");
    expect(bundlesToKeep(null, ["ws-1"], "h1")).toEqual(["h1"]);
    const broken = {
      getItem: () => {
        throw new Error("no storage");
      },
      setItem: () => {
        throw new Error("no storage");
      },
    };
    rememberBundle(broken, "ws-1", "h1");
    expect(bundlesToKeep(broken, ["ws-1"], "h1")).toEqual(["h1"]);
  });
});
