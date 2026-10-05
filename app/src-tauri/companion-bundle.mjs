// The Companion bundle as the desktop build makes it: the archive, its
// hash and its signature (ADR 0005, companion-23). The contract is
// `crates/protocol/src/companion_bundle.rs`, which the Companion core
// verifies and unpacks with; `test-fixtures/companion-bundle/` pins this
// packer and signer to that reader and verifier.
//
// - **The archive** is a plain ustar tar of the built bundle's files:
//   paths sorted, mode 0644, owner 0, mtime 0, no directories of its own.
//   The same files pack to the same bytes here and in Rust, so a bundle
//   hashes alike wherever it was built.
// - **The signature** is Ed25519 over `"gavin-companion-bundle-v1" ||
//   sha256(archive)`. Node signs with the raw 32-byte seed wrapped in the
//   PKCS#8 shape `crypto` reads; nothing else is needed, and nothing else
//   is installed.
//
// Node's `crypto` alone: this runs in the release workflow and in every
// dev start, and a dependency here is a dependency of the desktop build.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as signBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const BUNDLE_SIGNING_DOMAIN = Buffer.from("gavin-companion-bundle-v1");
export const BUNDLE_FORMAT_TAR = "tar";

const BLOCK = 512;

/// PKCS#8 DER for an Ed25519 private key is a fixed 16-byte prefix and
/// the 32-byte seed (RFC 8410).
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
/// SubjectPublicKeyInfo DER for an Ed25519 public key: a fixed 12-byte
/// prefix and the 32-byte key.
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/// Whether `path` may name a file inside the folder a bundle is unpacked
/// into. The same rule as the Rust reader's `is_safe_path`.
export function isSafePath(path) {
  return (
    path.length > 0 &&
    Buffer.byteLength(path) <= 255 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function checksum(header) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
  return sum;
}

/// A ustar name is 100 bytes; a longer path splits at a `/` into a prefix
/// of at most 155 and a name of at most 100.
function splitName(path) {
  const bytes = Buffer.byteLength(path);
  if (bytes <= 100) return ["", path];
  for (let i = 0; i < path.length; i++) {
    if (path[i] !== "/") continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return [prefix, name];
  }
  throw new Error(`${JSON.stringify(path)} is too long for a ustar entry`);
}

/// The archive of `files` (`[{ path, data }]`), deterministic.
export function pack(files) {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const parts = [];
  for (const { path, data } of sorted) {
    if (!isSafePath(path)) throw new Error(`${JSON.stringify(path)} is not a path a bundle may hold`);
    const [prefix, name] = splitName(path);
    const header = Buffer.alloc(BLOCK);
    header.write(name, 0, "utf8");
    header.write("0000644\0", 100, "latin1");
    header.write("0000000\0", 108, "latin1");
    header.write("0000000\0", 116, "latin1");
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
    header.write("00000000000\0", 136, "latin1");
    header[156] = 0x30; // '0': a file
    header.write("ustar\0", 257, "latin1");
    header.write("00", 263, "latin1");
    header.write(prefix, 345, "utf8");
    header.write(`${checksum(header).toString(8).padStart(6, "0")}\0 `, 148, "latin1");
    parts.push(header, data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(2 * BLOCK));
  return Buffer.concat(parts);
}

/// Every file under `dir`, paths relative and `/`-separated.
export function readTree(dir) {
  const files = [];
  const walk = (folder, prefix) => {
    for (const entry of readdirSync(folder).sort()) {
      const full = join(folder, entry);
      const path = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(full).isDirectory()) walk(full, path);
      else files.push({ path, data: readFileSync(full) });
    }
  };
  walk(dir, "");
  return files;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest();
}

export function signingMessage(hash) {
  return Buffer.concat([BUNDLE_SIGNING_DOMAIN, hash]);
}

/// A fresh Ed25519 seed, hex.
export function generateSeed() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  return der.subarray(der.length - 32).toString("hex");
}

function privateKeyOf(seedHex) {
  const seed = Buffer.from(seedHex, "hex");
  if (seed.length !== 32 || seedHex.length !== 64) throw new Error("a signing seed is 32 bytes of hex");
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
}

/// The public half of a seed, hex.
export function publicKeyOf(seedHex) {
  const der = createPublicKey(privateKeyOf(seedHex)).export({ format: "der", type: "spki" });
  if (!der.subarray(0, SPKI_ED25519_PREFIX.length).equals(SPKI_ED25519_PREFIX)) {
    throw new Error("the public key is not in the shape expected");
  }
  return der.subarray(SPKI_ED25519_PREFIX.length).toString("hex");
}

/// The manifest for `archive`, signed under `seedHex`: what the desktop
/// embeds beside the archive and serves to a Device.
export function sign(archive, seedHex, gavinVersion) {
  const hash = sha256(archive);
  const signature = signBytes(null, signingMessage(hash), privateKeyOf(seedHex));
  return {
    hash: hash.toString("hex"),
    size: archive.length,
    signature: signature.toString("hex"),
    signer: publicKeyOf(seedHex),
    format: BUNDLE_FORMAT_TAR,
    gavinVersion,
  };
}
