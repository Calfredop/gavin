// What stage-sidecars.mjs builds is decided by `sidecarBuild` alone, so the
// native and cross spellings are pinned here without running cargo. The
// native one must stay exactly what every macOS, Linux and Windows bundle
// has always built; the cross one is the Windows installer cut on a Mac.

import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { sidecarBuild } from "./stage-sidecars.mjs";

const base = { root: "/repo", targetDir: "/repo/target", release: true };
const manifest = join("/repo", "Cargo.toml");

describe("sidecarBuild", () => {
  it("builds natively with plain cargo when the target is the host", () => {
    for (const target of [undefined, "", "aarch64-apple-darwin"]) {
      expect(sidecarBuild({ ...base, host: "aarch64-apple-darwin", target })).toEqual({
        triple: "aarch64-apple-darwin",
        exe: "",
        command: "cargo",
        args: ["build", "--locked", "--release", "--manifest-path", manifest, "-p", "gavin-daemon", "-p", "gavin-mcp", "-p", "gavin-relay"],
        outDir: join("/repo/target", "release"),
      });
    }
  });

  it("keeps .exe on a native Windows build", () => {
    const b = sidecarBuild({ ...base, host: "x86_64-pc-windows-msvc", target: "x86_64-pc-windows-msvc" });
    expect(b.exe).toBe(".exe");
    expect(b.args).not.toContain("--target");
    expect(b.outDir).toBe(join("/repo/target", "release"));
  });

  it("cross-builds for Tauri's target through its runner, out of target/<triple>/", () => {
    expect(
      sidecarBuild({ ...base, host: "aarch64-apple-darwin", target: "x86_64-pc-windows-msvc", runner: "cargo-xwin" }),
    ).toEqual({
      triple: "x86_64-pc-windows-msvc",
      exe: ".exe",
      command: "cargo-xwin",
      args: [
        "build", "--locked", "--release", "--manifest-path", manifest,
        "--target", "x86_64-pc-windows-msvc", "-p", "gavin-daemon", "-p", "gavin-mcp", "-p", "gavin-relay",
      ],
      outDir: join("/repo/target", "x86_64-pc-windows-msvc", "release"),
    });
  });

  it("builds into debug/ without --release", () => {
    const b = sidecarBuild({ ...base, release: false, host: "aarch64-apple-darwin" });
    expect(b.args).not.toContain("--release");
    expect(b.outDir).toBe(join("/repo/target", "debug"));
  });
});
