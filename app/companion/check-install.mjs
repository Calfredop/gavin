// Refuses to build the Companion from a node_modules the lockfile does not
// describe.
//
//   node companion/check-install.mjs
//
// The bundle is built from `app/node_modules` (see the README), and
// nothing else compares that tree with `app/package-lock.json`. A checkout
// shared by many sessions is where they part: a commit bumps the lockfile,
// nobody reinstalls, and every build after it ships the old packages
// without a word. That is how the 6.1 bump of xterm.js -- the one that
// makes a swipe scroll the terminal on a phone -- never reached a phone:
// the tree kept 6.0.0, and the bundle with it, for eight days.
//
// `companion:build` (which `companion-shell:sync` and `stage-companion.mjs`
// both run) and `companion:dev` run this first.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/// Every package the lockfile pins that is installed at another version,
/// or not at all. `versionAt(path)` reads the version installed at a
/// lockfile path (`node_modules/a/node_modules/b`), or null. An optional
/// package may be absent -- it is another platform's -- and a link is not
/// a version to compare.
export function installDrift(lock, versionAt) {
  const drift = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path.startsWith("node_modules/") || entry.link || !entry.version) continue;
    const installed = versionAt(path);
    if (installed === null && (entry.optional || entry.devOptional)) continue;
    if (installed === entry.version) continue;
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    drift.push({ name, locked: entry.version, installed });
  }
  return drift;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = join(dirname(fileURLToPath(import.meta.url)), "..");
  const lock = JSON.parse(readFileSync(join(app, "package-lock.json"), "utf8"));
  const drift = installDrift(lock, (path) => {
    const manifest = join(app, path, "package.json");
    return existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")).version : null;
  });
  if (drift.length > 0) {
    console.error("check-install: app/node_modules is not what app/package-lock.json pins:");
    for (const d of drift) console.error(`  ${d.name}: installed ${d.installed ?? "nothing"}, locked ${d.locked}`);
    console.error("Run `npm install` in app/ to install what the lockfile pins, then build again.");
    process.exit(1);
  }
}
