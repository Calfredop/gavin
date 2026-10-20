import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { transformWithEsbuild } from "vite";
import { fileURLToPath } from "node:url";
import { buildTarget } from "./vite-build-target.js";

// Vite's default build target compiled xterm into a terminal that throws
// on its first DECRQM query and never draws again (the module beside this
// file has the whole story). `vite dev` serves xterm unlowered and the suites
// never build the app, so nothing else would notice it coming back. This
// runs the part that matters: xterm through the esbuild pass a release
// runs, then the query.
//
// A node test beside the module rather than a suite under `src`: it has to
// write the compiled xterm to disk and run it, and `src` is type-checked
// without Node's types.

const HERE = dirname(fileURLToPath(import.meta.url));

/// The ESM entry (`module`), which is what Vite bundles -- `resolve` alone
/// would answer the CommonJS `main`.
const XTERM = (() => {
  const manifest = createRequire(import.meta.url).resolve("@xterm/xterm/package.json");
  return join(dirname(manifest), JSON.parse(readFileSync(manifest, "utf8")).module);
})();

/// Run beside the compiled xterm by a separate `node`, never imported
/// here: vitest evaluates a dynamically imported file outside ES-module
/// strict mode, where the stray write quietly makes a global and the bug
/// passes. A webview runs every module strict, so the probe must too.
const PROBE = `
import { Terminal } from "./xterm.mjs";
const term = new Terminal();
const replies = [];
term.onData((d) => replies.push(d));
let out;
try {
  // xterm parses on a timer, and a write's callback never runs after a
  // throw, so the parser is driven synchronously instead.
  term.write("\\x1b[?2026$p");
  term._core._writeBuffer.writeSync("");
  out = replies.join("");
} catch (e) {
  out = String(e);
}
process.stdout.write(JSON.stringify(out));
`;

/// What a terminal compiled for `target` answers to "is synchronized
/// output (2026) on?" -- or the error it throws instead.
/** @param {string | string[]} target */
async function decrqmReply(target) {
  const { code } = await transformWithEsbuild(readFileSync(XTERM, "utf8"), "xterm.mjs", {
    target,
    minify: true,
    format: "esm",
  });
  const dir = mkdtempSync(join(tmpdir(), "xterm-build-"));
  try {
    writeFileSync(join(dir, "xterm.mjs"), code);
    writeFileSync(join(dir, "probe.mjs"), PROBE);
    return JSON.parse(execFileSync(process.execPath, [join(dir, "probe.mjs")], { encoding: "utf8" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the production build target", () => {
  it("compiles xterm into a terminal that still answers a mode query", async () => {
    expect(await decrqmReply(buildTarget)).toBe("\x1b[?2026;2$y");
  });

  // The control: without it a probe that cannot fail would pass the line
  // above. If esbuild ever fixes the lowering this goes red, and Vite's
  // default is safe again -- which is news, not a regression.
  it("is not Vite's default, which breaks that query", async () => {
    const viteDefault = ["es2020", "edge88", "firefox78", "chrome87", "safari14"];
    expect(await decrqmReply(viteDefault)).toMatch(/ReferenceError/);
  });

  it("is what every config that bundles the terminal builds with", () => {
    for (const file of ["vite.config.js", "companion/vite.config.js"]) {
      expect(readFileSync(join(HERE, file), "utf8")).toMatch(/build:\s*\{\s*target:\s*buildTarget\s*\}/);
    }
  });
});
