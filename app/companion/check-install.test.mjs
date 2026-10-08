import { describe, expect, it } from "vitest";
import { installDrift } from "./check-install.mjs";

// A lockfile v3 `packages` map, trimmed to what the check reads.
const lock = (packages) => ({ lockfileVersion: 3, packages: { "": { name: "app" }, ...packages } });

describe("what node_modules holds against what the lockfile pins", () => {
  it("is in step when every installed version is the locked one", () => {
    const installed = { "node_modules/@xterm/xterm": "6.1.0-beta.304", "node_modules/svelte": "5.1.0" };
    const drift = installDrift(
      lock({
        "node_modules/@xterm/xterm": { version: "6.1.0-beta.304" },
        "node_modules/svelte": { version: "5.1.0" },
      }),
      (path) => installed[path] ?? null
    );
    expect(drift).toEqual([]);
  });

  it("names a package installed at another version: a lockfile bumped and never installed", () => {
    // What the shared checkout held for eight days after the 6.1 bump.
    const drift = installDrift(
      lock({ "node_modules/@xterm/xterm": { version: "6.1.0-beta.304" } }),
      () => "6.0.0"
    );
    expect(drift).toEqual([{ name: "@xterm/xterm", locked: "6.1.0-beta.304", installed: "6.0.0" }]);
  });

  it("names a required package that is not installed at all", () => {
    const drift = installDrift(lock({ "node_modules/svelte": { version: "5.1.0", dev: true } }), () => null);
    expect(drift).toEqual([{ name: "svelte", locked: "5.1.0", installed: null }]);
  });

  it("does not ask for an optional package another platform needs", () => {
    const drift = installDrift(
      lock({
        "node_modules/@esbuild/linux-x64": { version: "0.25.0", optional: true },
        "node_modules/fsevents": { version: "2.3.3", devOptional: true },
      }),
      () => null
    );
    expect(drift).toEqual([]);
  });

  it("reads nested copies under their own path, and skips links and the root", () => {
    const seen = [];
    installDrift(
      lock({
        "node_modules/a/node_modules/b": { version: "1.0.0" },
        "node_modules/local": { resolved: "../local", link: true },
        "packages/local": { version: "0.0.1" },
      }),
      (path) => {
        seen.push(path);
        return "1.0.0";
      }
    );
    expect(seen).toEqual(["node_modules/a/node_modules/b"]);
  });

  it("names a nested copy by its package name", () => {
    const drift = installDrift(lock({ "node_modules/a/node_modules/@scope/b": { version: "2.0.0" } }), () => "1.0.0");
    expect(drift).toEqual([{ name: "@scope/b", locked: "2.0.0", installed: "1.0.0" }]);
  });
});
