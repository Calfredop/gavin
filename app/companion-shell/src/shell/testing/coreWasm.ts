// The Companion core as `scripts/core.mjs` built it, for the tests that
// run it for real. Read with Node's `fs`: vitest runs in Node, but the
// shell is checked without Node's types (tsconfig's `typeRoots`), so the
// import is untyped here and nowhere else.
// @ts-expect-error -- no Node types in this project, by design
import { readFileSync } from "node:fs";

export function coreWasm(): Uint8Array {
  return new Uint8Array(readFileSync(new URL("../../../static/companion-core.wasm", import.meta.url)));
}
