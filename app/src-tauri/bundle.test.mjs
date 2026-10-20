import { describe, expect, it } from "vitest";

import { buildNumber, runnerOf, tauriArgs, versionOverlay } from "./bundle.mjs";

const OVERLAY = JSON.stringify(versionOverlay("42"));

/// A fake git answering the two questions buildNumber asks.
function git({ shallow = "false", count = "1234" } = {}) {
  const calls = [];
  const run = (_root, args) => {
    calls.push(args.join(" "));
    if (args[0] === "rev-parse") return shallow;
    return count;
  };
  return Object.assign(run, { calls });
}

describe("buildNumber", () => {
  it("is the commit count of the checkout", () => {
    expect(buildNumber("/repo", {}, git())).toBe("1234");
  });

  it("takes GAVIN_BUILD_NUMBER over git, without asking git", () => {
    const g = git();
    expect(buildNumber("/repo", { GAVIN_BUILD_NUMBER: " 77 " }, g)).toBe("77");
    expect(g.calls).toEqual([]);
  });

  it("refuses a GAVIN_BUILD_NUMBER that is not a positive whole number", () => {
    for (const bad of ["0", "-3", "1.2", "12a", "007"]) {
      expect(() => buildNumber("/repo", { GAVIN_BUILD_NUMBER: bad }, git())).toThrow(/positive whole number/);
    }
  });

  it("refuses to count a shallow clone", () => {
    expect(() => buildNumber("/repo", {}, git({ shallow: "true" }))).toThrow(/shallow clone/);
  });
});

describe("tauriArgs", () => {
  it("is the bundle overlay, the build number and --locked with nothing passed", () => {
    expect(tauriArgs([], "42")).toEqual([
      "build",
      "--config",
      "src-tauri/tauri.bundle.conf.json",
      "--config",
      OVERLAY,
      "--",
      "--locked",
    ]);
  });

  it("stamps the build number as the macOS bundle version", () => {
    expect(JSON.parse(OVERLAY)).toEqual({ bundle: { macOS: { bundleVersion: "42" } } });
  });

  it("puts the caller's Tauri flags after both overlays and before cargo's", () => {
    expect(tauriArgs(["--bundles", "app", "--config", "src-tauri/tauri.updater.conf.json"], "42")).toEqual([
      "build",
      "--config",
      "src-tauri/tauri.bundle.conf.json",
      "--config",
      OVERLAY,
      "--bundles",
      "app",
      "--config",
      "src-tauri/tauri.updater.conf.json",
      "--",
      "--locked",
    ]);
  });

  it("hands what follows -- to cargo, adding --locked only once", () => {
    expect(tauriArgs(["--verbose", "--", "--locked", "--offline"], "42").slice(5)).toEqual([
      "--verbose",
      "--",
      "--locked",
      "--offline",
    ]);
    expect(tauriArgs(["--", "--offline"], "42").slice(5)).toEqual(["--", "--locked", "--offline"]);
  });
});

describe("runnerOf", () => {
  it("is Tauri's --runner in each spelling", () => {
    expect(runnerOf(["--runner", "cargo-xwin", "--target", "x86_64-pc-windows-msvc"])).toBe("cargo-xwin");
    expect(runnerOf(["-r", "cargo-xwin"])).toBe("cargo-xwin");
    expect(runnerOf(["--runner=cargo-xwin"])).toBe("cargo-xwin");
  });

  it("is nothing when no runner was named, or only cargo's half names one", () => {
    expect(runnerOf(["--bundles", "app"])).toBeUndefined();
    expect(runnerOf(["--", "--runner", "x"])).toBeUndefined();
  });
});
