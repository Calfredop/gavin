// The packer and signer the desktop build runs, held to the reader and
// verifier in `crates/protocol/src/companion_bundle.rs` by the shared
// fixture: the same files must pack to the archive whose hash that
// fixture names, and the signature under the fixture's seed must be the
// one the Rust signer writes (Ed25519 is deterministic, so a byte off in
// the signing message shows up as a different signature, not a flaky
// one). The Rust suite asserts the same file from its side.

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isSafePath, pack, publicKeyOf, readTree, sha256, sign, generateSeed } from "./companion-bundle.mjs";
import { chooseKey, dataDir, devKeyPath, loadOrMakeDevKey, stage } from "./stage-companion.mjs";

const fixture = join(import.meta.dirname, "..", "..", "test-fixtures", "companion-bundle");
const expected = JSON.parse(readFileSync(join(fixture, "expected.json"), "utf8"));

describe("the packer", () => {
  it("packs the fixture to the archive the Rust reader expects", () => {
    const files = readTree(join(fixture, "files"));
    expect(files.map((f) => f.path)).toEqual(expected.files);
    const archive = pack(files);
    expect(archive.length % 512).toBe(0);
    expect(sha256(archive).toString("hex")).toBe(expected.archiveSha256);
  });

  it("is deterministic whatever the order of its input", () => {
    const files = readTree(join(fixture, "files"));
    const a = pack(files);
    const b = pack([...files].reverse());
    expect(a.equals(b)).toBe(true);
  });

  it("refuses a path a bundle may not hold", () => {
    for (const bad of ["", "/etc/passwd", "../x", "a/../b", "a//b", "./a", "a/", "a\\b"]) {
      expect(isSafePath(bad), bad).toBe(false);
      expect(() => pack([{ path: bad, data: Buffer.alloc(0) }])).toThrow();
    }
    expect(isSafePath("_app/immutable/chunks/a.js")).toBe(true);
  });

  it("splits a long path into the ustar prefix", () => {
    const path = `${"d".repeat(120)}/f.js`;
    const archive = pack([{ path, data: Buffer.from("x") }]);
    // The name field holds the tail, the prefix field the head.
    expect(archive.subarray(0, 4).toString()).toBe("f.js");
    expect(archive.subarray(345, 345 + 120).toString()).toBe("d".repeat(120));
  });
});

describe("the signer", () => {
  it("writes the signature the Rust signer writes under the same seed", () => {
    const archive = pack(readTree(join(fixture, "files")));
    expect(sign(archive, expected.seed, "fixture")).toEqual(expected.manifest);
  });

  it("derives the public key the fixture pins", () => {
    expect(publicKeyOf(expected.seed)).toBe(expected.manifest.signer);
  });

  it("makes a seed whose public key it can derive", () => {
    const seed = generateSeed();
    expect(seed).toMatch(/^[0-9a-f]{64}$/);
    expect(publicKeyOf(seed)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => publicKeyOf("abc")).toThrow(/32 bytes/);
  });
});

describe("the dev key", () => {
  it("lives under gavin's data directory, per OS", () => {
    expect(dataDir({ HOME: "/Users/x" }, "darwin")).toBe("/Users/x/Library/Application Support/gavin");
    expect(dataDir({ HOME: "/Users/x", XDG_DATA_HOME: "/xdg" }, "darwin")).toBe(
      "/Users/x/Library/Application Support/gavin"
    );
    expect(dataDir({ HOME: "/home/x" }, "linux")).toBe("/home/x/.local/share/gavin");
    expect(dataDir({ HOME: "/home/x", XDG_DATA_HOME: "/xdg" }, "linux")).toBe("/xdg/gavin");
    expect(dataDir({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }, "win32")).toBe(
      join("C:\\Users\\x\\AppData\\Local", "gavin")
    );
    expect(devKeyPath({ HOME: "/home/x", GAVIN_DEV_BUNDLE_KEY_FILE: "/k.json" }, "linux")).toBe("/k.json");
  });

  it("is made once and read back afterwards", () => {
    const path = join(mkdtempSync(join(tmpdir(), "dev-key-")), "nested", "key.json");
    const first = loadOrMakeDevKey(path);
    expect(first.made).toBe(true);
    expect(existsSync(path)).toBe(true);
    const again = loadOrMakeDevKey(path);
    expect(again.made).toBe(false);
    expect(again.seed).toBe(first.seed);
    expect(again.publicKey).toBe(publicKeyOf(first.seed));
    // A file that is not this script's is refused rather than read as a key.
    writeFileSync(path, JSON.stringify({ seed: first.seed, publicKey: "00" }));
    expect(() => loadOrMakeDevKey(path)).toThrow(/move it aside/);
  });

  it("signs with the publisher key when given one, and says so when a release falls back", () => {
    const devKey = () => ({ seed: "11".repeat(32) });
    expect(chooseKey({ release: true, env: { GAVIN_BUNDLE_SIGNING_KEY: "22".repeat(32) }, devKey })).toEqual({
      seed: "22".repeat(32),
      kind: "publisher",
    });
    expect(chooseKey({ release: false, env: {}, devKey })).toEqual({ seed: "11".repeat(32), kind: "dev" });
    const fallback = chooseKey({ release: true, env: {}, devKey });
    expect(fallback.kind).toBe("dev");
    expect(fallback.warning).toMatch(/store build .* refuse/);
  });
});

describe("staging", () => {
  it("writes the archive and a manifest that names it", () => {
    const root = mkdtempSync(join(tmpdir(), "stage-"));
    const buildDir = join(root, "build");
    mkdirSync(join(buildDir, "_app"), { recursive: true });
    writeFileSync(join(buildDir, "index.html"), "<!doctype html>");
    writeFileSync(join(buildDir, "_app", "a.js"), "1");
    const outDir = join(root, "companion");
    const { manifest, files } = stage({ buildDir, outDir, seed: expected.seed, gavinVersion: "9.9.9" });
    expect(files).toBe(2);
    const archive = readFileSync(join(outDir, "bundle.tar"));
    expect(sha256(archive).toString("hex")).toBe(manifest.hash);
    expect(manifest.size).toBe(archive.length);
    expect(manifest.gavinVersion).toBe("9.9.9");
    expect(manifest.format).toBe("tar");
    expect(JSON.parse(readFileSync(join(outDir, "bundle.json"), "utf8"))).toEqual(manifest);
    expect(existsSync(join(outDir, "bundle.tar.tmp"))).toBe(false);
  });

  it("refuses a build folder with no page", () => {
    const root = mkdtempSync(join(tmpdir(), "stage-"));
    mkdirSync(join(root, "build"));
    expect(() => stage({ buildDir: join(root, "build"), outDir: join(root, "out"), seed: expected.seed, gavinVersion: "1" })).toThrow(
      /not built/
    );
  });
});
