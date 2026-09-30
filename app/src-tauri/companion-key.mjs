// The Companion bundle's publisher key (ADR 0005, companion-23).
//
//   node src-tauri/companion-key.mjs generate        a new seed and its public key
//   node src-tauri/companion-key.mjs public <seed>   the public key of a seed
//
// `generate` is run once, by a human: the seed becomes the release
// workflow's `GAVIN_BUNDLE_SIGNING_KEY` secret, and the public key is
// pinned in the shell (`app/companion-shell/src/shell/bundle/
// publisherKey.ts`). `public` is what the workflow's preflight runs to
// check that the secret it holds is the key the shell pins, before any
// platform starts building -- a release signed by another key would be a
// green build whose bundle every store install refuses.
//
// The seed is printed and never written anywhere: where it is kept is
// the human's decision, and this script must not make it for them.

import { fileURLToPath } from "node:url";
import { generateSeed, publicKeyOf } from "./companion-bundle.mjs";

function main(args) {
  const [command, seed] = args;
  if (command === "generate") {
    const fresh = generateSeed();
    console.log(`seed (GAVIN_BUNDLE_SIGNING_KEY, keep it secret): ${fresh}`);
    console.log(`public key (pin it in publisherKey.ts):          ${publicKeyOf(fresh)}`);
    return;
  }
  if (command === "public" && seed) {
    console.log(publicKeyOf(seed));
    return;
  }
  console.error("usage: companion-key.mjs generate | public <seed>");
  process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`companion-key: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
