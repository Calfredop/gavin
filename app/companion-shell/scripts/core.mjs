// Builds the Companion core for the shell: `crates/companion-wasm`, for
// `wasm32-unknown-unknown`, into `static/companion-core.wasm`, where the
// hub's build carries it into both native projects and the shell's web
// layer fetches it (`src/shell/core/core.ts`).
//
//   node companion-shell/scripts/core.mjs
//
// `companion-shell:build`, `:test` and `:dev` run it first. Cargo does the
// incremental work, so a second run with nothing changed costs a second.
// The .wasm is a build output and is not committed.
import { copyFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const shell = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(shell, "..", "..");
const target = "wasm32-unknown-unknown";
const profile = "companion-wasm";

const build = spawnSync(
  "cargo",
  ["build", "-p", "companion-wasm", "--target", target, "--profile", profile, "--locked"],
  { cwd: repo, stdio: "inherit" }
);
if (build.error) {
  console.error(`could not run cargo (${build.error.message}): the shell needs the Rust toolchain to build the Companion core`);
  process.exit(1);
}
if (build.status !== 0) {
  console.error(
    `building the Companion core for ${target} failed. If the target is missing: rustup target add ${target}`
  );
  process.exit(build.status ?? 1);
}

const out = join(shell, "static", "companion-core.wasm");
mkdirSync(dirname(out), { recursive: true });
copyFileSync(join(repo, "target", target, profile, "companion_wasm.wasm"), out);
